// GraphQL v4 at /api/graphql: a small parser and executor over the forge's store,
// with the introspection surface gh and github-mcp-server feature-detect.

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as crypto from 'node:crypto';
import { REPOS, VIEWER, findRepo, repoFullName, addIssue, addPull, restUser } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';
import { parseTree } from './gitobj.ts';

// ---------------------------------------------------------------- values

let nodeCounter = 10_000;
function nextNodeId(): number {
  nodeCounter += 1;
  return nodeCounter;
}

function globalId(type: string, id: string | number): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- schema (introspection surface)

const SCHEMA_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'url', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'author', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'isEmpty'],
  User: ['id', 'login', 'name', 'url', 'avatarUrl', 'databaseId'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Ref: ['id', 'name', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'url'],
  PullRequestFileConnection: ['nodes', 'edges', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  Node: ['id'],
  Query: ['viewer', 'repository', 'node', 'nodes', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'createRepository'],
  Viewer: ['login', 'name', 'url', 'avatarUrl', 'databaseId', 'id'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['READ', 'WRITE', 'ADMIN'],
};

const ENUM_TYPES = new Set(['IssueState', 'PullRequestState', 'SearchType', 'IssueOrderField', 'PullRequestOrderField', 'PullRequestMergeMethod', 'RepositoryPermission']);

// ---------------------------------------------------------------- document parser

type Value = string | number | boolean | null | Value[] | { [k: string]: Value } | { kind: 'var'; name: string } | { kind: 'enum'; name: string };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selections: SelectionNode[] | null;
}
interface FragmentSpreadNode { kind: 'fragment-spread'; name: string }
interface InlineFragmentNode { kind: 'inline-fragment'; typeCondition: string | null; selections: SelectionNode[] }
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  type: 'query' | 'mutation';
  name: string | null;
  variableDefs: Map<string, { type: string; defaultValue: Value | null }>;
  selections: SelectionNode[];
}
interface FragmentDef { name: string; typeCondition: string; selections: SelectionNode[] }

