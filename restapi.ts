// The GitHub REST v3 surface under /api/v3.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseTree, parseCommit, buildTree, buildCommit, buildTag, hashObject } from './gitobj.ts';
import type { TreeEntry, ObjType, GitObj } from './gitobj.ts';
import {
  REPOS, VIEWER, USERS, STRANGER_LOGIN,
  findRepo, repoFullName, createRepo, listRepos,
  putObject, getObject, resolveRefish, headRef, defaultBranchSha, touch, stamp,
  addLabel, addIssue, addPull, restUser, restRepo, restLabel, restIssue, restPull, restComment,
  newCommentId, userForToken,
} from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';

const AUTHOR = `${VIEWER.name} <${VIEWER.email}>`;
// A fixed epoch-based timestamp generator keeps commits deterministic.
let commitTick = 0;
function commitTimestamp(): string {
  commitTick += 1;
  const sec = 1_735_689_600 + commitTick;
  return `${sec} +0000`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- helpers

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `REQ-${String(status)}-${Math.abs(hashString(text))}`,
    ...extraHeaders,
  });
  res.end(text);
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

let currentOrigin = 'http://localhost';

function linkHeader(basePath: string, query: URLSearchParams, page: number, perPage: number, total: number): Record<string, string> {
  const last = Math.max(1, Math.ceil(total / perPage));
  const mk = (p: number, rel: string): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${currentOrigin}${basePath}${q.toString() ? `?${q.toString()}` : ''}>; rel="${rel}"`;
  };
  const parts: string[] = [];
  if (page > 1) parts.push(mk(page - 1, 'prev'));
  if (page < last) parts.push(mk(page + 1, 'next'));
  parts.push(mk(last, 'last'));
  parts.push(mk(1, 'first'));
  return parts.length ? { link: parts.join(', ') } : {};
}

// ---------------------------------------------------------------- git plumbing over the store

function commitTreeState(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const flat = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      const isTree = e.mode === '40000' || e.mode === '040000';
      if (isTree) walk(e.oid, path);
      else flat.set(path, { oid: e.oid, mode: e.mode === '100755' ? '100755' : '100644' });
    }
  };
  walk(treeOid, '');
  return flat;
}

function buildTreeFromFlat(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  // Build nested trees bottom-up.
  interface Node { children: Map<string, Node>; entry?: { oid: string; mode: string } }
  const root: Node = { children: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.children.get(parts[i]);
      if (!child) {
        child = { children: new Map() };
        node.children.set(parts[i], child);
      }
      node = child;
    }
    node.children.set(parts[parts.length - 1], { children: new Map(), entry });
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, child] of [...node.children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (child.entry) {
        entries.push({ mode: child.entry.mode, name, oid: child.entry.oid });
      } else {
        entries.push({ mode: '40000', name, oid: write(child) });
      }
    }
    const tree = buildTree(entries);
    repo.objects.set(tree.oid, { type: 'tree', data: tree.data });
    return tree.oid;
  };
  return write(root);
}

export function createTreeCommit(
  repo: Repo,
  baseTreeOid: string | null,
  changes: ReadonlyMap<string, { content: Buffer | null; mode?: string }>,
  message: string,
  parents: string[],
): { treeOid: string; commitOid: string } {
  const flat = baseTreeOid ? commitTreeState(repo, baseTreeOid) : new Map<string, { oid: string; mode: string }>();
  for (const [path, change] of changes) {
    if (change.content === null) flat.delete(path);
    else {
      const oid = putObject(repo, 'blob', change.content);
      flat.set(path, { oid, mode: change.mode ?? '100644' });
    }
  }
  const treeOid = buildTreeFromFlat(repo, flat);
  const commit = buildCommit({ tree: treeOid, parents, author: `${AUTHOR} ${commitTimestamp()}`, committer: `${AUTHOR} ${commitTimestamp()}`, message });
  repo.objects.set(commit.oid, { type: 'commit', data: commit.data });
  return { treeOid, commitOid: commit.oid };
}

function commitFilesChanged(repo: Repo, commitOid: string): { added: string[]; removed: string[]; changed: string[] } {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return { added: [], removed: [], changed: [] };
  const info = parseCommit(commit.data);
  const tree = info.tree;
  const parentTrees: Map<string, { oid: string; mode: string }>[] = info.parents.map((p) => {
    const po = repo.objects.get(p);
    if (!po || po.type !== 'commit') return new Map();
    return commitTreeState(repo, parseCommit(po.data).tree);
  });
  const base = parentTrees[0] ?? new Map<string, { oid: string; mode: string }>();
  const current = commitTreeState(repo, tree);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const path of current.keys()) if (!base.has(path)) added.push(path);
  for (const path of base.keys()) {
    if (!current.has(path)) removed.push(path);
    else if (base.get(path)!.oid !== current.get(path)!.oid) changed.push(path);
  }
  return { added, removed, changed };
}

function diffFiles(repo: Repo, baseOid: string, headOid: string): PullFile[] {
  const baseTree = treeOf(repo, baseOid);
  const headTree = treeOf(repo, headOid);
  const base = baseTree ? commitTreeState(repo, baseTree) : new Map();
  const head = headTree ? commitTreeState(repo, headTree) : new Map();
  const files: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b?.oid === h?.oid) continue;
    const bText = b ? (repo.objects.get(b.oid)?.data ?? Buffer.alloc(0)) : null;
    const hText = h ? (repo.objects.get(h.oid)?.data ?? Buffer.alloc(0)) : null;
    const bLines = bText ? bText.toString('utf8').split('\n').length : 0;
    const hLines = hText ? hText.toString('utf8').split('\n').length : 0;
    const status = !b ? 'added' : !h ? 'removed' : 'modified';
    files.push({
      filename: path,
      status,
      additions: status === 'removed' ? 0 : Math.max(0, hLines - (bLines && status === 'modified' ? bLines : 0)),
      deletions: status === 'added' ? 0 : Math.max(0, bLines - hLines),
      changes: Math.abs(hLines - bLines) || 1,
      sha: h?.oid ?? b!.oid,
      blobUrl: `https://example.invalid/${repoFullName(repo)}/blob/${headOid}/${path}`,
      rawUrl: `https://example.invalid/${repoFullName(repo)}/raw/${headOid}/${path}`,
      contentsUrl: `/api/v3/repos/${repoFullName(repo)}/contents/${path}?ref=${headOid}`,
    });
  }
  return files;
}

