// Repro of push-100-files: one commit with 100 files, push, clone, compare.
import { GitClient, buildCommit, buildTree, hashObject, parseTree } from '/root/makefun/github-core-clone-01-kit/sdk/conformance/git-client.ts';

const base = process.argv[2];
const token = 'tok123';
const client = new GitClient({ baseUrl: base, token, timeoutMs: 20_000 });
const NAME = process.argv[3] ?? 'manyfiles1';

const entries: Array<{ mode: string; name: string; oid: string }> = [];
const objects: Array<{ type: string; data: Buffer }> = [];
// 100 files across nested dirs: dir{i%5}/file{i}.txt
for (let i = 0; i < 100; i += 1) {
  const data = Buffer.from(`file ${i}\n${'y'.repeat(30 + i)}\n`);
  const oid = hashObject('blob', data);
  objects.push({ type: 'blob', data });
  entries.push({ mode: '100644', name: `dir${i % 5}/file${i}.txt`, oid });
}
console.log('flat entries naive not nested — building nested trees');

function buildNested(files: Array<{ path: string; oid: string }>): { treeOid: string; extra: Array<{ type: string; data: Buffer }> } {
  const dirs = new Map<string, Array<{ path: string; oid: string }>>();
  for (const f of files) {
    const idx = f.path.indexOf('/');
    const dir = f.path.slice(0, idx);
    const rest = f.path.slice(idx + 1);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push({ path: rest, oid: f.oid });
  }
  const treeEntries: Array<{ mode: string; name: string; oid: string }> = [];
  const extra: Array<{ type: string; data: Buffer }> = [];
  for (const [dir, kids] of dirs) {
    const sub = buildTree(kids.map((k) => ({ mode: '100644', name: k.path, oid: k.oid })));
    const subOid = hashObject('tree', sub);
    extra.push({ type: 'tree', data: sub });
    treeEntries.push({ mode: '40000', name: dir, oid: subOid });
  }
  const root = buildTree(treeEntries);
  const rootOid = hashObject('tree', root);
  extra.push({ type: 'tree', data: root });
  return { treeOid: rootOid, extra };
}

const nested = buildNested(entries.map((e) => ({ path: e.name, oid: e.oid })));
objects.push(...nested.extra);
const commitData = buildCommit({
  tree: nested.treeOid,
  parents: [],
  author: 'T <t@x> 1735689610 +0000',
  committer: 'T <t@x> 1735689610 +0000',
  message: 'many files',
});
const tip = hashObject('commit', commitData);
objects.push({ type: 'commit', data: commitData });

await fetch(`${base}/api/v3/user/repos`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ name: NAME, private: true }),
});

const pushed = await client.push('adaiversen', NAME, [{ oldOid: '0'.repeat(40), newOid: tip, ref: 'refs/heads/main' }], { objects });
console.log('push unpackOk', pushed.report?.unpackOk, 'detail', JSON.stringify(pushed.report?.unpackDetail), 'refs', JSON.stringify(pushed.report?.refs));

const clone = await client.clone('adaiversen', NAME, {});
console.log('clone objects', clone.objects.size, 'has tip', clone.objects.has(tip));
const missing: string[] = [];
for (const o of objects) if (!clone.objects.has(hashObject(o.type as 'blob' | 'tree' | 'commit', o.data))) missing.push(o.type);
console.log('missing', missing.length);
const commit = clone.objects.get(tip);
if (commit) {
  const tree = /^tree ([0-9a-f]{40})/m.exec(commit.data.toString('utf8'))?.[1] ?? '';
  console.log('tree ok', tree === nested.treeOid, 'tree present', clone.objects.has(tree));
  const rootObj = clone.objects.get(tree);
  if (rootObj) console.log('root entries', parseTree(rootObj.data).length);
}
