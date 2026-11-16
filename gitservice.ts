// git smart HTTP: info/refs, upload-pack (protocol v2 and v0) and receive-pack (v0),
// served straight from the in-memory store with no git binary.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitObj, ObjType, TreeEntry } from './gitobj.ts';
import { parseTree, parseCommit, hashObject, writePack, readPack } from './gitobj.ts';
import { findRepo, getObject, putObject, resolveRefish, touch } from './store.ts';
import type { Repo } from './store.ts';

// ---------------------------------------------------------------- pkt-line helpers

const FLUSH = '0000';
const DELIM = '0001';

function pkt(text: string | Buffer): Buffer {
  const payload = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  const len = payload.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

function pktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(Buffer.from(FLUSH, 'ascii'));
    else if (line === 'delim') parts.push(Buffer.from(DELIM, 'ascii'));
    else parts.push(pkt(line));
  }
  return Buffer.concat(parts);
}

interface Pkt { kind: 'data' | 'flush' | 'delim'; payload: Buffer }

function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

// ---------------------------------------------------------------- body reading

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- helpers

const AGENT = 'vella-forge/1.0';

function repoOfGitPath(path: string): { owner: string; name: string; repo: Repo } | null {
  const m = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)\.git(?:\/(.*))?$/.exec(path);
  if (!m) return null;
  const repo = findRepo(m[1], m[2]);
  if (!repo) return null;
  return { owner: m[1], name: m[2], repo };
}

// ---------------------------------------------------------------- ref advertisement (v0)

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const names = [...repo.refs.keys()];
  const order = (n: string): number => (n === 'HEAD' ? 0 : n.startsWith('refs/heads/') ? 1 : n.startsWith('refs/tags/') ? 2 : 3);
  names.sort((a, b) => (order(a) - order(b)) || (a < b ? -1 : a > b ? 1 : 0));
  return names.map((name) => ({ name, oid: repo.refs.get(name)! }));
}

function uploadPackV0Advertisement(repo: Repo): Buffer {
  const caps = 'multi_ack multi_ack_detailed side-band-64k thin-pack ofs-delta symref=HEAD:refs/heads/' + repo.defaultBranch + ' agent=' + AGENT;
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo).filter((r) => r.name !== 'HEAD');
  if (refs.length === 0) {
    parts.push(pkt(`${'0'.repeat(40)} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      const line = i === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pkt(line));
    });
  }
  parts.push(Buffer.from(FLUSH, 'ascii'));
  return Buffer.concat(parts);
}

function receivePackV0Advertisement(repo: Repo): Buffer {
  const caps = 'report-status report-status-v2 delete-refs side-band-64k quiet ofs-delta agent=' + AGENT;
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo).filter((r) => r.name !== 'HEAD');
  if (refs.length === 0) {
    parts.push(pkt(`${'0'.repeat(40)} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      const line = i === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pkt(line));
    });
  }
  parts.push(Buffer.from(FLUSH, 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- object reachability

function* walkCommits(repo: Repo, tips: string[], stopAt?: Set<string>): Generator<string> {
  const seen = new Set<string>();
  const queue = [...tips];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      yield oid;
      if (stopAt?.has(oid)) continue;
      for (const p of parseCommit(obj.data).parents) if (!seen.has(p)) queue.push(p);
    } else if (obj.type === 'tag') {
      const c = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (c) queue.push(c[1]);
    }
  }
}

/** Every object reachable from `tips`: commits (stopping at `stopAt`, which is excluded), their trees and blobs, and tag objects. */
function closureObjects(repo: Repo, tips: string[], stopAt?: Set<string>): Map<string, GitObj> {
  const out = new Map<string, GitObj>();
  const treeDone = new Set<string>();
  const addTree = (oid: string): void => {
    if (treeDone.has(oid)) return;
    treeDone.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) return;
    if (!stopAt?.has(oid)) out.set(oid, obj);
    if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) addTree(e.oid);
    }
  };
  // Tag objects named by tips (and chains of tags).
  const tagQueue = [...tips];
  const tagSeen = new Set<string>();
  while (tagQueue.length) {
    const oid = tagQueue.shift()!;
    if (tagSeen.has(oid)) continue;
    tagSeen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tag') continue;
    if (!stopAt?.has(oid)) out.set(oid, obj);
    const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
    if (m) tagQueue.push(m[1]);
  }
  for (const tip of tips) {
    for (const oid of walkCommits(repo, [tip], stopAt)) {
      if (stopAt?.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      out.set(oid, obj);
      if (obj.type === 'commit') addTree(parseCommit(obj.data).tree);
    }
  }
  return out;
}