function treeOf(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'commit') return parseCommit(obj.data).tree;
  if (obj.type === 'tag') {
    const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
    if (m) return treeOf(repo, m[1]);
  }
  if (obj.type === 'tree') return oid;
  return null;
}

function commonAncestor(repo: Repo, a: string, b: string): string | null {
  const ancestorsOf = (oid: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [oid];
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return seen;
  };
  const aSet = ancestorsOf(a);
  const queue = [b];
  while (queue.length) {
    const cur = queue.shift()!;
    if (aSet.has(cur)) return cur;
    const obj = repo.objects.get(cur);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

// ---------------------------------------------------------------- contents helpers

function contentEntry(repo: Repo, ref: string, path: string): { type: 'file'; oid: string; data: Buffer } | { type: 'dir'; oid: string } | null {
  const sha = resolveRefish(repo, ref);
  if (sha === null) return null;
  const treeOid = treeOf(repo, sha);
  if (treeOid === null) return null;
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  let cur = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data);
    const name = parts[i];
    const entry = entries.find((e) => e.name === name);
    if (!entry) return null;
    const last = i === parts.length - 1;
    const isTree = entry.mode === '40000' || entry.mode === '040000';
    if (last) {
      if (isTree) return { type: 'dir', oid: entry.oid };
      const blob = repo.objects.get(entry.oid);
      if (!blob) return null;
      return { type: 'file', oid: entry.oid, data: blob.data };
    }
    if (!isTree) return null;
    cur = entry.oid;
  }
  return null;
}

// ---------------------------------------------------------------- the router

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  authed: boolean;
}

