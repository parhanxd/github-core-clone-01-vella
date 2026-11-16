// The forge's in-memory store: users, repositories, git objects and refs, issues, labels,
// pull requests and comments. Deterministic: ids and timestamps come from counters.

import { buildScenario } from './wire.ts';
import type { GitObj, ObjType } from './gitobj.ts';
import { hashObject } from './gitobj.ts';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
  avatarUrl: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  pullRequest: null;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
  blobUrl: string;
  rawUrl: string;
  contentsUrl: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedBy: string | null;
  draft: boolean;
  comments: Comment[];
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextLabelId: number;
  hasIssues: boolean;
  hasWiki: boolean;
  hasProjects: boolean;
  language: string | null;
  forksCount: number;
  stargazersCount: number;
  watchersCount: number;
  openIssuesCount: number;
  license: string | null;
  visibility: 'public' | 'private';
}

/** Deterministic clock: every timestamp comes from a counter, never the wall clock. */
class Clock {
  #epoch = 1_735_689_600; // matches wire.ts SCENARIO_EPOCH_SEC
  #tickMs = 0;
  iso(): string {
    this.#tickMs += 1000;
    return new Date((this.#epoch + Math.floor(this.#tickMs / 1000)) * 1000).toISOString().replace('.000Z', 'Z');
  }
}

const clock = new Clock();

let nextUserId = 1000;
let nextRepoId = 1;
let nextIssueId = 1;
let nextPullId = 1;
let nextCommentId = 1;

export function newCommentId(): number {
  return nextCommentId++;
}

// ---------------------------------------------------------------- users

const scenario = buildScenario();

export const VIEWER: User = {
  id: scenario.viewer.id,
  login: scenario.viewer.login,
  name: scenario.viewer.name,
  email: scenario.viewer.email,
  avatarUrl: `https://example.invalid/avatars/${scenario.viewer.login}.png`,
};

export const USERS: Map<string, User> = new Map();
for (const u of scenario.users) {
  USERS.set(u.login, { id: u.id, login: u.login, name: u.name, email: u.email, avatarUrl: `https://example.invalid/avatars/${u.login}.png` });
}

export const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
export const STRANGER_LOGIN = scenario.stranger.login;

export function userForToken(token: string | undefined): User | null {
  if (!token) return null;
  if (TOKEN !== '' && token === TOKEN) return VIEWER;
  return null;
}

// ---------------------------------------------------------------- repos

export const REPOS: Map<string, Repo> = new Map(); // key: owner/name (owner lowercase)

const repoKey = (owner: string, name: string): string => `${owner.toLowerCase()}/${name.toLowerCase()}`;

export function findRepo(owner: string, name: string): Repo | undefined {
  return REPOS.get(repoKey(owner, name));
}

export function repoFullName(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

export function createRepo(input: { name: string; description?: string | null; isPrivate?: boolean; defaultBranch?: string }): Repo | { error: string } {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(input.name) || input.name.endsWith('.git')) {
    return { error: 'name contains invalid characters' };
  }
  const key = repoKey(VIEWER.login, input.name);
  if (REPOS.has(key)) return { error: 'name already exists on this account' };
  const repo: Repo = {
    id: nextRepoId++,
    name: input.name,
    owner: VIEWER.login,
    description: input.description ?? null,
    isPrivate: input.isPrivate ?? false,
    defaultBranch: input.defaultBranch ?? 'main',
    createdAt: clock.iso(),
    updatedAt: clock.iso(),
    pushedAt: clock.iso(),
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextIssueNumber: 1,
    nextPullNumber: 1,
    nextLabelId: 1,
    hasIssues: true,
    hasWiki: true,
    hasProjects: true,
    language: null,
    forksCount: 0,
    stargazersCount: 0,
    watchersCount: 0,
    openIssuesCount: 0,
    license: null,
    visibility: (input.isPrivate ?? false) ? 'private' : 'public',
  };
  REPOS.set(key, repo);
  return repo;
}

export function listRepos(): Repo[] {
  return [...REPOS.values()];
}

// ---------------------------------------------------------------- git objects

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObj | undefined {
  return repo.objects.get(oid);
}

export function resolveRefish(repo: Repo, refish: string): string | null {
  if (repo.refs.has(refish)) return repo.refs.get(refish)!;
  const candidates = [refish, `refs/${refish}`, `refs/heads/${refish}`, `refs/tags/${refish}`];
  for (const c of candidates) {
    const v = repo.refs.get(c);
    if (v !== undefined) return v;
  }
  if (/^[0-9a-f]{40}$/.test(refish) && repo.objects.has(refish)) return refish;
  return null;
}

export function headRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

export function defaultBranchSha(repo: Repo): string | null {
  return repo.refs.get(headRef(repo)) ?? null;
}

export function touch(repo: Repo): void {
  repo.updatedAt = clock.iso();
  repo.pushedAt = clock.iso();
}

export function stamp(): string {
  return clock.iso();
}

// ---------------------------------------------------------------- labels / issues / pulls

export function addLabel(repo: Repo, name: string, color?: string, description?: string | null): Label | { error: string } {
  if (repo.labels.has(name)) return { error: 'label_name already exists' };
  const label: Label = {
    id: repo.nextLabelId++,
    name,
    color: color && /^[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : 'ededed',
    description: description ?? null,
  };
  repo.labels.set(name, label);
  return label;
}

export function addIssue(repo: Repo, input: { title: string; body?: string | null; labels?: string[] }): Issue | { error: string } {
  const labels: string[] = [];
  for (const name of input.labels ?? []) {
    if (!repo.labels.has(name)) return { error: `label ${name} does not exist` };
    labels.push(name);
  }
  const now = clock.iso();
  const issue: Issue = {
    id: nextIssueId++,
    number: repo.nextIssueNumber++,
    title: input.title,
    body: input.body ?? null,
    state: 'open',
    labels,
    comments: [],
    user: VIEWER.login,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    pullRequest: null,
  };
  repo.issues.set(issue.number, issue);
  repo.openIssuesCount += 1;
  repo.updatedAt = now;
  return issue;
}

export function addPull(repo: Repo, input: { title: string; body?: string | null; head: string; base: string }): Pull | { error: string } {
  const headSha = resolveRefish(repo, input.head);
  if (headSha === null) return { error: `head ${input.head} does not exist` };
  const baseSha = resolveRefish(repo, input.base);
  if (baseSha === null) return { error: `base ${input.base} does not exist` };
  if (input.head === input.base) return { error: 'head and base are the same branch' };
  const now = clock.iso();
  const pull: Pull = {
    id: nextPullId++,
    number: repo.nextPullNumber++,
    title: input.title,
    body: input.body ?? null,
    state: 'open',
    headRef: input.head.startsWith('refs/') ? input.head : `refs/heads/${input.head}`,
    baseRef: input.base.startsWith('refs/') ? input.base : `refs/heads/${input.base}`,
    headSha,
    baseSha,
    user: VIEWER.login,
    createdAt: now,
    updatedAt: now,
    mergedAt: null,
    merged: false,
    mergeCommitSha: null,
    mergedBy: null,
    draft: false,
    comments: [],
  };
  repo.pulls.set(pull.number, pull);
  repo.updatedAt = now;
  return pull;
}

// ---------------------------------------------------------------- REST shaping

export function restUser(u: User | string): Record<string, unknown> {
  const user = typeof u === 'string' ? USERS.get(u) ?? VIEWER : u;
  return {
    login: user.login,
    id: user.id,
    node_id: `MDQ6VXNlcj${user.id}`,
    avatar_url: user.avatarUrl,
    gravatar_id: '',
    url: `/api/v3/users/${user.login}`,
    html_url: `https://example.invalid/${user.login}`,
    type: 'User',
    site_admin: false,
  };
}

export function restRepo(repo: Repo): Record<string, unknown> {
  const owner = restUser(repo.owner);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repoFullName(repo),
    private: repo.isPrivate,
    owner,
    html_url: `https://example.invalid/${repoFullName(repo)}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repoFullName(repo)}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: `${repoFullName(repo)}.git`,
    ssh_url: `git@example.invalid:${repoFullName(repo)}.git`,
    clone_url: `https://example.invalid/${repoFullName(repo)}.git`,
    default_branch: repo.defaultBranch,
    visibility: repo.visibility,
    has_issues: repo.hasIssues,
    has_projects: repo.hasProjects,
    has_wiki: repo.hasWiki,
    has_pages: false,
    has_downloads: true,
    forks_count: repo.forksCount,
    stargazers_count: repo.stargazersCount,
    watchers_count: repo.watchersCount,
    open_issues_count: repo.openIssuesCount,
    size: repo.objects.size,
    language: repo.language,
    license: repo.license,
    archived: false,
    disabled: false,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
  };
}

export function restLabel(label: Label, repo: Repo): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `MDU6TGFiZWw${label.id}`,
    url: `/api/v3/repos/${repoFullName(repo)}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function restComment(c: Comment, repo: Repo, issueNumber: number): Record<string, unknown> {
  return {
    id: c.id,
    node_id: `IC_${c.id}`,
    url: `/api/v3/repos/${repoFullName(repo)}/issues/${issueNumber}/comments/${c.id}`,
    html_url: `https://example.invalid/${repoFullName(repo)}/issues/${issueNumber}#comment-${c.id}`,
    body: c.body,
    user: restUser(c.user),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    issue_url: `/api/v3/repos/${repoFullName(repo)}/issues/${issueNumber}`,
    author_association: 'OWNER',
  };
}