function parentsOf(repo: Repo, oids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) out.add(p);
  }
  return out;
}

/** Compute the object set to pack for one fetch request. */
function fetchObjectSet(repo: Repo, wants: string[], haves: string[], clientShallow: string[], depth: number | null): { objects: GitObj[]; shallow: string[]; unshallow: string[] } {
  if (depth !== null) {
    // Generation walk from the wants: gen 1 = tips, gen n = parents at depth n-1.
    const shallow = new Set<string>();
    const include = new Set<string>();
    let frontier = [...new Set(wants)];
    for (let gen = 1; gen < depth; gen += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') { shallow.add(oid); continue; }
        const parents = parseCommit(obj.data).parents;
        include.add(oid);
        if (parents.length === 0) shallow.add(oid);
        else for (const p of parents) next.push(p);
      }
      frontier = [...new Set(next)];
      if (frontier.length === 0) break;
    }
    for (const oid of frontier) {
      include.add(oid);
      shallow.add(oid);
    }
    const clientShallowSet = new Set(clientShallow);
    const stopAt = parentsOf(repo, shallow);
    const send = closureObjects(repo, wants, stopAt.size ? stopAt : undefined);
    // What the client truly holds: its shallow cuts (everything up to each shallow tip), else its haves.
    const clientHas = new Set<string>();
    if (clientShallowSet.size) {
      for (const cs of clientShallowSet) {
        for (const oid of closureObjects(repo, [cs], parentsOf(repo, [cs])).keys()) clientHas.add(oid);
      }
    } else if (haves.length) {
      for (const oid of closureObjects(repo, haves).keys()) clientHas.add(oid);
    }
    const objects: GitObj[] = [];
    for (const [oid, obj] of send) if (!clientHas.has(oid)) objects.push(obj);
    const unshallow: string[] = [];
    const shallowLines: string[] = [];
    for (const oid of clientShallowSet) if (include.has(oid)) unshallow.push(oid);
    for (const oid of shallow) if (!clientShallowSet.has(oid)) shallowLines.push(oid);
    return { objects, shallow: shallowLines, unshallow };
  }
  const send = closureObjects(repo, wants);
  if (haves.length) {
    const clientHas = closureObjects(repo, haves);
    const objects: GitObj[] = [];
    for (const [oid, obj] of send) if (!clientHas.has(oid)) objects.push(obj);
    return { objects, shallow: [], unshallow: [] };
  }
  return { objects: [...send.values()], shallow: [], unshallow: [] };
}

// ---------------------------------------------------------------- upload-pack v2

function lsRefsArgsOf(body: Buffer): { args: Set<string>; prefixes: string[] } {
  const pkts = decodePktLines(body);
  const args = new Set<string>();
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const p of pkts) {
    if (p.kind === 'delim') { pastDelim = true; continue; }
    if (p.kind !== 'data' || !pastDelim) continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line !== '') args.add(line);
  }
  return { args, prefixes };
}

function lsRefsV2(repo: Repo, body: Buffer): Buffer {
  const { args, prefixes } = lsRefsArgsOf(body);
  const wantPeel = args.has('peel');
  const wantSymrefs = args.has('symrefs');
  const wantUnborn = args.has('unborn');
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: Array<string | 'flush'> = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (keep('HEAD')) {
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (wantSymrefs) line += ` symref-target:${headTarget}`;
      lines.push(line + '\n');
    } else if (wantUnborn) {
      let line = `unborn HEAD`;
      if (wantSymrefs) line += ` symref-target:${headTarget}`;
      lines.push(line + '\n');
    }
  }
  for (const { name, oid } of sortedRefs(repo)) {
    if (name === 'HEAD' || !keep(name)) continue;
    let line = `${oid} ${name}`;
    if (wantPeel) {
      const obj = repo.objects.get(oid);
      let peeled = oid;
      if (obj?.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
        if (m) peeled = m[1];
      }
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(line + '\n');
  }
  lines.push('flush');
  return pktLines(lines);
}