export async function handleRest(ctx: Ctx): Promise<boolean> {
  const { req, res, method, path } = ctx;
  const host = ctx.req.headers.host ?? 'localhost';
  currentOrigin = `http://${host}`;
  if (!path.startsWith('/api/v3')) return false;
  const sub = path.slice('/api/v3'.length) || '/';
  const route = sub.length > 1 ? sub.replace(/\/+$/, '') : '/';

  // Authentication: every route requires the bearer token.
  if (!ctx.authed) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }

  // ---- root & meta
  if (method === 'GET' && (route === '/' || route === '')) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_url: '/api/v3/repos/{owner}/{repo}/issues/{number}',
      pulls_url: '/api/v3/repos/{owner}/{repo}/pulls/{number}',
      meta_url: '/api/v3/meta',
    }, { 'x-oauth-scopes': 'repo, read:org, gist, workflow' });
    return true;
  }
  if (method === 'GET' && route === '/meta') {
    sendJson(res, 200, {
      installed_version: '3.4.0-vella-forge',
      verifiable_password_authentication: false,
      github_services: [],
    });
    return true;
  }
  if (method === 'GET' && route === '/user') {
    sendJson(res, 200, restUser(VIEWER));
    return true;
  }

  // ---- user repos
  if (route === '/user/repos') {
    if (method === 'GET') {
      const perPage = clampInt(ctx.query.get('per_page'), 1, 100, 30);
      const page = clampInt(ctx.query.get('page'), 1, 10_000, 1);
      const all = listRepos().filter((r) => r.owner === VIEWER.login);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      sendJson(res, 200, slice.map(restRepo), linkHeader('/api/v3/user/repos', ctx.query, page, perPage, all.length));
      return true;
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
      const name = typeof parsed.body.name === 'string' ? parsed.body.name : '';
      if (name === '') return sendError(res, 422, 'Validation Failed: name is required'), true;
      const created = createRepo({
        name,
        description: typeof parsed.body.description === 'string' ? parsed.body.description : null,
        isPrivate: parsed.body.private === true,
        defaultBranch: typeof parsed.body.default_branch === 'string' ? parsed.body.default_branch : 'main',
      });
      if ('error' in created) return sendError(res, 422, created.error), true;
      sendJson(res, 201, restRepo(created));
      return true;
    }
  }

  // ---- repos/{owner}/{repo}/...
  const repoMatch = /^\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\/(.*))?$/.exec(route);
  if (repoMatch) {
    const [, owner, name, tailRaw] = repoMatch;
    const repo = findRepo(owner, name);
    const tail = tailRaw ?? '';
    if (!repo || repo.owner !== VIEWER.login) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    return await handleRepoRoutes(ctx, repo, tail);
  }

  sendError(res, 404, 'Not Found');
  return true;
}

