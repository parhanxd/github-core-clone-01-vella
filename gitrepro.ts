// Repro of the failing git checks, using the kit's own client.
import { GitClient, buildCommit, buildTree, hashObject, parseTree, parseCommit } from '/root/makefun/github-core-clone-01-kit/sdk/conformance/git-client.ts';

const base = process.argv[2];
const token = 'tok123';
const client = new GitClient({ baseUrl: base, token, timeoutMs: 15_000 });
const NAME = process.argv[3] ?? 'repro1';

let tick = 0;
function stamp(): string {
  tick += 1;
  return `${1735689600 + tick} +0000`;
}
function commitOf(files: Array<{ path: string; data: Buffer }>, parents: string[]): { oid: string; objects: Array<{ type: string; data: Buffer }> } {
  const entries = files.map((f) => ({ mode: '100644', name: f.path, oid: hashObject('blob', f.data) }));
  const treeData = buildTree(entries);
  const treeOid = hashObject('tree', treeData);
  const commitData = buildCommit({
    tree: treeOid,
    parents,
    author: `T <t@x> ${stamp()}`,
    committer: `T <t@x> ${stamp()}`,
    message: `c${tick}`,
  });
  const oid = hashObject('commit', commitData);
  const objects: Array<{ type: string; data: Buffer }> = files.map((f) => ({ type: 'blob', data: f.data }));
  objects.push({ type: 'tree', data: treeData });
  objects.push({ type: 'commit', data: commitData });
  return { oid, objects };
}

async function restCreate(name: string): Promise<void> {
  const res = await fetch(`${base}/api/v3/user/repos`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, private: true }),
  });
  if (res.status !== 201) console.log('create', name, res.status);
}

const f = (i: number, rev: number): { path: string; data: Buffer } => ({
  path: `dir${i}/file${i}.txt`,
  data: Buffer.from(`blob ${i} rev ${rev}\n${'x'.repeat(40)}\n`),
});

async function main(): Promise<void> {
  await restCreate(NAME);
  const c1 = commitOf([f(1, 0)], []);
  const pushed = await client.push('adaiversen', NAME, [{ oldOid: '0'.repeat(40), newOid: c1.oid, ref: 'refs/heads/main' }], { objects: c1.objects });
  console.log('push1 ok', pushed.report?.refs?.[0]?.ok === true);

  // 3-commit history: tip c3 over c2 over c1
  const c2 = commitOf([f(2, 0)], [c1.oid]);
  const c3 = commitOf([f(3, 0)], [c2.oid]);
  const all = [...c2.objects, ...c3.objects];
  const pushed3 = await client.push('adaiversen', NAME, [{ oldOid: c1.oid, newOid: c3.oid, ref: 'refs/heads/main' }], { objects: all });
  console.log('push3 ok', pushed3.report?.refs?.[0]?.ok === true);

  // depth-1 clone
  const shallow = await client.clone('adaiversen', NAME, { depth: 1 });
  console.log('shallow: has tip', shallow.objects.has(c3.oid), 'has parent', shallow.objects.has(c2.oid), 'shallow line', shallow.shallow, 'tree ok', (() => {
    const t = parseCommit(shallow.objects.get(c3.oid)?.data ?? Buffer.alloc(0)).tree;
    return shallow.objects.has(t);
  })());

  // deepen 2 from the shallow state
  const deepen = await client.fetch('adaiversen', NAME, { wants: [c3.oid], shallow: [c3.oid], depth: 2, done: true, haveObjects: shallow.objects });
  console.log('deepen: unshallow', deepen.unshallow, 'shallow', deepen.shallow, 'objects', [...deepen.objects.keys()].length, 'has c2', deepen.objects.has(c2.oid));

  // fetch-nothing-new: wants tip, haves tip
  const nothing = await client.fetch('adaiversen', NAME, { wants: [c3.oid], haves: [c3.oid], done: true });
  console.log('nothing-new: pack null', nothing.pack === null, 'bytes', nothing.packBytes, 'objects', nothing.objects.size);

  // fetch-incremental: clone full, push one more commit, fetch with haves of full clone
  const full = await client.clone('adaiversen', NAME, {});
  const c4 = commitOf([f(4, 0)], [c3.oid]);
  const pushed4 = await client.push('adaiversen', NAME, [{ oldOid: c3.oid, newOid: c4.oid, ref: 'refs/heads/main' }], { objects: c4.objects });
  console.log('push4 ok', pushed4.report?.refs?.[0]?.ok === true);
  const incremental = await client.fetch('adaiversen', NAME, { wants: [c4.oid], haves: [c3.oid], done: true, haveObjects: full.objects });
  console.log('incremental: objects', incremental.objects.size, 'has c4', incremental.objects.has(c4.oid), 'bytes', incremental.packBytes);

  // annotated tag
  const tagBody = Buffer.from([`object ${c4.oid}`, 'type commit', `tag v1`, `tagger T <t@x> ${stamp()}`, '', 'release v1'].join('\n') + '\n');
  const tagOid = hashObject('tag', tagBody);
  const pushedTag = await client.push('adaiversen', NAME, [{ oldOid: '0'.repeat(40), newOid: tagOid, ref: 'refs/tags/v1' }], { objects: [{ type: 'tag', data: tagBody }] });
  console.log('tag push ok', pushedTag.report?.refs?.[0]?.ok === true);
  const tagClone = await client.clone('adaiversen', NAME, {});
  const tagRef = tagClone.refs.find((r) => r.name === 'refs/tags/v1');
  console.log('tag cloned', JSON.stringify(tagRef));
}

try {
  await main();
} catch (err) {
  console.error('FAIL', err instanceof Error ? `${err.name}: ${err.message}` : err);
}
