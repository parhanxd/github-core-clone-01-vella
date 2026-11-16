// Smoke test: drive the forge with the kit's own GitClient.
import { GitClient } from '/root/makefun/github-core-clone-01-kit/sdk/conformance/git-client.ts';
import { buildCommit, buildTree, hashObject } from '/root/makefun/github-core-clone-01-kit/sdk/conformance/git-client.ts';

const base = process.argv[2];
const token = 'tok123';
const client = new GitClient({ baseUrl: base, token, timeoutMs: 10_000 });

async function restCreate(name: string): Promise<void> {
  const res = await fetch(`${base}/api/v3/user/repos`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, private: true }),
  });
  console.log('create repo', name, res.status, await res.text());
}

async function main(): Promise<void> {
  await restCreate('gittest9');
  // advert checks
  const adv = await client.advertisement('adaiversen', 'gittest9', 'git-upload-pack', { gitProtocol: 2 });
  console.log('v2 adv caps', [...adv.capabilities.keys()]);
  const adv0 = await client.advertisement('adaiversen', 'gittest9', 'git-upload-pack', { gitProtocol: 0 });
  console.log('v0 adv caps', [...adv0.capabilities.keys()], 'refs', (adv0.refs ?? []).map((r) => r.name));
  const radv = await client.advertisement('adaiversen', 'gittest9', 'git-receive-pack', {});
  console.log('recv adv caps', [...radv.capabilities.keys()]);
  const ls = await client.lsRefs('adaiversen', 'gittest9', { prefixes: ['refs/heads/'] });
  console.log('lsrefs unborn head', ls.rawRefs);

  // build a commit client-side and push
  const blob = { type: 'blob', data: Buffer.from('hello blob\n') };
  const blobOid = hashObject('blob', blob.data);
  const treeObj = buildTree([{ mode: '100644', name: 'a.txt', oid: blobOid }]);
  const treeOid = hashObject('tree', treeObj);
  const commit = buildCommit({
    tree: treeOid,
    parents: [],
    author: 'Test <t@example.invalid> 1735689600 +0000',
    committer: 'Test <t@example.invalid> 1735689600 +0000',
    message: 'first commit',
  });
  const commitOid = hashObject('commit', commit);
  console.log('local oids', blobOid, treeOid, commitOid);
  const objects = [
    { type: 'blob', data: blob.data },
    { type: 'tree', data: treeObj },
    { type: 'commit', data: commit },
  ];
  const push = await client.push('adaiversen', 'gittest9', [{ oldOid: '0'.repeat(40), newOid: commitOid, ref: 'refs/heads/main' }], { objects });
  console.log('push report', JSON.stringify(push.report?.refs?.map((r) => ({ ref: r.ref, ok: r.ok, reason: r.reason }))), 'unpack', push.report?.unpackOk, push.report?.unpackDetail);

  const ls2 = await client.lsRefs('adaiversen', 'gittest9', {});
  console.log('post-push lsrefs', JSON.stringify(ls2.rawRefs), 'head', ls2.headSymref);
  // clone full
  const clone = await client.clone('adaiversen', 'gittest9', {});
  console.log('clone refs', JSON.stringify(clone.refs));
  console.log('clone objects', clone.objects?.size, 'checksumOk', clone.checksumOk, 'head', clone.headOid ?? '(see refs)');
  // shallow depth 1
  const shallow = await client.fetch('adaiversen', 'gittest9', { wants: [commitOid], depth: 1, done: true });
  console.log('shallow', shallow.shallow, 'unshallow', shallow.unshallow, 'objects', shallow.objects?.size, 'pack', shallow.packBytes);
  // incremental fetch nothing new
  const nothing = await client.fetch('adaiversen', 'gittest9', { wants: [commitOid], haves: [commitOid], done: true });
  console.log('nothing-new packBytes', nothing.packBytes, 'nak', nothing.nak);
  // 404 unknown repo
  try {
    await client.advertisement('adaiversen', 'nope', 'git-upload-pack', { gitProtocol: 2 });
    console.log('unknown repo: advertised (BAD)');
  } catch (err) {
    console.log('unknown repo 404:', err instanceof Error ? err.message.slice(0, 80) : err);
  }
}

try {
  await main();
} catch (err) {
  console.error('FAIL', err);
  process.exit(1);
}
