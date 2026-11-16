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
  const head = Buffer.from(payload.length + 4 >= 65536 ? [0xff, 0xff, 0xff, 0xff] : [0, 0, 0, 0]);
  head.writeUInt16BE(payload.length + 4, 0);
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

function* walkCommits(repo: Repo, tips: string[]): Generator<string> {
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
      for (const p of parseCommit(obj.data).parents) if (!seen.has(p)) queue.push(p);
    } else if (obj.type === 'tag') {
      const c = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (c) queue.push(c[1]);
    }
  }
}

/** Every object reachable from `tips` (commits, their trees and blobs, annotated tags). */
function reachableObjects(repo: Repo, tips: string[], stopAt?: Set<string>): GitObj[] {
  const out = new Map<string, GitObj>();
  const treeDone = new Set<string>();
  const addTree = (oid: string): void => {
    if (treeDone.has(oid)) return;
    treeDone.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) return;
    out.set(oid, obj);
    if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) addTree(e.oid);
    }
  };
  for (const tip of tips) {
    for (const oid of walkCommits(repo, [tip])) {
      if (stopAt?.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      out.set(oid, obj);
      if (obj.type === 'commit') addTree(parseCommit(obj.data).tree);
      if (obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
        if (m) {
          const tagged = repo.objects.get(m[1]);
          if (tagged) out.set(m[1], tagged);
        }
      }
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- upload-pack v2

function lsRefsV2(repo: Repo, args: Set<string>, prefixes: string[]): Buffer {
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

/** Compute the shallow boundary for wants at `depth` (1 = tips only). */
function shallowBoundary(repo: Repo, tips: string[], depth: number): { shallow: Set<string>; unshallow: Set<string>; include: Set<string> } {
  const shallow = new Set<string>();
  const include = new Set<string>();
  let frontier = [...new Set(tips)];
  for (let gen = 1; gen < depth; gen += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length === 0) shallow.add(oid);
      else {
        include.add(oid);
        for (const p of parents) next.push(p);
      }
    }
    frontier = [...new Set(next)];
    if (frontier.length === 0) break;
  }
  for (const oid of frontier) {
    include.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) shallow.add(oid);
    else shallow.add(oid);
  }
  return { shallow, unshallow: new Set<string>(), include };
}

function fetchV2(repo: Repo, body: Buffer): Buffer {
  const pkts = decodePktLines(body);
  const lines: string[] = pkts.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  const args = new Set<string>();
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  let pastDelim = false;
  for (const line of lines) {
    if (line === 'delim') { pastDelim = true; continue; }
    if (line === 'flush') continue;
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

  // Object set: tips minus history the client already has (haves/shallow boundaries).
  let objects: GitObj[];
  let shallowLines: string[] = [];
  if (depth !== null) {
    const boundary = shallowBoundary(repo, wants, depth);
    const stopAt = new Set([...boundary.shallow]);
    for (const oid of boundary.shallow) {
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) stopAt.add(p);
      }
    }
    objects = reachableObjects(repo, wants, stopAt);
    shallowLines = [...boundary.shallow].map((s) => `shallow ${s}\n`);
    void clientShallow;
    void haves;
  } else {
    const stopAt = new Set<string>(haves);
    objects = reachableObjects(repo, wants, haves.length ? stopAt : undefined);
  }
  const sections: Buffer[] = [];
  if (shallowLines.length) {
    sections.push(pkt('shallow-info\n'));
    for (const l of shallowLines) sections.push(pkt(l));
    sections.push(Buffer.from(FLUSH, 'ascii'));
  }
  sections.push(pkt('packfile\n'));
  const pack = writePack(objects);
  const MAX = 65519;
  let off = 0;
  while (off < pack.length) {
    const chunk = pack.subarray(off, Math.min(off + MAX, pack.length));
    sections.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    off += chunk.length;
  }
  sections.push(Buffer.from(FLUSH, 'ascii'));
  sections.push(Buffer.from(FLUSH, 'ascii'));
  return Buffer.concat(sections);
}

// ---------------------------------------------------------------- upload-pack v0

function v0UploadPack(repo: Repo, body: Buffer): Buffer {
  const pkts = decodePktLines(body);
  const lines = pkts.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  const wants: string[] = [];
  const haves: string[] = [];
  let sawFlush = false;
  for (const line of lines) {
    if (line === '') { sawFlush = true; continue; }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'want') wants.push(value);
    else if (key === 'have') haves.push(value);
    else if (key === 'done') sawFlush = true;
  }
  if (wants.length === 0) return Buffer.from('0008NAK\n', 'ascii');
  const stopAt = new Set(haves);
  const objects = reachableObjects(repo, wants, haves.length ? stopAt : undefined);
  const parts: Buffer[] = [];
  const caps = 'side-band-64k agent=' + AGENT;
  parts.push(pkt(`NAK\n`));
  const pack = writePack(objects);
  const MAX = 65519;
  let off = 0;
  if (pack.length === 0) {
    parts.push(pkt(Buffer.concat([Buffer.from([1])])));
  }
  while (off < pack.length) {
    const chunk = pack.subarray(off, Math.min(off + MAX, pack.length));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    off += chunk.length;
  }
  parts.push(Buffer.from(FLUSH, 'ascii'));
  void caps;
  void sawFlush;
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
  let unpackDetail = 'unpack ok';
  if (packBytes.length) {
    try {
      const parsed = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of parsed.objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = `unpack failed: ${err instanceof Error ? err.message : String(err)}`;
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
  const MAX = 65519;
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
    const out = version === 2 ? fetchV2(repo, body) : v0UploadPack(repo, body);
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