function clampInt(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null || value === '') return fallback;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function handleRepoRoutes(ctx: Ctx, repo: Repo, tail: string): Promise<boolean> {
  const { req, res, method } = ctx;
  const base = `/api/v3/repos/${repoFullName(repo)}`;

  // repository itself
  if (tail === '') {
    if (method === 'GET') { sendJson(res, 200, restRepo(repo)); return true; }
    if (method === 'PATCH') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
      if (typeof parsed.body.description === 'string' || parsed.body.description === null) {
        repo.description = parsed.body.description as string | null;
      }
      if (typeof parsed.body.name === 'string' && parsed.body.name !== '' && parsed.body.name !== repo.name) {
        REPOS.delete(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`);
        repo.name = parsed.body.name;
        REPOS.set(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`, repo);
      }
      if (typeof parsed.body.default_branch === 'string' && parsed.body.default_branch !== '') {
        repo.defaultBranch = parsed.body.default_branch;
      }
      if (typeof parsed.body.private === 'boolean') repo.isPrivate = parsed.body.private;
      touch(repo);
      sendJson(res, 200, restRepo(repo));
      return true;
    }
    if (method === 'DELETE') {
      REPOS.delete(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`);
      res.writeHead(204);
      res.end();
      return true;
    }
  }

  // branches
  if (tail === 'branches' && method === 'GET') {
    const branches = sortedRefs(repo).filter((r) => r.name.startsWith('refs/heads/'));
    sendJson(res, 200, branches.map((r) => ({
      name: r.name.slice('refs/heads/'.length),
      commit: { sha: r.oid, url: `${base}/commits/${r.oid}` },
      protected: false,
    })));
    return true;
  }
  const branchMatch = /^branches\/(.+)$/.exec(tail);
  if (branchMatch && method === 'GET') {
    const ref = `refs/heads/${branchMatch[1]}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return sendError(res, 404, 'Branch not found'), true;
    sendJson(res, 200, { name: branchMatch[1], commit: { sha, url: `${base}/commits/${sha}` }, protected: false });
    return true;
  }

  // commits
  if (tail === 'commits' && method === 'GET') {
    const ref = ctx.query.get('sha') ?? headRef(repo);
    const sha = resolveRefish(repo, ref);
    if (sha === null) return sendError(res, 404, 'No commits found'), true;
    const list: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const queue = [sha];
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      const info = parseCommit(obj.data);
      list.push(commitShape(repo, cur, info));
      queue.push(...info.parents);
    }
    sendJson(res, 200, list);
    return true;
  }
  const commitMatch = /^commits\/([0-9a-f]{40})$/.exec(tail);
  if (commitMatch && method === 'GET') {
    const obj = repo.objects.get(commitMatch[1]);
    if (!obj || obj.type !== 'commit') return sendError(res, 404, 'No commit found'), true;
    sendJson(res, 200, commitShape(repo, commitMatch[1], parseCommit(obj.data)));
    return true;
  }

  // git refs
  if (tail === 'git/refs' && method === 'POST') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
    const refName = typeof parsed.body.ref === 'string' ? parsed.body.ref : '';
    const sha = typeof parsed.body.sha === 'string' ? parsed.body.sha : '';
    if (!refName.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
      return sendError(res, 422, 'Validation Failed: ref and sha are required'), true;
    }
    if (repo.refs.has(refName)) return sendError(res, 422, 'Reference already exists'), true;
    if (!repo.objects.has(sha)) return sendError(res, 422, 'Object does not exist'), true;
    repo.refs.set(refName, sha);
    touch(repo);
    sendJson(res, 201, { ref: refName, node_id: `REF_${refName.length}`, url: `${base}/git/${refName}`, object: { sha, type: 'commit', url: `${base}/git/commits/${sha}` } });
    return true;
  }
  if (tail === 'git/refs' && method === 'GET') {
    const all = sortedRefs(repo);
    sendJson(res, 200, all.map((r) => ({ ref: r.name, node_id: `REF_${r.name.length}`, url: `${base}/git/${r.name}`, object: { sha: r.oid, type: 'commit', url: `${base}/git/commits/${r.oid}` } })));
    return true;
  }
  const refMatch = /^git\/refs\/(.+)$/.exec(tail);
  if (refMatch) {
    const refName = refMatch[1].replace(/\/+$/, '');
    const sha = repo.refs.get(refName);
    if (sha === undefined) return sendError(res, 404, 'Reference does not exist'), true;
    if (method === 'GET') {
      sendJson(res, 200, { ref: refName, node_id: `REF_${refName.length}`, url: `${base}/git/${refName}`, object: { sha, type: 'commit', url: `${base}/git/commits/${sha}` } });
      return true;
    }
    if (method === 'PATCH') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
      if (typeof parsed.body.sha === 'string' && /^[0-9a-f]{40}$/.test(parsed.body.sha) && repo.objects.has(parsed.body.sha)) {
        repo.refs.set(refName, parsed.body.sha);
        sendJson(res, 200, { ref: refName, object: { sha: parsed.body.sha, type: 'commit' } });
        return true;
      }
      return sendError(res, 422, 'Validation Failed'), true;
    }
    if (method === 'DELETE') {
      repo.refs.delete(refName);
      res.writeHead(204);
      res.end();
      return true;
    }
  }

  // git tags (annotated tag creation used by the git checks)
  if (tail === 'git/tags' && method === 'POST') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
    const obj = typeof parsed.body.object === 'string' ? parsed.body.object : '';
    const type = typeof parsed.body.type === 'string' ? parsed.body.type : '';
    const tag = typeof parsed.body.tag === 'string' ? parsed.body.tag : '';
    const tagger = typeof parsed.body.tagger === 'object' && parsed.body.tagger !== null ? parsed.body.tagger as Record<string, unknown> : {};
    const message = typeof parsed.body.message === 'string' ? parsed.body.message : '';
    if (!/^[0-9a-f]{40}$/.test(obj) || !repo.objects.has(obj) || tag === '') return sendError(res, 422, 'Validation Failed'), true;
    const t = buildTag({
      object: obj,
      type: (['commit', 'tree', 'blob', 'tag'] as ObjType[]).includes(type as ObjType) ? type as ObjType : 'commit',
      tag,
      tagger: `${String(tagger.name ?? VIEWER.name)} <${String(tagger.email ?? VIEWER.email)}> ${commitTimestamp()}`,
      message,
    });
    repo.objects.set(t.oid, { type: 'tag', data: t.data });
    sendJson(res, 201, { node_id: `TAG_${t.oid}`, url: `${base}/git/tags/${t.oid}`, tag, sha: t.oid, message, tagger: { name: String(tagger.name ?? VIEWER.name), email: String(tagger.email ?? VIEWER.email), date: stamp() }, object: { sha: obj, type, url: `${base}/git/commits/${obj}` } });
    return true;
  }

  // contents
  if (tail === 'contents' && method === 'GET') {
    const ref = ctx.query.get('ref') ?? headRef(repo);
    const entries = dirListing(repo, ref, '');
    if (entries === null) return sendError(res, 404, 'Not Found'), true;
    sendJson(res, 200, entries);
    return true;
  }
  const contentsMatch = /^contents\/(.+)$/.exec(tail);
  if (contentsMatch) {
    const path = contentsMatch[1].replace(/\/+$/, '');
    return await handleContents(ctx, repo, path);
  }

  // labels
  if (tail === 'labels' && method === 'GET') {
    sendJson(res, 200, [...repo.labels.values()].map((l) => restLabel(l, repo)));
    return true;
  }
  if (tail === 'labels' && method === 'POST') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
    const name = typeof parsed.body.name === 'string' ? parsed.body.name : '';
    if (name === '') return sendError(res, 422, 'Validation Failed: name is required'), true;
    const created = addLabel(repo, name, typeof parsed.body.color === 'string' ? parsed.body.color : undefined, typeof parsed.body.description === 'string' ? parsed.body.description : null);
    if ('error' in created) return sendError(res, 422, created.error), true;
    sendJson(res, 201, restLabel(created, repo));
    return true;
  }
  const labelMatch = /^labels\/(.+)$/.exec(tail);
  if (labelMatch && method === 'GET') {
    const label = repo.labels.get(labelMatch[1]);
    if (!label) return sendError(res, 404, 'Label does not exist'), true;
    sendJson(res, 200, restLabel(label, repo));
    return true;
  }

  // issues
  if (tail === 'issues' && method === 'GET') {
    const state = ctx.query.get('state') ?? 'open';
    const perPage = clampInt(ctx.query.get('per_page'), 1, 100, 30);
    const page = clampInt(ctx.query.get('page'), 1, 10_000, 1);
    const sort = ctx.query.get('sort') ?? 'created';
    const direction = ctx.query.get('direction') ?? 'desc';
    let issues = [...repo.issues.values()].filter((i) => i.state === state || state === 'all');
    issues.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number));
    if (direction === 'desc') issues.reverse();
    void sort;
    const slice = issues.slice((page - 1) * perPage, page * perPage);
    sendJson(res, 200, slice.map((i) => restIssue(i, repo)), linkHeader(`${base}/issues`, ctx.query, page, perPage, issues.length));
    return true;
  }
  if (tail === 'issues' && method === 'POST') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
    const title = typeof parsed.body.title === 'string' ? parsed.body.title : '';
    if (title === '') return sendError(res, 422, 'Validation Failed: title is required'), true;
    const labels = Array.isArray(parsed.body.labels)
      ? parsed.body.labels.map((l) => (typeof l === 'string' ? l : (l as Record<string, unknown>)?.name as string)).filter((l): l is string => typeof l === 'string')
      : [];
    const created = addIssue(repo, { title, body: typeof parsed.body.body === 'string' ? parsed.body.body : null, labels });
    if ('error' in created) return sendError(res, 422, created.error), true;
    sendJson(res, 201, restIssue(created, repo));
    return true;
  }
  const issueMatch = /^issues\/(\d+)(?:\/(comments))?$/.exec(tail);
  if (issueMatch) {
    const issue = repo.issues.get(parseInt(issueMatch[1], 10));
    if (!issue) return sendError(res, 404, 'Not Found'), true;
    if (issueMatch[2] === 'comments') {
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => restComment(c, repo, issue.number)));
        return true;
      }
      if (method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
        const body = typeof parsed.body.body === 'string' ? parsed.body.body : '';
        if (body === '') return sendError(res, 422, 'Validation Failed: body is required'), true;
        const comment = { id: newCommentId(), body, user: VIEWER.login, createdAt: stamp(), updatedAt: stamp() };
        issue.comments.push(comment);
        issue.updatedAt = comment.createdAt;
        sendJson(res, 201, restComment(comment, repo, issue.number));
        return true;
      }
    }
    if (method === 'GET') { sendJson(res, 200, restIssue(issue, repo)); return true; }
    if (method === 'PATCH') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
      if (typeof parsed.body.title === 'string') issue.title = parsed.body.title;
      if (typeof parsed.body.body === 'string' || parsed.body.body === null) issue.body = parsed.body.body as string | null;
      if (parsed.body.state === 'open' || parsed.body.state === 'closed') {
        if (issue.state !== parsed.body.state) {
          issue.state = parsed.body.state;
          issue.closedAt = parsed.body.state === 'closed' ? stamp() : null;
          repo.openIssuesCount += parsed.body.state === 'closed' ? -1 : 1;
        }
      }
      issue.updatedAt = stamp();
      sendJson(res, 200, restIssue(issue, repo));
      return true;
    }
  }

  // pulls
  if (tail === 'pulls' && method === 'GET') {
    const state = ctx.query.get('state') ?? 'open';
    const perPage = clampInt(ctx.query.get('per_page'), 1, 100, 30);
    const page = clampInt(ctx.query.get('page'), 1, 10_000, 1);
    const pulls = [...repo.pulls.values()].filter((p) => p.state === state || state === 'all');
    const slice = pulls.slice((page - 1) * perPage, page * perPage);
    sendJson(res, 200, slice.map((p) => restPull(p, repo)), linkHeader(`${base}/pulls`, ctx.query, page, perPage, pulls.length));
    return true;
  }
  if (tail === 'pulls' && method === 'POST') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
    const title = typeof parsed.body.title === 'string' ? parsed.body.title : '';
    const head = typeof parsed.body.head === 'string' ? parsed.body.head : '';
    const baseBranch = typeof parsed.body.base === 'string' ? parsed.body.base : '';
    if (title === '' || head === '' || baseBranch === '') return sendError(res, 422, 'Validation Failed: title, head and base are required'), true;
    const created = addPull(repo, { title, body: typeof parsed.body.body === 'string' ? parsed.body.body : null, head, base: baseBranch });
    if ('error' in created) return sendError(res, 422, created.error), true;
    sendJson(res, 201, restPull(created, repo));
    return true;
  }
  const pullMatch = /^pulls\/(\d+)(?:\/(files|merge|comments))?$/.exec(tail);
  if (pullMatch) {
    const pull = repo.pulls.get(parseInt(pullMatch[1], 10));
    if (!pull) return sendError(res, 404, 'Not Found'), true;
    const action = pullMatch[2];
    if (action === undefined) {
      if (method === 'GET') { sendJson(res, 200, restPull(pull, repo)); return true; }
      if (method === 'PATCH') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
        if (typeof parsed.body.title === 'string') pull.title = parsed.body.title;
        if (typeof parsed.body.body === 'string' || parsed.body.body === null) pull.body = parsed.body.body as string | null;
        if (parsed.body.state === 'open' || parsed.body.state === 'closed') pull.state = parsed.body.state;
        pull.updatedAt = stamp();
        sendJson(res, 200, restPull(pull, repo));
        return true;
      }
    }
    if (action === 'files' && method === 'GET') {
      sendJson(res, 200, diffFiles(repo, pull.baseSha, pull.headSha));
      return true;
    }
    if (action === 'comments' && method === 'GET') {
      sendJson(res, 200, pull.comments.map((c) => restComment(c, repo, pull.number)));
      return true;
    }
    if (action === 'merge' && method === 'PUT') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
      if (pull.merged) return sendError(res, 405, 'Pull Request is not mergeable: already merged'), true;
      if (pull.state !== 'open') return sendError(res, 405, 'Pull Request is not open'), true;
      // conflict detection: paths changed on base since the common ancestor, and on head
      const ancestor = commonAncestor(repo, pull.baseSha, pull.headSha);
      const baseChanges = new Set<string>();
      const headChanges = new Set<string>();
      if (ancestor !== null) {
        const ancObj = repo.objects.get(ancestor);
        const ancTree = ancObj && ancObj.type === 'commit' ? parseCommit(ancObj.data).tree : null;
        const baseTip = repo.refs.get(pull.baseRef) ?? pull.baseSha;
        const baseTree = treeOf(repo, baseTip);
        const headTree = treeOf(repo, pull.headSha);
        const ancFlat = ancTree ? commitTreeState(repo, ancTree) : new Map<string, { oid: string; mode: string }>();
        for (const [p, e] of commitTreeState(repo, baseTree!)) if (ancFlat.get(p)?.oid !== e.oid) baseChanges.add(p);
        for (const [p, e] of commitTreeState(repo, headTree!)) if (ancFlat.get(p)?.oid !== e.oid) headChanges.add(p);
      }
      for (const p of baseChanges) if (headChanges.has(p)) return sendError(res, 405, 'Pull Request is not mergeable: conflicts'), true;
      const headTree = treeOf(repo, pull.headSha)!;
      const baseTip = repo.refs.get(pull.baseRef) ?? pull.baseSha;
      const mergeCommit = buildCommit({
        tree: headTree,
        parents: [baseTip],
        author: `${AUTHOR} ${commitTimestamp()}`,
        committer: `${AUTHOR} ${commitTimestamp()}`,
        message: `${pull.title} (#${pull.number})`,
      });
      repo.objects.set(mergeCommit.oid, { type: 'commit', data: mergeCommit.data });
      repo.refs.set(pull.baseRef, mergeCommit.oid);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = stamp();
      pull.mergedBy = VIEWER.login;
      pull.mergeCommitSha = mergeCommit.oid;
      pull.updatedAt = pull.mergedAt;
      touch(repo);
      sendJson(res, 200, { sha: mergeCommit.oid, merged: true, message: 'Pull Request successfully merged' });
      return true;
    }
  }

  sendError(res, 404, 'Not Found');
  return true;
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function commitShape(repo: Repo, sha: string, info: ReturnType<typeof parseCommit>): Record<string, unknown> {
  return {
    sha,
    node_id: `C_${sha}`,
    url: `/api/v3/repos/${repoFullName(repo)}/commits/${sha}`,
    html_url: `https://example.invalid/${repoFullName(repo)}/commit/${sha}`,
    commit: {
      url: `/api/v3/repos/${repoFullName(repo)}/git/commits/${sha}`,
      author: { name: nameOf(info.author), email: emailOf(info.author), date: dateOf(info.author) },
      committer: { name: nameOf(info.committer), email: emailOf(info.committer), date: dateOf(info.committer) },
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree, url: `/api/v3/repos/${repoFullName(repo)}/git/trees/${info.tree}` },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    parents: info.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repoFullName(repo)}/commits/${p}`, html_url: `https://example.invalid/${repoFullName(repo)}/commit/${p}` })),
  };
}

