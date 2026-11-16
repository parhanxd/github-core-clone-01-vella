// Run the kit's real git.push-100-files check body against the running forge.
import { GIT_CHECKS as gitChecks } from '/root/makefun/github-core-clone-01-kit/sdk/conformance/checks-git.ts';
import { buildScenario } from '/root/workspace/entry-vella/wire.ts';

const base = process.argv[2];
const checks = gitChecks;
const spec = checks.find((c) => c.id === 'git.push-100-files' || c.id.endsWith('push-100-files'));
console.log('spec', spec?.id, spec?.title);
const scenario = buildScenario('trial');
const ctx = {
  baseUrl: base,
  token: 'tok123',
  scenario,
  signal: new AbortController().signal,
  deadlineMs: Number.MAX_SAFE_INTEGER,
  timeoutMs: 15000,
  log: (m: string) => console.log('[log]', m),
};
try {
  const result = await spec!.fn(ctx as never);
  console.log('RESULT', JSON.stringify(result));
} catch (err) {
  console.log('THREW', err instanceof Error ? `${err.name}: ${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}` : err);
}
