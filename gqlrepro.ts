// Repro of the failing GraphQL/MCP checks.
const base = process.argv[2];
const H = { authorization: 'Bearer tok123', 'content-type': 'application/json' };

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${base}/api/graphql`, { method: 'POST', headers: H, body: JSON.stringify({ query, variables }) });
  return { status: res.status, json: await res.json() };
}

const ISSUE_FIELDS = `query Issue_fields {
  Issue: __type(name: "Issue") {
    fields(includeDeprecated: true) {
      name
    }
  }
}`;
const TYPE_FIELDS = `query PullRequestAndRepositoryFields {
  PullRequest: __type(name: "PullRequest") {
    fields(includeDeprecated: true) {
      name
    }
  }
  Repository: __type(name: "Repository") {
    fields(includeDeprecated: true) {
      name
    }
  }
}`;
const SEARCH_TYPE = `query SearchType_enumValues {
  SearchType: __type(name: "SearchType") {
    enumValues(includeDeprecated: true) {
      name
    }
  }
}`;

const issue = await gql(ISSUE_FIELDS);
console.log('ISSUE status', issue.status, 'names', JSON.stringify(issue.json?.data?.Issue?.fields?.map((f: any) => f.name) ?? issue.json));
const types = await gql(TYPE_FIELDS);
console.log('TYPES', JSON.stringify(types.json?.data?.PullRequest?.fields?.map((f: any) => f.name) ?? types.json));
console.log('REPO', JSON.stringify(types.json?.data?.Repository?.fields?.map((f: any) => f.name) ?? types.json));
const search = await gql(SEARCH_TYPE);
console.log('SEARCHTYPE', JSON.stringify(search.json?.data?.SearchType?.enumValues?.map((e: any) => e.name) ?? search.json));

// batch
const batch = await fetch(`${base}/api/graphql`, { method: 'POST', headers: H, body: JSON.stringify([{ query: 'query A { viewer { login } }' }, { query: ISSUE_FIELDS, variables: {} }]) });
const bj = await batch.json();
console.log('BATCH status', batch.status, 'isArray', Array.isArray(bj), Array.isArray(bj) ? `len ${bj.length}, first login ${JSON.stringify(bj[0]?.data?.viewer?.login)}, issue fields ${bj[1]?.data?.Issue?.fields?.length}` : '');

// create repo + PR + merge via GraphQL
await fetch(`${base}/api/v3/user/repos`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'gqlmerge', private: true }) });
const repoIdQ = await gql('query { repository(owner: "adaiversen", name: "gqlmerge") { id } }');
const repoId = repoIdQ.json?.data?.repository?.id;
console.log('repoId', repoId);
const createBranch = await fetch(`${base}/api/v3/repos/adaiversen/gqlmerge/git/refs`, { method: 'POST', headers: H, body: JSON.stringify({ ref: 'refs/heads/feat', sha: (await gql('query { repository(owner: "adaiversen", name: "gqlmerge") { defaultBranchRef { name } } }')).json.data.repository.defaultBranchRef?.name ?? '' }) });
console.log('branch pre', createBranch.status);
// seed initial content to know sha
const seed = await fetch(`${base}/api/v3/repos/adaiversen/gqlmerge/contents/README.md`, { method: 'PUT', headers: H, body: JSON.stringify({ message: 'seed', content: Buffer.from('hi\n').toString('base64') }) });
const seedSha = (await seed.json()).commit?.sha;
const br = await fetch(`${base}/api/v3/repos/adaiversen/gqlmerge/git/refs`, { method: 'POST', headers: H, body: JSON.stringify({ ref: 'refs/heads/feat', sha: seedSha }) });
console.log('branch', br.status);
await fetch(`${base}/api/v3/repos/adaiversen/gqlmerge/contents/docs/a.md`, { method: 'PUT', headers: H, body: JSON.stringify({ message: 'on feat', content: Buffer.from('feat\n').toString('base64'), branch: 'feat' }) });
const createPR = await gql('mutation($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id number } } }', { input: { repositoryId: repoId, baseRefName: 'main', headRefName: 'feat', title: 't', body: 'b' } });
console.log('createPR', JSON.stringify(createPR.json));
const prId = createPR.json?.data?.createPullRequest?.pullRequest?.id;
const merge = await gql('mutation($input: MergePullRequestInput!) { mergePullRequest(input: $input) { pullRequest { merged state number } } }', { input: { pullRequestId: prId, mergeMethod: 'SQUASH' } });
console.log('MERGE', JSON.stringify(merge.json));