function nameOf(person: string): string {
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(person);
  return m ? m[1] : person;
}
function emailOf(person: string): string {
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(person);
  return m ? m[2] : '';
}
function dateOf(person: string): string {
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(person);
  if (!m) return stamp();
  return new Date(parseInt(m[3], 10) * 1000).toISOString().replace('.000Z', 'Z');
}

function dirListing(repo: Repo, ref: string, path: string): Record<string, unknown>[] | null {
  const sha = resolveRefish(repo, ref);
  if (sha === null) return null;
  const treeOid = treeOf(repo, sha);
  if (treeOid === null) return null;
  const found = contentEntry(repo, ref, path);
  if (found === null) return path === '' ? listTreeEntries(repo, treeOid, '') : null;
  if (found.type === 'file') return [fileShape(repo, path, found.oid, found.data, ref)];
  return listTreeEntries(repo, found.oid, path);
}

function listTreeEntries(repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  const out: Record<string, unknown>[] = [];
  for (const e of parseTree(obj.data)) {
    const childPath = prefix ? `${prefix}/${e.name}` : e.name;
    const isTree = e.mode === '40000' || e.mode === '040000';
    if (isTree) {
      out.push({
        type: 'dir',
        name: e.name,
        path: childPath,
        sha: e.oid,
        size: 0,
        url: `/api/v3/repos/${repoFullName(repo)}/contents/${childPath}`,
        git_url: `/api/v3/repos/${repoFullName(repo)}/git/trees/${e.oid}`,
        html_url: `https://example.invalid/${repoFullName(repo)}/tree/${e.oid}/${childPath}`,
      });
    } else {
      const blob = repo.objects.get(e.oid);
      out.push(fileShape(repo, childPath, e.oid, blob?.data ?? Buffer.alloc(0), prefix));
    }
  }
  return out;
}

