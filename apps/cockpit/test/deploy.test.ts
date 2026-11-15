import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// deploy.sh against a real (temporary) git origin and prod clone. Only the service restart, the health check and the project's own
// verification command are stubbed; the git work, the scratch copy, the status files and the hook are the real thing.

const REAL = resolve(import.meta.dirname, '../../..');
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', [...GIT, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const lines = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : []);

function world() {
  const t = mkdtempSync(join(tmpdir(), 'deploy-'));
  const origin = join(t, 'origin.git'), work = join(t, 'work'), prod = join(t, 'services', 'personal-agent-platform'), data = join(t, 'data');
  mkdirSync(data); mkdirSync(join(t, 'services'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  git(work, 'checkout', '-q', '-b', 'main');
  for (const f of ['infra/bin/deploy.sh', '.githooks/post-merge']) { mkdirSync(join(work, f, '..'), { recursive: true }); copyFileSync(join(REAL, f), join(work, f)); chmodSync(join(work, f), 0o755); }
  mkdirSync(join(work, 'apps')); mkdirSync(join(work, 'docs'));
  writeFileSync(join(work, 'apps/x.ts'), 'v1\n'); writeFileSync(join(work, 'docs/a.md'), 'doc\n');
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'v1'); git(work, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', '--branch', 'main', origin, prod]);
  writeFileSync(join(prod, '.pap-prod'), '');
  git(prod, 'config', 'core.hooksPath', '.githooks');
  const log = { restarts: join(t, 'restarts.log'), verify: join(t, 'verify.log'), reload: join(t, 'reload.log'), sick: join(t, 'sick.flag') };
  const stub = join(t, 'restart.sh');
  writeFileSync(stub, `#!/bin/sh\necho "$1" >> ${log.restarts}\n`); chmodSync(stub, 0o755);
  const env = {
    ...process.env, PAP_DATA_DIR: data, DEPLOY_RESTART_CMD: stub, DEPLOY_RELOAD_CMD: `echo reload >> ${log.reload}`,
    DEPLOY_VERIFY_CMD: `echo run >> ${log.verify}; ! grep -q BREAK apps/x.ts`, DEPLOY_HEALTH_CMD: `test ! -f ${log.sick}`, DEPLOY_HEALTH_TRIES: '2', DEPLOY_HEALTH_SLEEP: '0',
  };
  const deploy = (...args: string[]) => spawnSync('bash', [join(prod, 'infra/bin/deploy.sh'), ...args], { env, encoding: 'utf8', cwd: prod });
  const push = (msg: string, files: Record<string, string>) => { for (const [f, c] of Object.entries(files)) { mkdirSync(join(work, f, '..'), { recursive: true }); writeFileSync(join(work, f), c); } git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', msg); git(work, 'push', '-q', 'origin', 'main'); };
  const status = () => JSON.parse(readFileSync(join(data, 'deploy-status-platform.json'), 'utf8')) as { ok: boolean; from: string; to: string; message: string; failedSha: string | null };
  const head = () => git(prod, 'rev-parse', '--short', 'HEAD');
  return { t, prod, work, data, log, env, deploy, push, status, head };
}

test('deploy: nothing new does nothing but proves the checker ran; a code change is checked, switched to and restarted', () => {
  const w = world();
  const first = w.deploy('platform');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(existsSync(join(w.data, 'deploy-status-platform.json')), false, 'no change, no status');
  assert.equal(existsSync(join(w.data, 'deploy-heartbeat-platform')), true, 'heartbeat touched');
  assert.deepEqual(lines(w.log.restarts), []);

  const before = w.head();
  w.push('v2', { 'apps/x.ts': 'v2\n' });
  const r = w.deploy('platform');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.notEqual(w.head(), before);
  assert.equal(readFileSync(join(w.prod, 'apps/x.ts'), 'utf8'), 'v2\n');
  assert.deepEqual(lines(w.log.restarts), ['com.franktao.pap.cockpit', 'com.franktao.pap.private-pipeline']);
  assert.deepEqual(lines(w.log.verify), ['run'], 'checked once, in the scratch copy');
  assert.deepEqual([w.status().ok, w.status().from, w.status().to, w.status().failedSha], [true, before, w.head(), null]);
  assert.equal(existsSync(join(w.t, 'services', '.staging-platform')), false, 'scratch copy removed');
  assert.equal(git(w.prod, 'worktree', 'list').split('\n').length, 1, 'no leftover worktree');
});

test('deploy: a documentation-only change is deployed without a restart', () => {
  const w = world();
  w.push('docs', { 'docs/a.md': 'changed\n' });
  assert.equal(w.deploy('platform').status, 0);
  assert.equal(readFileSync(join(w.prod, 'docs/a.md'), 'utf8'), 'changed\n');
  assert.deepEqual(lines(w.log.restarts), []);
  assert.match(w.status().message, /no restart needed/);
});

test('deploy: a commit that fails its checks never reaches prod, is not retried until main moves on, and a fix goes through', () => {
  const w = world();
  const good = w.head();
  w.push('broken', { 'apps/x.ts': 'BREAK\n' });
  const bad = w.deploy('platform');
  assert.equal(bad.status, 1);
  assert.equal(w.head(), good, 'prod untouched');
  assert.equal(readFileSync(join(w.prod, 'apps/x.ts'), 'utf8'), 'v1\n', 'the live files were never changed');
  assert.deepEqual(lines(w.log.restarts), []);
  const failed = w.status();
  assert.equal(failed.ok, false);
  assert.match(failed.message, /verification failed/);
  assert.ok(failed.failedSha);

  assert.equal(w.deploy('platform', '--quiet').status, 0);                      // same commit: skipped
  assert.equal(lines(w.log.verify).length, 1, 'not checked again');
  assert.equal(w.deploy('platform', '--force').status, 1);                      // --force checks again
  assert.equal(lines(w.log.verify).length, 2);

  w.push('fix', { 'apps/x.ts': 'v3\n' });
  assert.equal(w.deploy('platform').status, 0);
  assert.equal(readFileSync(join(w.prod, 'apps/x.ts'), 'utf8'), 'v3\n');
  assert.deepEqual([w.status().ok, w.status().failedSha], [true, null]);
});

test('deploy: local changes in the prod clone, or commits that are not on main, stop the deploy with a reason', () => {
  const w = world();
  w.push('v2', { 'apps/x.ts': 'v2\n' });
  writeFileSync(join(w.prod, 'apps/x.ts'), 'edited by hand\n');
  assert.equal(w.deploy('platform').status, 1);
  assert.match(w.status().message, /local changes/);
  assert.equal(readFileSync(join(w.prod, 'apps/x.ts'), 'utf8'), 'edited by hand\n', 'never discarded');
  git(w.prod, 'checkout', '--', 'apps/x.ts');
  writeFileSync(join(w.prod, 'extra.txt'), 'x'); git(w.prod, 'add', '-A'); git(w.prod, 'commit', '-q', '-m', 'only in prod');
  assert.equal(w.deploy('platform', '--force').status, 1);
  assert.match(w.status().message, /not on main|cannot be fast-forwarded/);
});

test('deploy: a service that does not answer after the restart is rolled back to the previous version', () => {
  const w = world();
  const before = w.head();
  w.push('v2', { 'apps/x.ts': 'v2\n' });
  writeFileSync(w.log.sick, '');
  const r = w.deploy('platform');
  assert.equal(r.status, 1);
  assert.equal(w.head(), before, 'previous version restored');
  assert.equal(readFileSync(join(w.prod, 'apps/x.ts'), 'utf8'), 'v1\n');
  assert.equal(lines(w.log.restarts).length, 4, 'restarted for the new version and again for the old one');
  assert.match(w.status().message, /did not answer.*rolled back/);
  assert.equal(w.status().ok, false);
});

test('deploy: a changed launchd job definition reloads the jobs instead of kickstarting two', () => {
  const w = world();
  w.push('job', { 'infra/launchd/com.franktao.pap.cockpit.plist.tmpl': '<plist/>\n' });
  assert.equal(w.deploy('platform').status, 0);
  assert.deepEqual(lines(w.log.reload), ['reload']);
  assert.deepEqual(lines(w.log.restarts), []);
});

test('git hook: a manual pull in the prod clone deploys; a broken pull is undone; the same hook is silent in a working copy', () => {
  const w = world();
  const env = { ...w.env };
  const pull = () => spawnSync('git', [...GIT, 'pull', '-q', '--ff-only'], { cwd: w.prod, env, encoding: 'utf8' });
  const good = w.head();
  w.push('broken', { 'apps/x.ts': 'BREAK\n' });
  pull();
  assert.equal(w.head(), good, 'checked after the merge and put back');
  assert.equal(readFileSync(join(w.prod, 'apps/x.ts'), 'utf8'), 'v1\n');
  assert.equal(w.status().ok, false);
  w.push('fix', { 'apps/x.ts': 'v3\n' });
  pull();
  assert.equal(readFileSync(join(w.prod, 'apps/x.ts'), 'utf8'), 'v3\n');
  assert.equal(w.status().ok, true);
  assert.deepEqual(lines(w.log.restarts), ['com.franktao.pap.cockpit', 'com.franktao.pap.private-pipeline']);

  // a dev working copy has no .pap-prod: the hook does nothing at all
  const dev = join(w.t, 'dev');
  execFileSync('git', ['clone', '-q', '--branch', 'main', join(w.t, 'origin.git'), dev]);
  git(dev, 'config', 'core.hooksPath', '.githooks');
  git(dev, 'reset', '-q', '--hard', 'HEAD~1');
  const restartsBefore = lines(w.log.restarts).length;
  spawnSync('git', [...GIT, 'pull', '-q', '--ff-only'], { cwd: dev, env, encoding: 'utf8' });
  assert.equal(lines(w.log.restarts).length, restartsBefore);
  assert.equal(readFileSync(join(dev, 'apps/x.ts'), 'utf8'), 'v3\n');
});

test('deploy: refuses a directory that is not marked as a prod clone', () => {
  const w = world();
  execFileSync('rm', [join(w.prod, '.pap-prod')]);
  w.push('v2', { 'apps/x.ts': 'v2\n' });
  const r = w.deploy('platform');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not a prod clone/);
  assert.equal(readFileSync(join(w.prod, 'apps/x.ts'), 'utf8'), 'v1\n');
});