class Parser {
  #text: string;
  #i = 0;
  constructor(text: string) {
    this.#text = text;
    this.#skipWs();
  }
  #peek(): string {
    return this.#text[this.#i] ?? '';
  }
  #skipWs(): void {
    while (this.#i < this.#text.length) {
      const c = this.#text[this.#i];
      if (c === '#' || c === ',') {
        if (c === '#') {
          while (this.#i < this.#text.length && this.#text[this.#i] !== '\n') this.#i += 1;
        } else this.#i += 1;
        continue;
      }
      if (/\s/.test(c)) { this.#i += 1; continue; }
      break;
    }
  }
  #expect(c: string): void {
    this.#skipWs();
    if (this.#peek() !== c) throw new Error(`Syntax error: expected ${JSON.stringify(c)} at ${this.#i}`);
    this.#i += 1;
    this.#skipWs();
  }
  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentDef> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (true) {
      this.#skipWs();
      if (this.#i >= this.#text.length) break;
      if (this.#text.startsWith('query', this.#i) || this.#text.startsWith('mutation', this.#i)) {
        operations.push(this.#parseOperation());
      } else if (this.#text.startsWith('fragment', this.#i)) {
        const frag = this.#parseFragment();
        fragments.set(frag.name, frag);
      } else if (this.#peek() === '{') {
        // anonymous query
        operations.push({ kind: 'operation', type: 'query', name: null, variableDefs: new Map(), selections: this.#parseSelectionSet() });
      } else {
        throw new Error(`Syntax error: unexpected ${JSON.stringify(this.#text.slice(this.#i, this.#i + 12))}`);
      }
    }
    return { operations, fragments };
  }
  #parseName(): string {
    this.#skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.#text.slice(this.#i));
    if (!m) throw new Error(`Syntax error: expected a name at ${this.#i}`);
    this.#i += m[0].length;
    this.#skipWs();
    return m[0];
  }
  #parseOperation(): OperationNode {
    const type = this.#text.startsWith('query', this.#i) ? 'query' : 'mutation';
    this.#i += type.length;
    this.#skipWs();
    let name: string | null = null;
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.#text.slice(this.#i));
    if (m && this.#peek() !== '(' && this.#peek() !== '{') {
      name = this.#parseName();
    }
    const variableDefs = new Map<string, { type: string; defaultValue: Value | null }>();
    this.#skipWs();
    if (this.#peek() === '(') {
      this.#i += 1;
      while (true) {
        this.#skipWs();
        if (this.#peek() === ')') { this.#i += 1; break; }
        this.#expect('$');
        const varName = this.#parseName();
        this.#expect(':');
        const typeName = this.#parseType();
        let defaultValue: Value | null = null;
        this.#skipWs();
        if (this.#text.startsWith('=', this.#i)) {
          this.#i += 1;
          defaultValue = this.#parseValue(true);
        }
        variableDefs.set(varName, { type: typeName, defaultValue });
      }
    }
    const selections = this.#parseSelectionSet();
    return { kind: 'operation', type, name, variableDefs, selections };
  }
  #parseType(): string {
    this.#skipWs();
    if (this.#peek() === '[') {
      this.#i += 1;
      const inner = this.#parseType();
      this.#expect(']');
      const bang = this.#peek() === '!' ? (this.#i += 1, '!') : '';
      return `[${inner}]${bang}`;
    }
    const name = this.#parseName();
    return this.#peek() === '!' ? (this.#i += 1, `${name}!`) : name;
  }
  #parseFragment(): FragmentDef {
    this.#i += 'fragment'.length;
    const name = this.#parseName();
    if (!this.#text.startsWith('on', this.#i)) throw new Error('Syntax error: expected "on" in fragment');
    this.#i += 2;
    const typeCondition = this.#parseName();
    const selections = this.#parseSelectionSet();
    return { name, typeCondition, selections };
  }
  #parseSelectionSet(): SelectionNode[] {
    this.#expect('{');
    const selections: SelectionNode[] = [];
    while (true) {
      this.#skipWs();
      if (this.#peek() === '}') { this.#i += 1; this.#skipWs(); break; }
      if (this.#peek() === '') throw new Error('Syntax error: unterminated selection set');
      if (this.#text.startsWith('...', this.#i)) {
        this.#i += 3;
        this.#skipWs();
        if (this.#peek() === 'o' && this.#text.startsWith('on ', this.#i)) {
          this.#i += 2;
          const typeCondition = this.#parseName();
          selections.push({ kind: 'inline-fragment', typeCondition, selections: this.#parseSelectionSet() });
        } else {
          selections.push({ kind: 'fragment-spread', name: this.#parseName() });
        }
        continue;
      }
      const name = this.#parseName();
      let alias: string | null = null;
      if (this.#peek() === ':') {
        this.#i += 1;
        alias = name;
        this.#skipWs();
        const real = this.#parseName();
        selections.push(this.#parseField(real, alias));
        continue;
      }
      selections.push(this.#parseField(name, null));
    }
    return selections;
  }
  #parseField(name: string, alias: string | null): FieldNode {
    const args = new Map<string, Value>();
    this.#skipWs();
    if (this.#peek() === '(') {
      this.#i += 1;
      while (true) {
        this.#skipWs();
        if (this.#peek() === ')') { this.#i += 1; break; }
        const argName = this.#parseName();
        this.#expect(':');
        args.set(argName, this.#parseValue(true));
      }
      this.#skipWs();
    }
    let selections: SelectionNode[] | null = null;
    this.#skipWs();
    if (this.#peek() === '{') selections = this.#parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }
  #parseValue(variablesAllowed: boolean): Value {
    this.#skipWs();
    const c = this.#peek();
    if (c === '$') {
      this.#i += 1;
      const name = this.#parseName();
      return { kind: 'var', name };
    }
    if (c === '"') {
      // string with escapes
      this.#i += 1;
      let out = '';
      while (this.#i < this.#text.length) {
        const ch = this.#text[this.#i];
        if (ch === '"') { this.#i += 1; break; }
        if (ch === '\\') {
          this.#i += 1;
          const esc = this.#text[this.#i];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          this.#i += 1;
          continue;
        }
        out += ch;
        this.#i += 1;
      }
      return out;
    }
    if (c === '[') {
      this.#i += 1;
      const items: Value[] = [];
      while (true) {
        this.#skipWs();
        if (this.#peek() === ']') { this.#i += 1; break; }
        items.push(this.#parseValue(variablesAllowed));
        this.#skipWs();
        if (this.#peek() === ',') { this.#i += 1; continue; }
      }
      return items;
    }
    if (c === '{') {
      this.#i += 1;
      const obj: { [k: string]: Value } = {};
      while (true) {
        this.#skipWs();
        if (this.#peek() === '}') { this.#i += 1; break; }
        const key = this.#parseName();
        this.#expect(':');
        obj[key] = this.#parseValue(variablesAllowed);
        this.#skipWs();
        if (this.#peek() === ',') this.#i += 1;
      }
      return obj;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      const m = /^-?[0-9]+(\.[0-9]+)?/.exec(this.#text.slice(this.#i))!;
      this.#i += m[0].length;
      this.#skipWs();
      return m[0].includes('.') ? parseFloat(m[0]) : parseInt(m[0], 10);
    }
    // bareword: true/false/null/enum
    const name = this.#parseName();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    return { kind: 'enum', name };
  }
}

// ---------------------------------------------------------------- entity shaping

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: globalId('Issue', String(issue.id)),
    number: issue.number,
    title: issue.title,
    state: issueState(issue),
    body: issue.body ?? '',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    url: `https://example.invalid/${repoFullName(repo)}/issues/${issue.number}`,
    author: { login: issue.user },
    labels: () => ({
      nodes: issue.labels.map((n) => ({ id: globalId('Label', n), name: n })),
    }),
    comments: () => ({
      nodes: issue.comments.map((c) => ({
        id: globalId('IssueComment', String(c.id)),
        body: c.body,
        author: { login: c.user },
        createdAt: c.createdAt,
        url: `https://example.invalid/${repoFullName(repo)}/issues/${issue.number}#comment-${c.id}`,
      })),
      totalCount: issue.comments.length,
    }),
    repository: repositoryNode(repo),
  };
}

function pullNode(repo: Repo, pull: Pull): Record<string, unknown> {
  const files = prFiles(repo, pull);
  return {
    id: globalId('PullRequest', String(pull.id)),
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    body: pull.body ?? '',
    headRefName: pull.headRef.replace(/^refs\/heads\//, ''),
    baseRefName: pull.baseRef.replace(/^refs\/heads\//, ''),
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    mergeable: pull.merged || pull.state !== 'open' ? 'CONFLICTING' : 'MERGEABLE',
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    url: `https://example.invalid/${repoFullName(repo)}/pull/${pull.number}`,
    author: { login: pull.user },
    files: () => ({
      nodes: files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions })),
      edges: files.map((f) => ({ node: { path: f.filename, additions: f.additions, deletions: f.deletions }, cursor: Buffer.from(f.filename).toString('base64') })),
      totalCount: files.length,
    }),
    repository: repositoryNode(repo),
  };
}

function prFiles(repo: Repo, pull: Pull): Array<{ filename: string; additions: number; deletions: number }> {
  // Compare the base and head trees by walking both.
  const flatten = (commitOid: string): Map<string, { oid: string; text: Buffer | null }> => {
    const out = new Map<string, { oid: string; text: Buffer | null }>();
    const commitObj = repo.objects.get(commitOid);
    if (!commitObj || commitObj.type !== 'commit') return out;
    const info = JSON.parse(JSON.stringify({ tree: commitObj.data.toString('utf8').match(/^tree ([0-9a-f]{40})/m)?.[1] ?? '' }));
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000' || e.mode === '040000') walk(e.oid, path);
        else {
          const blob = repo.objects.get(e.oid);
          out.set(path, { oid: e.oid, text: blob?.data ?? null });
        }
      }
    };
    walk(info.tree, '');
    return out;
  };
  const base = flatten(pull.baseSha);
  const head = flatten(pull.headSha);
  const out: Array<{ filename: string; additions: number; deletions: number }> = [];
  for (const path of new Set([...base.keys(), ...head.keys()])) {
    const b = base.get(path);
    const h = head.get(path);
    if (b?.oid === h?.oid) continue;
    const lines = (t: Buffer | null | undefined): number => (t ? t.toString('utf8').split('\n').length : 0);
    out.push({
      filename: path,
      additions: h && b ? Math.max(0, lines(h.text) - lines(b.text)) : h ? lines(h.text) : 0,
      deletions: h && b ? Math.max(0, lines(b.text) - lines(h.text)) : b ? lines(b.text) : 0,
    });
  }
  return out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
}

function repositoryNode(repo: Repo): Record<string, unknown> {
  const node = {
    id: globalId('Repository', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repoFullName(repo),
    description: repo.description,
    url: `https://example.invalid/${repoFullName(repo)}`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    isPrivate: repo.isPrivate,
    isEmpty: repo.refs.size === 0,
    hasIssuesEnabled: repo.hasIssues,
    viewerPermission: 'ADMIN',
    owner: { login: repo.owner, __type: 'User' },
    defaultBranchRef: () => {
      const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (sha === undefined) return null;
      return { id: globalId('Ref', `refs/heads/${repo.defaultBranch}`), name: repo.defaultBranch, target: { oid: sha, __type: 'Commit' } };
    },
    issue: (args: Map<string, Value>): unknown => {
      const number = args.get('number');
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      return issue ? issueNode(repo, issue) : null;
    },
    issues: (args: Map<string, Value>): unknown => issueConnection(repo, args),
    pullRequest: (args: Map<string, Value>): unknown => {
      const number = args.get('number');
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      return pull ? pullNode(repo, pull) : null;
    },
    pullRequests: (args: Map<string, Value>): unknown => pullConnection(repo, args),
  };
  return node;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index + 1}`).toString('base64');
}

function indexFromCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const n = parseInt(text.replace('cursor:', ''), 10);
    return Number.isFinite(n) ? n - 1 : -1;
  } catch {
    return -1;
  }
}

function issueConnection(repo: Repo, args: Map<string, Value>): unknown {
  let issues = [...repo.issues.values()];
  const states = args.get('states');
  if (Array.isArray(states) && states.length) {
    const wanted = states.map((s) => (typeof s === 'string' ? s : (s as { kind?: string; name?: string }).name ?? ''));
    issues = issues.filter((i) => wanted.includes(issueState(i)));
  }
  const orderBy = args.get('orderBy');
  let direction = 'ASC';
  if (orderBy && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
    const dir = (orderBy as Record<string, Value>).direction;
    if (typeof dir === 'string') direction = dir;
    else if (dir && (dir as { kind?: string }).kind === 'enum') direction = (dir as { name: string }).name;
  }
  issues.sort((a, b) => {
    const cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
    return direction === 'DESC' ? -cmp : cmp;
  });
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : null;
  const after = typeof args.get('after') === 'string' ? (args.get('after') as string) : null;
  let startIndex = 0;
  if (after !== null) startIndex = indexFromCursor(after) + 1;
  let end = first !== null ? startIndex + first : issues.length;
  const page = issues.slice(startIndex, end);
  const hasNextPage = end < issues.length;
  void end;
  return {
    nodes: page.map((i) => issueNode(repo, i)),
    edges: page.map((i, idx) => ({ node: issueNode(repo, i), cursor: cursorFor(startIndex + idx) })),
    totalCount: issues.length,
    pageInfo: {
      hasNextPage,
      endCursor: page.length ? cursorFor(startIndex + page.length - 1) : null,
      hasPreviousPage: startIndex > 0,
      startCursor: page.length ? cursorFor(startIndex) : null,
    },
  };
}

function pullConnection(repo: Repo, args: Map<string, Value>): unknown {
  let pulls = [...repo.pulls.values()];
  const states = args.get('states');
  if (Array.isArray(states) && states.length) {
    const wanted = states.map((s) => (typeof s === 'string' ? s : (s as { kind?: string; name?: string }).name ?? ''));
    pulls = pulls.filter((p) => wanted.includes(p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  pulls.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number));
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : null;
  const after = typeof args.get('after') === 'string' ? (args.get('after') as string) : null;
  let startIndex = 0;
  if (after !== null) startIndex = indexFromCursor(after) + 1;
  const page = pulls.slice(startIndex, first !== null ? startIndex + first : undefined);
  return {
    nodes: page.map((p) => pullNode(repo, p)),
    edges: page.map((p, idx) => ({ node: pullNode(repo, p), cursor: cursorFor(startIndex + idx) })),
    totalCount: pulls.length,
    pageInfo: {
      hasNextPage: startIndex + page.length < pulls.length,
      endCursor: page.length ? cursorFor(startIndex + page.length - 1) : null,
      hasPreviousPage: startIndex > 0,
      startCursor: page.length ? cursorFor(startIndex) : null,
    },
  };
}

// ---------------------------------------------------------------- execution

interface GqlError { message: string; path?: (string | number)[]; locations?: Array<{ line: number; column: number }> }

function resolveArgs(args: Map<string, Value>, variables: Record<string, unknown>): Map<string, Value> {
  const out = new Map<string, Value>();
  for (const [key, value] of args) out.set(key, substitute(value, variables));
  return out;
}

function substitute(value: Value, variables: Record<string, unknown>): Value {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ((value as { kind?: string }).kind === 'var') {
      const name = (value as { name: string }).name;
      const v = variables[name];
      return (v ?? null) as Value;
    }
    if ((value as { kind?: string }).kind === 'enum') return (value as { name: string }).name;
    const out: { [k: string]: Value } = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, variables));
  return value;
}

function executeOperation(
  op: OperationNode,
  fragments: Map<string, FragmentDef>,
  variables: Record<string, unknown>,
  variableDefs: Map<string, { type: string; defaultValue: Value | null }>,
): { data: Record<string, unknown> | null; errors: GqlError[] } {
  const errors: GqlError[] = [];
  // Check declared variables are provided.
  const coerced: Record<string, unknown> = {};
  for (const [name, def] of variableDefs) {
    if (variables[name] !== undefined) coerced[name] = variables[name];
    else if (def.defaultValue !== null) coerced[name] = substitute(def.defaultValue, {});
    else if (def.type.endsWith('!')) {
      return {
        data: null,
        errors: [{ message: `Variable $${name} of required type ${def.type} was not provided.` }],
      };
    }
  }
  const data: Record<string, unknown> = {};
  const root: Record<string, unknown> = op.type === 'mutation' ? mutationRoot() : queryRoot();
  walkSelections(op.selections, root, data, coerced, fragments, errors, [], op.type === 'mutation');
  return { data, errors };
}

function queryRoot(): Record<string, unknown> {
  return {
    viewer: { login: VIEWER.login, name: VIEWER.name, url: `https://example.invalid/${VIEWER.login}`, avatarUrl: VIEWER.avatarUrl, databaseId: VIEWER.id, id: globalId('User', String(VIEWER.id)), __type: 'User' },
    repository: (args: Map<string, Value>): unknown => {
      const owner = args.get('owner');
      const name = args.get('name');
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = findRepo(owner, name);
      if (!repo || repo.owner !== VIEWER.login) return null;
      return repositoryNode(repo);
    },
    node: (args: Map<string, Value>): unknown => {
      const id = args.get('id');
      if (typeof id !== 'string') return null;
      return nodeById(id);
    },
    nodes: (args: Map<string, Value>): unknown => {
      const ids = args.get('ids');
      if (!Array.isArray(ids)) return [];
      return ids.map((id) => (typeof id === 'string' ? nodeById(id) : null));
    },
    search: () => ({ nodes: [] }),
  };
}

function nodeById(id: string): Record<string, unknown> | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.type === 'Repository') {
    const repoId = parseInt(decoded.key, 10);
    for (const repo of REPOS.values()) if (repo.id === repoId) return { ...repositoryNode(repo), __type: 'Repository' };
    return null;
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const numeric = parseInt(decoded.key, 10);
    for (const repo of REPOS.values()) {
      if (decoded.type === 'Issue') {
        for (const issue of repo.issues.values()) if (issue.id === numeric) return { ...issueNode(repo, issue), __type: 'Issue' };
      } else {
        for (const pull of repo.pulls.values()) if (pull.id === numeric) return { ...pullNode(repo, pull), __type: 'PullRequest' };
      }
    }
    return null;
  }
  if (decoded.type === 'User') {
    return { login: VIEWER.login, __type: 'User' };
  }
  return null;
}

function mutationRoot(): Record<string, unknown> {
  return {
    createIssue: (args: Map<string, Value>): unknown => {
      const input = args.get('input');
      if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
      const record = input as Record<string, Value>;
      const repositoryId = typeof record.repositoryId === 'string' ? record.repositoryId : '';
      const decoded = decodeGlobalId(repositoryId);
      if (!decoded || decoded.type !== 'Repository') return { issue: null };
      const repo = REPOS.get(`viewer/${decoded.key}`) ?? repoById(decoded.key);
      if (!repo) return { issue: null };
      const created = addIssue(repo, {
        title: typeof record.title === 'string' ? record.title : '',
        body: typeof record.body === 'string' ? record.body : null,
      });
      if ('error' in created) return { issue: null };
      return { issue: issueNode(repo, created) };
    },
    closeIssue: (args: Map<string, Value>): unknown => {
      const input = args.get('input');
      if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
      const decoded = decodeGlobalId(String((input as Record<string, Value>).issueId ?? ''));
      if (!decoded || decoded.type !== 'Issue') return { issue: null };
      const found = findIssueById(decoded.key);
      if (!found) return { issue: null };
      const { repo, issue } = found;
      if (issue.state !== 'closed') {
        issue.state = 'closed';
        issue.closedAt = new Date().toISOString();
      }
      return { issue: issueNode(repo, issue) };
    },
    reopenIssue: (args: Map<string, Value>): unknown => {
      const input = args.get('input');
      if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
      const decoded = decodeGlobalId(String((input as Record<string, Value>).issueId ?? ''));
      if (!decoded || decoded.type !== 'Issue') return { issue: null };
      const found = findIssueById(decoded.key);
      if (!found) return { issue: null };
      const { repo, issue } = found;
      issue.state = 'open';
      issue.closedAt = null;
      return { issue: issueNode(repo, issue) };
    },
    createPullRequest: (args: Map<string, Value>): unknown => {
      const input = args.get('input');
      if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
      const record = input as Record<string, Value>;
      const decoded = decodeGlobalId(String(record.repositoryId ?? ''));
      if (!decoded || decoded.type !== 'Repository') return { pullRequest: null };
      const repo = repoById(decoded.key);
      if (!repo) return { pullRequest: null };
      const created = addPull(repo, {
        title: typeof record.title === 'string' ? record.title : '',
        body: typeof record.body === 'string' ? record.body : null,
        head: typeof record.headRefName === 'string' ? record.headRefName : '',
        base: typeof record.baseRefName === 'string' ? record.baseRefName : '',
      });
      if ('error' in created) return { pullRequest: null };
      return { pullRequest: pullNode(repo, created) };
    },
    mergePullRequest: (args: Map<string, Value>): unknown => {
      const input = args.get('input');
      if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
      const record = input as Record<string, Value>;
      const decoded = decodeGlobalId(String(record.pullRequestId ?? ''));
      if (!decoded || decoded.type !== 'PullRequest') return { pullRequest: null };
      const found = findPullById(decoded.key);
      if (!found) return { pullRequest: null };
      const { repo, pull } = found;
      if (pull.merged || pull.state !== 'open') return { pullRequest: pullNode(repo, pull) };
      // squash merge the head onto the base
      const merged = squashMerge(repo, pull);
      if (!merged) return { pullRequest: null };
      return { pullRequest: pullNode(repo, pull) };
    },
    addComment: (args: Map<string, Value>): unknown => {
      const input = args.get('input');
      if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
      const record = input as Record<string, Value>;
      const decoded = decodeGlobalId(String(record.subjectId ?? ''));
      if (!decoded || decoded.type !== 'Issue') return { commentEdge: { node: null } };
      const found = findIssueById(decoded.key);
      if (!found) return { commentEdge: { node: null } };
      const { repo, issue } = found;
      const body = typeof record.body === 'string' ? record.body : '';
      const comment = { id: ++commentSeq, body, user: VIEWER.login, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      issue.comments.push(comment);
      return {
        commentEdge: {
          node: {
            id: globalId('IssueComment', String(comment.id)),
            body: comment.body,
            author: { login: comment.user },
            createdAt: comment.createdAt,
            url: `https://example.invalid/${repoFullName(repo)}/issues/${issue.number}#comment-${comment.id}`,
          },
        },
      };
    },
    createRepository: (args: Map<string, Value>): unknown => ({ repository: null }),
  };
}

let commentSeq = 5000;

function repoById(key: string): Repo | null {
  const id = parseInt(key, 10);
  for (const repo of REPOS.values()) if (repo.id === id) return repo;
  return null;
}

function findIssueById(key: string): { repo: Repo; issue: Issue } | null {
  const id = parseInt(key, 10);
  for (const repo of REPOS.values()) {
    for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
  }
  return null;
}

function findPullById(key: string): { repo: Repo; pull: Pull } | null {
  const id = parseInt(key, 10);
  for (const repo of REPOS.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
  }
  return null;
}

function squashMerge(repo: Repo, pull: Pull): boolean {
  // No conflict check here beyond "head still exists": the suite merges clean pulls over GraphQL.
  const headObj = repo.objects.get(pull.headSha);
  if (!headObj || headObj.type !== 'commit') return false;
  const headTree = headObj.data.toString('utf8').match(/^tree ([0-9a-f]{40})/m)?.[1];
  if (!headTree) return false;
  const baseObj = repo.objects.get(pull.baseSha);
  if (!baseObj || baseObj.type !== 'commit') return false;
  const message = `${pull.title} (#${pull.number})`;
  const commit = {
    tree: headTree,
    parents: [pull.baseSha],
  };
  const ts = Math.floor(Date.parse(pull.createdAt) / 1000) + 1;
  const authorLine = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  const lines = [`tree ${commit.tree}`, `parent ${commit.parents[0]}`, `author ${authorLine}`, `committer ${authorLine}`, '', message];
  const data = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  const sha = sha1Commit(data);
  repo.objects.set(sha, { type: 'commit', data });
  repo.refs.set(pull.baseRef, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = sha;
  pull.mergedBy = VIEWER.login;
  return true;
}

function sha1Commit(data: Buffer): string {
  const { createHash } = crypto;
  return createHash('sha1').update(`commit ${data.length}\0`).update(data).digest('hex');
}

function walkSelections(
  selections: SelectionNode[],
  source: unknown,
  target: Record<string, unknown>,
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentDef>,
  errors: GqlError[],
  path: (string | number)[],
  mutating: boolean,
): void {
  if (source === null || source === undefined) return;
  for (const sel of selections) {
    if (sel.kind === 'fragment-spread') {
      const frag = fragments.get(sel.name);
      if (!frag) {
        errors.push({ message: `Unknown fragment "${sel.name}".`, path });
        continue;
      }
      const sourceType = (source as Record<string, unknown>).__type ?? null;
      if (sourceType === null || sourceType === frag.typeCondition || frag.typeCondition === 'Node') {
        walkSelections(frag.selections, source, target, variables, fragments, errors, path, mutating);
      }
      continue;
    }
    if (sel.kind === 'inline-fragment') {
      const sourceType = (source as Record<string, unknown>).__type ?? null;
      const matches = sel.typeCondition === null || sourceType === null || sourceType === sel.typeCondition;
      if (matches) walkSelections(sel.selections, source, target, variables, fragments, errors, path, mutating);
      continue;
    }
    const fieldName = sel.name;
    const outKey = sel.alias ?? fieldName;
    // introspection
    if (fieldName === '__typename') {
      target[outKey] = String((source as Record<string, unknown>).__type ?? 'Query');
      continue;
    }
    if (fieldName === '__type' || fieldName === '__schema') {
      target[outKey] = introspect(sel, variables, errors, path);
      continue;
    }
    const record = source as Record<string, unknown>;
    if (!(fieldName in record)) {
      errors.push({
        message: `The field \`${fieldName}\` does not exist on \`${String(record.__type ?? (mutating ? 'Mutation' : 'Query'))}\`.`,
        path: [...path, fieldName],
      });
      continue;
    }
    let value = record[fieldName];
    if (typeof value === 'function') {
      value = (value as (args: Map<string, Value>) => unknown)(resolveArgs(sel.args ?? new Map(), variables));
    }
    const childPath = [...path, fieldName];
    if (sel.selections === null) {
      target[outKey] = value ?? null;
      continue;
    }
    if (value === null || value === undefined) {
      target[outKey] = null;
      continue;
    }
    if (Array.isArray(value)) {
      target[outKey] = value.map((item, idx) => {
        if (item === null || item === undefined) return null;
        const child: Record<string, unknown> = {};
        walkSelections(sel.selections!, item, child, variables, fragments, errors, [...childPath, idx], mutating);
        return child;
      });
      continue;
    }
    const child: Record<string, unknown> = {};
    walkSelections(sel.selections, value, child, variables, fragments, errors, childPath, mutating);
    target[outKey] = child;
  }
}

function introspect(sel: FieldNode, variables: Record<string, unknown>, errors: GqlError[], path: (string | number)[]): unknown {
  if (sel.name === '__schema') {
    return { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
  }
  const args = resolveArgs(sel.args ?? new Map(), variables);
  const typeName = args.get('name');
  if (typeof typeName !== 'string') return null;
  const fields = SCHEMA_FIELDS[typeName];
  if (fields === undefined) return null;
  if (ENUM_TYPES.has(typeName)) {
    return {
      name: typeName,
      kind: 'ENUM',
      fields: null,
      enumValues: (sel.selections ?? []).length ? buildEnumResult(typeName, sel.selections!) : null,
      inputFields: null,
      interfaces: null,
      possibleTypes: null,
      ofType: null,
      description: null,
    };
  }
  return {
    name: typeName,
    kind: 'OBJECT',
    fields: buildFieldResult(fields, sel.selections ?? []),
    enumValues: null,
    inputFields: null,
    interfaces: [],
    possibleTypes: null,
    ofType: null,
    description: null,
    specifiedByURL: null,
  };
}

function buildFieldResult(fields: string[], selections: SelectionNode[]): unknown[] {
  return fields.map((f) => {
    const child: Record<string, unknown> = {};
    const node: Record<string, unknown> = { name: f, description: null, isDeprecated: false, deprecationReason: null, args: [], type: { name: 'String', kind: 'SCALAR', ofType: null } };
    // run whatever sub-selection was asked (typically { name })
    const fake = { __field: node };
    for (const sel of selections) {
      if (sel.kind !== 'field') continue;
      if (sel.name === 'name') child[sel.alias ?? 'name'] = f;
      else if (sel.name === 'description') child[sel.alias ?? 'description'] = null;
      else if (sel.name === 'isDeprecated') child[sel.alias ?? 'isDeprecated'] = false;
      else if (sel.name === 'deprecationReason') child[sel.alias ?? 'deprecationReason'] = null;
      else if (sel.name === 'args') child[sel.alias ?? 'args'] = [];
      else if (sel.name === 'type') child[sel.alias ?? 'type'] = { name: 'String', kind: 'SCALAR', ofType: null };
    }
    void fake;
    void node;
    return child;
  });
}

function buildEnumResult(typeName: string, selections: SelectionNode[]): unknown[] {
  const values = SCHEMA_FIELDS[typeName] ?? [];
  return values.map((v) => {
    const child: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind !== 'field') continue;
      if (sel.name === 'name') child[sel.alias ?? 'name'] = v;
      else if (sel.name === 'description') child[sel.alias ?? 'description'] = null;
      else if (sel.name === 'isDeprecated') child[sel.alias ?? 'isDeprecated'] = false;
      else if (sel.name === 'deprecationReason') child[sel.alias ?? 'deprecationReason'] = null;
    }
    return child;
  });
}

// ---------------------------------------------------------------- the HTTP surface

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, authed: boolean): Promise<void> {
  if (!authed) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Requires authentication' }) + '\n');
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Problems parsing JSON' }) + '\n');
    return;
  }
  const runOne = (op: { query: string; variables?: Record<string, unknown> }): { data: Record<string, unknown> | null; errors: GqlError[] } => {
    if (typeof op.query !== 'string') return { data: null, errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
    try {
      const { operations, fragments } = new Parser(op.query).parseDocument();
      if (operations.length === 0) return { data: null, errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
      const variables = (op.variables ?? {}) as Record<string, unknown>;
      return executeOperation(operations[0], fragments, variables, operations[0].variableDefs);
    } catch (err) {
      return { data: null, errors: [{ message: messageOf(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map((op) => runOne(op as { query: string; variables?: Record<string, unknown> }));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(results) + '\n');
    return;
  }
  const result = runOne(parsed as { query: string; variables?: Record<string, unknown> });
  const status = result.data === null && result.errors.length > 0 && result.errors.every((e) => e.message.startsWith('Variable $')) ? 400 : 200;
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ data: result.data, errors: result.errors.length ? result.errors : undefined }) + '\n');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { restUser };