function fetchV2(repo: Repo, body: Buffer): Buffer {
  const pkts = decodePktLines(body);
  const args = new Set<string>();
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  let pastDelim = false;
  for (const p of pkts) {
    if (p.kind === 'delim') { pastDelim = true; continue; }
    if (p.kind === 'flush') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) { args.add(line); continue; }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'want') wants.push(value);
    else if (key === 'have') haves.push(value);
    else if (key === 'shallow') clientShallow.push(value);
    else if (key === 'deepen') depth = parseInt(value, 10);
    else if (key === 'done') done = true;
  }
  if (wants.length === 0) return Buffer.from(FLUSH, 'ascii');
  const set = fetchObjectSet(repo, wants, haves, clientShallow, depth);
  const sections: Buffer[] = [];
  if (set.shallow.length || set.unshallow.length) {
    sections.push(pkt('shallow-info\n'));
    for (const oid of set.shallow) sections.push(pkt(`shallow ${oid}\n`));
    for (const oid of set.unshallow) sections.push(pkt(`unshallow ${oid}\n`));
    sections.push(Buffer.from(FLUSH, 'ascii'));
  }
  sections.push(pkt('packfile\n'));
  const pack = writePack(set.objects);
  const MAX = 65515;
  let off = 0;
  while (off < pack.length) {
    const chunk = pack.subarray(off, Math.min(off + MAX, pack.length));
    sections.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    off += chunk.length;
  }
  sections.push(Buffer.from(FLUSH, 'ascii'));
  sections.push(Buffer.from(FLUSH, 'ascii'));
  void done;
  void args;
  return Buffer.concat(sections);
}

function dispatchV2(repo: Repo, body: Buffer): Buffer {
  const pkts = decodePktLines(body);
  let command = '';
  for (const p of pkts) {
    if (p.kind !== 'data') break;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) {
      command = line.slice('command='.length);
      break;
    }
  }
  if (command === 'ls-refs') return lsRefsV2(repo, body);
  return fetchV2(repo, body);
}

// ---------------------------------------------------------------- upload-pack v0