export function restIssue(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `MDU6SXNzdWU${issue.id}`,
    url: `/api/v3/repos/${repoFullName(repo)}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((n) => restLabel(repo.labels.get(n)!, repo)),
    comments: issue.comments.length,
    user: restUser(issue.user),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    pull_request: null,
    repository_url: `/api/v3/repos/${repoFullName(repo)}`,
    locked: false,
    active_lock_reason: null,
  };
}

export function restPull(pull: Pull, repo: Repo): Record<string, unknown> {
  const branch = (ref: string): Record<string, unknown> => {
    const name = ref.replace(/^refs\/(heads|tags)\//, '');
    const sha = resolveRefish(repo, ref) ?? '';
    return {
      label: `${repo.owner}:${name}`,
      ref: name,
      sha,
      user: restUser(repo.owner),
      repo: restRepo(repo),
    };
  };
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    url: `/api/v3/repos/${repoFullName(repo)}/pulls/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    merged_by: pull.mergedBy ? restUser(pull.mergedBy) : null,
    draft: pull.draft,
    user: restUser(pull.user),
    head: branch(pull.headRef),
    base: branch(pull.baseRef),
    labels: [],
    comments: pull.comments.length,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    author_association: 'OWNER',
    mergeable: pull.state === 'open' && !pull.merged ? true : null,
    mergeable_state: pull.merged ? 'clean' : 'clean',
    html_url: `https://example.invalid/${repoFullName(repo)}/pull/${pull.number}`,
  };
}

