// Repro of the failing REST/GraphQL/MCP checks against the running forge.
const base = process.argv[2];
const TOKEN = 'tok123';
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

async function req(method: string, path: string, body?: unknown, token = TOKEN): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(base + path, {
    method,
    headers: token ? H : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers };
}

async function create(name: string): Promise<any> {
  const r = await req('POST', '/api/v3/user/repos', { name, private: true, description: 'd' });
  if (r.status !== 201) console.log('create', name, r.status, JSON.stringify(r.json)?.slice(0, 120));
  return r.json;
}

async function putContent(repo: string, filePath: string, content: string, message: string, opts: { branch?: string; sha?: string } = {}): Promise<any> {
  const body: any = { message, content: Buffer.from(content).toString('base64') };
  if (opts.branch) body.branch = opts.branch;
  if (opts.sha) body.sha = opts.sha;
  return req('PUT', `/api/v3/repos/adaiversen/${repo}/contents/${filePath}`, body);
}

// ---- repos.pagination
async function pagination(): Promise<void> {
  const names: string[] = [];
  for (let i = 0; i < 30; i += 1) names.push(`pag-${i}`);
  for (const n of names) await create(n);
  let next: string | null = '/api/v3/user/repos?per_page=10';
  const seen: string[] = [];
  let pages = 0;
  while (next !== null && pages < 20) {
    const r = await req('GET', next);
    if (r.status !== 200) { console.log('PAGINATION fail status', r.status, next); return; }
    if (!Array.isArray(r.json)) { console.log('PAGINATION not array'); return; }
    if (r.json.length > 10) console.log('PAGINATION over 10');
    for (const it of r.json) seen.push(it.name);
    const link = r.headers.get('link') ?? '';
    const m = /<([^>]*)>\s*;\s*rel\s*=\s*"?next"?/.exec(link);
    next = m ? m[1] : null;
    if (next !== null) next = next.replace(/^https?:\/\/[^/]+/, '');
    pages += 1;
  }
  const uniq = new Set(seen);
  const missing = names.filter((n) => !uniq.has(n));
  console.log('PAGINATION pages', pages, 'entries', seen.length, 'distinct', uniq.size, 'missing', missing.length, missing[0] ?? '');
}

// ---- repos.commits
async function commits(): Promise<void> {
  const name = 'comm-repro';
  await create(name);
  const seed = await putContent(name, 'docs/readme.md', 'seed', 'seed msg');
  if (seed.status !== 201) console.log('commits seed', seed.status);
  const initSha = seed.json.commit.sha;
  const branch = 'feat-commits';
  const b = await req('POST', `/api/v3/repos/adaiversen/${name}/git/refs`, { ref: `refs/heads/${branch}`, sha: initSha });
  if (b.status !== 201) console.log('commits branch', b.status);
  const c = await putContent(name, 'docs/readme-commits.md', 'alt', 'seed msg (commits)', { branch });
  if (c.status !== 201) console.log('commits put', c.status);
  const list = await req('GET', `/api/v3/repos/adaiversen/${name}/commits?sha=${branch}`);
  const found = Array.isArray(list.json) && list.json.find((e: any) => e.sha?.toLowerCase() === c.json.commit.sha.toLowerCase());
  console.log('COMMITS branch list ok', found !== undefined, 'status', list.status, 'len', Array.isArray(list.json) ? list.json.length : 'n/a');
  if (found) console.log('COMMITS message', JSON.stringify(found.commit?.message));
  const baseList = await req('GET', `/api/v3/repos/adaiversen/${name}/commits`);
  const leaked = Array.isArray(baseList.json) && baseList.json.some((e: any) => e.sha?.toLowerCase() === c.json.commit.sha.toLowerCase());
  console.log('COMMITS default excludes', !leaked);
}

// ---- repos.contents-directory
async function contentsDir(): Promise<void> {
  const name = 'dir-repro';
  await create(name);
  const seed = await putContent(name, 'docs/seed.txt', 'seed', 'seed msg');
  if (seed.status !== 201) console.log('dir seed', seed.status, JSON.stringify(seed.json)?.slice(0, 200));
  for (const n of ['one.txt', 'two.txt']) {
    const c = await putContent(name, `docs/${n}`, 'alt', `seed msg (${n})`);
    if (c.status !== 201) console.log('dir put', n, c.status);
  }
  const r = await req('GET', `/api/v3/repos/adaiversen/${name}/contents/docs`);
  console.log('DIR status', r.status, Array.isArray(r.json) ? r.json.map((e: any) => e.name) : r.json);
}

await pagination();
await commits();
await contentsDir();
