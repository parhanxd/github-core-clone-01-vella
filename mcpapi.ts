// MCP over streamable HTTP at /mcp: JSON-RPC 2.0, revision 2026-07-28 (server/discover)
// plus the 2025-06-18-style initialize handshake. The tools act on the same store as REST.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { REPOS, VIEWER, findRepo, repoFullName, createRepo, addIssue, addPull, restRepo, restIssue, restPull, stamp } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';

// ---------------------------------------------------------------- JSON-RPC plumbing

const JSONRPC_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** One canonical tools/list answer, stringified once: two calls must answer byte for byte. */
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new GitHub repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        full_name: { type: 'string', description: 'owner/repo, filled by the caller.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository: name, full name, description, default branch and visibility.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'owner/repo, filled by the caller.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        full_name: { type: 'string', description: 'owner/repo, filled by the caller.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues on a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state.' },
        full_name: { type: 'string', description: 'owner/repo, filled by the caller.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch to a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        full_name: { type: 'string', description: 'owner/repo, filled by the caller.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
        full_name: { type: 'string', description: 'owner/repo, filled by the caller.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

const TOOLS_JSON = JSON.stringify(TOOLS);

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

// ---------------------------------------------------------------- tool implementations

function toolCall(name: string, args: Record<string, unknown>): { ok: boolean; text: string; isError?: boolean } {
  let canonical = name.toLowerCase();
  const prefixes = ['github__', 'github_'];
  for (const p of prefixes) if (canonical.startsWith(p)) canonical = canonical.slice(p.length);
  switch (canonical) {
    case 'create_repo':
    case 'create_repository': {
      const fullName = typeof args.full_name === 'string' ? args.full_name : '';
      let name = typeof args.name === 'string' ? args.name : '';
      let owner = VIEWER.login;
      if (fullName.includes('/')) {
        const [o, n] = fullName.split('/', 2);
        owner = o;
        name = name || n;
      }
      if (name === '') return { ok: false, text: 'create_repo needs a name', isError: true };
      if (owner !== VIEWER.login) return { ok: false, text: `repository owner must be ${VIEWER.login}`, isError: true };
      const created = createRepo({
        name,
        description: typeof args.description === 'string' ? args.description : null,
        isPrivate: args.private === true,
      });
      if ('error' in created) return { ok: false, text: created.error, isError: true };
      return { ok: true, text: JSON.stringify({ id: created.id, name: created.name, full_name: repoFullName(created), default_branch: created.defaultBranch, private: created.isPrivate }) };
    }
    case 'get_repo':
    case 'get_repository': {
      const { owner, name, repo } = splitRepo(args);
      if (repo === null) return { ok: false, text: 'get_repo needs owner and repo', isError: true };
      if (repo.owner !== VIEWER.login) return { ok: false, text: 'repository not found', isError: true };
      return { ok: true, text: JSON.stringify({ id: repo.id, node_id: `R_${repo.id}`, name: repo.name, full_name: repoFullName(repo), description: repo.description, default_branch: repo.defaultBranch, private: repo.isPrivate }) };
    }
    case 'create_issue':
    case 'issue_create':
    case 'issues_create': {
      const { owner, name, repo } = splitRepo(args);
      if (repo === null) return { ok: false, text: 'create_issue needs owner and repo', isError: true };
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return { ok: false, text: 'create_issue needs a title', isError: true };
      const created = addIssue(repo, { title, body: typeof args.body === 'string' ? args.body : null });
      if ('error' in created) return { ok: false, text: created.error, isError: true };
      return { ok: true, text: JSON.stringify({ id: created.id, node_id: `MDU6SXNzdWU${created.id}`, number: created.number, title: created.title, state: created.state, url: `/api/v3/repos/${repoFullName(repo)}/issues/${created.number}` }) };
    }
    case 'list_issues':
    case 'issues_list':
    case 'issue_list': {
      const { owner, name, repo } = splitRepo(args);
      if (repo === null) return { ok: false, text: 'list_issues needs owner and repo', isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()].filter((i) => i.state === state || state === 'all');
      return { ok: true, text: JSON.stringify(issues.map((i) => ({ id: i.id, number: i.number, title: i.title, state: i.state, body: i.body, url: `/api/v3/repos/${repoFullName(repo)}/issues/${i.number}` }))) };
    }
    case 'create_pull_request':
    case 'pull_request_create':
    case 'pulls_create':
    case 'create_pr':
    case 'pr_create': {
      const { owner, name, repo } = splitRepo(args);
      if (repo === null) return { ok: false, text: 'create_pull_request needs owner and repo', isError: true };
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (title === '' || head === '' || base === '') return { ok: false, text: 'create_pull_request needs title, head and base', isError: true };
      const created = addPull(repo, { title, head, base, body: null });
      if ('error' in created) return { ok: false, text: created.error, isError: true };
      return { ok: true, text: JSON.stringify({ id: created.id, number: created.number, title: created.title, state: created.state, head: { ref: created.headRef.replace('refs/heads/', ''), sha: created.headSha }, base: { ref: created.baseRef.replace('refs/heads/', ''), sha: created.baseSha }, url: `/api/v3/repos/${repoFullName(repo)}/pulls/${created.number}` }) };
    }
    case 'merge_pull_request':
    case 'pull_request_merge':
    case 'pulls_merge':
    case 'merge_pr':
    case 'pr_merge': {
      const { owner, name, repo } = splitRepo(args);
      if (repo === null) return { ok: false, text: 'merge_pull_request needs owner and repo', isError: true };
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : parseInt(String(args.pull_number ?? args.number ?? ''), 10);
      if (!Number.isFinite(pullNumber)) return { ok: false, text: 'merge_pull_request needs pull_number', isError: true };
      const pull = repo.pulls.get(pullNumber);
      if (!pull) return { ok: false, text: 'pull request not found', isError: true };
      if (pull.merged) return { ok: false, text: 'pull request is already merged', isError: true };
      if (pull.state !== 'open') return { ok: false, text: 'pull request is not open', isError: true };
      const sha = squashMergeTool(repo, pull);
      if (sha === null) return { ok: false, text: 'pull request is not mergeable', isError: true };
      return { ok: true, text: JSON.stringify({ sha, merged: true, message: 'Pull Request successfully merged' }) };
    }
    default:
      return { ok: false, text: `unknown tool ${name}`, isError: true };
  }
}

function splitRepo(args: Record<string, unknown>): { owner: string; name: string; repo: Repo | null } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || name === '') && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, n] = args.full_name.split('/', 2);
    owner = owner || o;
    name = name || n;
  }
  if (owner === '' || name === '') return { owner, name, repo: null };
  const repo = findRepo(owner, name);
  return { owner, name, repo: repo ?? null };
}