function fileShape(repo: Repo, path: string, oid: string, data: Buffer, ref: string): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    name,
    path,
    sha: oid,
    size: data.length,
    url: `/api/v3/repos/${repoFullName(repo)}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    git_url: `/api/v3/repos/${repoFullName(repo)}/git/blobs/${oid}`,
    html_url: `https://example.invalid/${repoFullName(repo)}/blob/${ref}/${path}`,
    download_url: `https://example.invalid/${repoFullName(repo)}/raw/${ref}/${path}`,
    content: b64wrap(data.toString('base64')),
    encoding: 'base64',
    _links: {
      git: `/api/v3/repos/${repoFullName(repo)}/git/blobs/${oid}`,
      self: `/api/v3/repos/${repoFullName(repo)}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      html: `https://example.invalid/${repoFullName(repo)}/blob/${ref}/${path}`,
    },
  };
}

/** GitHub wraps base64 content at 60 characters. */
function b64wrap(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 60) lines.push(b64.slice(i, i + 60));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

async function handleContents(ctx: Ctx, repo: Repo, path: string): Promise<boolean> {
  const { req, res, method } = ctx;
  const base = `/api/v3/repos/${repoFullName(repo)}`;
  if (method === 'GET') {
    const ref = ctx.query.get('ref') ?? headRef(repo);
    const found = contentEntry(repo, ref, path);
    if (found === null) return sendError(res, 404, 'Not Found'), true;
    if (found.type === 'dir') {
      sendJson(res, 200, listTreeEntries(repo, found.oid, path));
      return true;
    }
    sendJson(res, 200, fileShape(repo, path, found.oid, found.data, ref));
    return true;
  }
  if (method === 'PUT') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
    const branch = typeof parsed.body.branch === 'string' && parsed.body.branch !== '' ? parsed.body.branch : repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const message = typeof parsed.body.message === 'string' && parsed.body.message !== '' ? parsed.body.message : 'Update file';
    const contentB64 = typeof parsed.body.content === 'string' ? parsed.body.content.replace(/\s+/g, '') : '';
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return sendError(res, 422, 'Validation Failed: content is not valid base64'), true;
    }
    const branchSha = repo.refs.get(ref) ?? (branch === repo.defaultBranch ? null : undefined);
    if (branchSha === undefined) return sendError(res, 404, 'Branch not found'), true;
    const existing = contentEntry(repo, ref, path);
    const providedSha = typeof parsed.body.sha === 'string' ? parsed.body.sha : null;
    if (existing !== null && existing.type === 'file') {
      if (providedSha === null) return sendError(res, 422, `Validation Failed: sha is required to update ${path}`), true;
      if (providedSha.toLowerCase() !== existing.oid.toLowerCase()) return sendError(res, 409, `${path} does not match ${providedSha}`), true;
    }
    const parents = branchSha !== null ? [branchSha] : [];
    const baseTree = branchSha !== null ? treeOf(repo, branchSha) : null;
    const { commitOid } = createTreeCommit(repo, baseTree, new Map([[path, { content }]]), message, parents);
    repo.refs.set(ref, commitOid);
    touch(repo);
    const created = existing === null;
    sendJson(res, created ? 201 : 200, {
      content: fileShape(repo, path, hashObject('blob', content), content, ref),
      commit: { sha: commitOid, node_id: `C_${commitOid}`, url: `${base}/git/commits/${commitOid}`, html_url: `https://example.invalid/${repoFullName(repo)}/commit/${commitOid}`, author: { name: VIEWER.name, email: VIEWER.email, date: stamp() }, committer: { name: VIEWER.name, email: VIEWER.email, date: stamp() }, message, tree: { sha: treeOf(repo, commitOid), url: `${base}/git/trees/${treeOf(repo, commitOid)}` }, parents: parents.map((p) => ({ sha: p, url: `${base}/git/commits/${p}`, html_url: `https://example.invalid/${repoFullName(repo)}/commit/${p}` })), verification: { verified: false, reason: 'unsigned', signature: null, payload: null } },
    });
    return true;
  }
  if (method === 'DELETE') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
    const branch = typeof parsed.body.branch === 'string' && parsed.body.branch !== '' ? parsed.body.branch : repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const branchSha = repo.refs.get(ref) ?? (branch === repo.defaultBranch ? null : undefined);
    if (branchSha === undefined) return sendError(res, 404, 'Branch not found'), true;
    const existing = contentEntry(repo, ref, path);
    if (existing === null || existing.type !== 'file') return sendError(res, 404, 'Not Found'), true;
    if (typeof parsed.body.sha === 'string' && parsed.body.sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return sendError(res, 409, `${path} does not match ${parsed.body.sha}`), true;
    }
    const message = typeof parsed.body.message === 'string' && parsed.body.message !== '' ? parsed.body.message : `Delete ${path}`;
    const { commitOid } = createTreeCommit(repo, treeOf(repo, branchSha), new Map([[path, { content: null }]]), message, [branchSha]);
    repo.refs.set(ref, commitOid);
    touch(repo);
    sendJson(res, 200, {
      content: null,
      commit: { sha: commitOid, node_id: `C_${commitOid}`, url: `${base}/git/commits/${commitOid}`, html_url: `https://example.invalid/${repoFullName(repo)}/commit/${commitOid}`, message, author: { name: VIEWER.name, email: VIEWER.email, date: stamp() }, committer: { name: VIEWER.name, email: VIEWER.email, date: stamp() } },
    });
    return true;
  }
  sendError(res, 404, 'Not Found');
  return true;
}

export type { Repo, Issue, Pull, GitObj };