function v0UploadPack(repo: Repo, body: Buffer): Buffer {
  const pkts = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let shallowSeen: string[] = [];
  for (const p of pkts) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'want') wants.push(value);
    else if (key === 'have') haves.push(value);
    else if (key === 'shallow') shallowSeen.push(value);
  }
  if (wants.length === 0) return Buffer.from('0008NAK\n', 'ascii');
  const set = fetchObjectSet(repo, wants, haves, shallowSeen, null);
  const parts: Buffer[] = [];
  for (const oid of set.shallow) parts.push(pkt(`shallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  const pack = writePack(set.objects);
  const MAX = 65515;
  let off = 0;
  if (pack.length === 0) parts.push(pkt(Buffer.concat([Buffer.from([1])])));
  while (off < pack.length) {
    const chunk = pack.subarray(off, Math.min(off + MAX, pack.length));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    off += chunk.length;
  }
  parts.push(Buffer.from(FLUSH, 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand { oldOid: string; newOid: string; ref: string }

function receivePack(repo: Repo, body: Buffer): Buffer {
  const flushIdx = (() => {
    // commands end at the first flush-pkt
    let i = 0;
    while (i + 4 <= body.length) {
      const len = parseInt(body.subarray(i, i + 4).toString('ascii'), 16);
      if (len === 0) return i;
      if (len < 4 || i + len > body.length) break;
      i += len;
    }
    return body.length;
  })();
  const commandBytes = body.subarray(0, flushIdx);
  const packBytes = body.subarray(flushIdx + 4);
  const pkts = decodePktLines(commandBytes);
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  for (const p of pkts) {
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  // unpack
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length) {
    try {
      const parsed = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of parsed.objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  } else if (commands.some((c) => c.newOid !== '0'.repeat(40))) {
    unpackOk = false;
    unpackDetail = 'unpacker error: expected a pack';
  }
  const report: string[] = [];
  if (unpackOk) {
    report.push(`unpack ${unpackDetail}\n`);
    for (const cmd of commands) {
      const zero = '0'.repeat(40);
      if (cmd.newOid === zero) {
        // delete
        if (repo.refs.has(cmd.ref) || cmd.ref.startsWith('refs/')) {
          const existing = repo.refs.get(cmd.ref);
          if (existing !== undefined && existing !== cmd.oldOid && cmd.oldOid !== zero) {
            report.push(`ng ${cmd.ref} fetch first\n`);
            continue;
          }
          repo.refs.delete(cmd.ref);
          report.push(`ok ${cmd.ref}\n`);
        } else {
          report.push(`ng ${cmd.ref} no such ref\n`);
        }
        continue;
      }
      // object must exist
      const obj = repo.objects.get(cmd.newOid);
      if (!obj) {
        report.push(`ng ${cmd.ref} missing objects\n`);
        continue;
      }
      const existing = repo.refs.get(cmd.ref);
      if (existing !== undefined && existing !== cmd.oldOid && cmd.oldOid !== zero) {
        report.push(`ng ${cmd.ref} fetch first\n`);
        continue;
      }
      if (existing === undefined && cmd.oldOid !== zero) {
        report.push(`ng ${cmd.ref} no such ref\n`);
        continue;
      }
      if (existing !== undefined && existing !== zero) {
        // fast-forward check
        let ff = false;
        for (const anc of walkCommits(repo, [cmd.newOid])) {
          if (anc === existing) { ff = true; break; }
        }
        if (!ff) {
          report.push(`ng ${cmd.ref} non-fast-forward\n`);
          continue;
        }
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}\n`);
    }
  } else {
    report.push(`unpack ${unpackDetail}\n`);
  }
  touch(repo);
  const reportText = report.join('');
  const useSideband = capabilities.includes('side-band-64k');
  const inner = pktLines(reportText.split('\n').filter((l) => l !== '').map((l) => `${l}\n`));
  if (!useSideband) return inner;
  const parts: Buffer[] = [];
  const MAX = 65515;
  let off = 0;
  while (off < inner.length) {
    const chunk = inner.subarray(off, Math.min(off + MAX, inner.length));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    off += chunk.length;
  }
  parts.push(Buffer.from(FLUSH, 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- request handling

export function readGitProtocolVersion(req: IncomingMessage): 2 | 0 {
  const header = (req.headers['git-protocol'] ?? '') as string;
  return /version=2/i.test(header) ? 2 : 0;
}

export function gitResponse(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<boolean> {
  return handleGit(req, res, path, query);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<boolean> {
  const match = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!match) return false;
  const [, owner, name, servicePath] = match;
  const repo = findRepo(owner, name);
  const version = readGitProtocolVersion(req);
  if (servicePath === 'info/refs') {
    const service = query.get('service');
    if (!repo) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('repository not found');
      return true;
    }
    if (service === 'git-upload-pack') {
      if (version === 2) {
        const caps = [
          `agent=${AGENT}`,
          'ls-refs=unborn',
          'fetch=shallow',
          'object-format=sha1',
        ];
        const body = Buffer.concat([
          pkt('# service=git-upload-pack\n'),
          Buffer.from(FLUSH, 'ascii'),
          pkt('version 2\n'),
          ...caps.map((c) => pkt(`${c}\n`)),
          Buffer.from(FLUSH, 'ascii'),
        ]);
        res.writeHead(200, {
          'content-type': 'application/x-git-upload-pack-advertisement',
          'cache-control': 'no-cache',
        });
        res.end(body);
        return true;
      }
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'cache-control': 'no-cache',
      });
      res.end(Buffer.concat([pkt('# service=git-upload-pack\n'), Buffer.from(FLUSH, 'ascii'), uploadPackV0Advertisement(repo)]));
      return true;
    }
    if (service === 'git-receive-pack') {
      res.writeHead(200, {
        'content-type': 'application/x-git-receive-pack-advertisement',
        'cache-control': 'no-cache',
      });
      res.end(Buffer.concat([pkt('# service=git-receive-pack\n'), Buffer.from(FLUSH, 'ascii'), receivePackV0Advertisement(repo)]));
      return true;
    }
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('dumb http protocol is not supported');
    return true;
  }
  const service = servicePath; // git-upload-pack | git-receive-pack
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('repository not found');
    return true;
  }
  const body = await readBody(req);
  const contentType = `application/x-${service}-result`;
  if (service === 'git-upload-pack') {
    const out = version === 2 ? dispatchV2(repo, body) : v0UploadPack(repo, body);
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
    res.end(out);
    return true;
  }
  if (service === 'git-receive-pack') {
    const out = receivePack(repo, body);
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
    res.end(out);
    return true;
  }
  return false;
}

// Tree/commit helpers shared with the REST layer.
export function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

export { decodePktLines, pkt, pktLines, parseTree, hashObject };
export type { TreeEntry, ObjType };