function squashMergeTool(repo: Repo, pull: Pull): string | null {
  const headObj = repo.objects.get(pull.headSha);
  if (!headObj || headObj.type !== 'commit') return null;
  const headTree = headObj.data.toString('utf8').match(/^tree ([0-9a-f]{40})/m)?.[1];
  if (!headTree) return null;
  const baseObj = repo.objects.get(pull.baseSha);
  if (!baseObj || baseObj.type !== 'commit') return null;
  const ts = 1_735_689_600 + 10_000 + pull.number;
  const authorLine = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  const message = `${pull.title} (#${pull.number})`;
  const data = Buffer.from([`tree ${headTree}`, `parent ${pull.baseSha}`, `author ${authorLine}`, `committer ${authorLine}`, '', message].join('\n') + '\n', 'utf8');
  const sha = createHash('sha1').update(`commit ${data.length}\0`).update(data).digest('hex');
  repo.objects.set(sha, { type: 'commit', data });
  repo.refs.set(pull.baseRef, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = stamp();
  pull.mergeCommitSha = sha;
  pull.mergedBy = VIEWER.login;
  return sha;
}



// ---------------------------------------------------------------- the handler

export async function handleMcp(req: IncomingMessage, res: ServerResponse, authed: boolean): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');

  if (raw.length === 0) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rpcError(null, JSONRPC_ERRORS.PARSE, 'Parse error: empty request body')));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rpcError(null, JSONRPC_ERRORS.PARSE, 'Parse error: the request body is not valid JSON')));
    return;
  }

  const isBatch = Array.isArray(parsed);
  const messages = isBatch ? (parsed as unknown[]) : [parsed];
  const responses: unknown[] = [];
  let refused = false;
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      responses.push(rpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request: the message is not a JSON-RPC 2.0 object'));
      refused = true;
      continue;
    }
    const record = message as Record<string, unknown>;
    const method = typeof record.method === 'string' ? record.method : null;
    const id = record.id ?? null;
    const params = (record.params && typeof record.params === 'object' && !Array.isArray(record.params) ? record.params : {}) as Record<string, unknown>;

    if (method === 'initialize') {
      responses.push(rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' && SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[1],
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: { name: 'vella-forge', version: '1.0.0', title: 'Vella GitHub-compatible forge' },
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over git smart HTTP, REST and GraphQL.',
      }));
      continue;
    }
    if (method === 'server/discover') {
      responses.push(rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: { name: 'vella-forge', version: '1.0.0', title: 'Vella GitHub-compatible forge' },
        capabilities: { tools: { listChanged: false } },
      }));
      continue;
    }
    if (method === 'notifications/initialized' || (typeof method === 'string' && method.startsWith('notifications/'))) {
      // notifications take no answer
      continue;
    }
    const needsAuth = method !== 'ping';
    if (!authed && needsAuth) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rpcError(id, JSONRPC_ERRORS.INVALID_REQUEST, 'Unauthorized: the request carries no Authorization header')));
      return;
    }
    if (method === 'ping') {
      responses.push(rpcResult(id, {}));
      continue;
    }
    if (method === 'tools/list') {
      responses.push(rpcResult(id, { tools: JSON.parse(TOOLS_JSON) as unknown }));
      continue;
    }
    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : null;
      if (name === null) {
        responses.push(rpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, 'Invalid params: tools/call needs a tool name'));
        refused = true;
        continue;
      }
      const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
      const outcome = toolCall(name, args);
      if (outcome.isError === true && outcome.text.startsWith('unknown tool')) {
        responses.push(rpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, `Invalid params: unknown tool ${name}`));
        continue;
      }
      responses.push(rpcResult(id, {
        content: [{ type: 'text', text: outcome.text }],
        isError: outcome.isError === true,
      }));
      continue;
    }
    responses.push(rpcError(id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method ?? '(none)'}`));
    refused = true;
  }

  if (responses.length === 0) {
    // a notifications-only batch answers 202 Accepted
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end();
    return;
  }
  const body = isBatch ? JSON.stringify(responses) : JSON.stringify(responses[0]);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}

export type { Issue };
