import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { backupNeeds, STALE_HOURS } from '../src/sources/backup.ts';
import { workSource } from '../src/sources/work.ts';
import { buildRollup } from '../src/rollup.ts';
import { ROLLUP_VERSION } from '../src/types.ts';
import { emptyCharter, serializeProject } from '../../../packages/work/model.ts';

const now = Date.parse('2026-11-14T12:00:00Z');
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

test('backup health: never ran, failed and stale each raise one Needs-you item; a fresh good backup raises none', () => {
  assert.match(backupNeeds(null, now)[0].title, /never run/);
  assert.deepEqual(backupNeeds({ at: hoursAgo(5), ok: true, steps: [{ name: 'hermes', result: 'ok' }] }, now), []);
  const failed = backupNeeds({ at: hoursAgo(5), ok: false, steps: [{ name: 'cockpit-db', result: 'ok' }, { name: 'hermes', result: 'failed', detail: 'disk full' }] }, now);
  assert.deepEqual([failed.length, failed[0].severity], [1, 'alert']);
  assert.match(failed[0].title, /hermes \(disk full\)/);
  assert.match(backupNeeds({ at: hoursAgo(STALE_HOURS + 40), ok: true }, now)[0].title, /No backup for 3 days/);
  assert.match(backupNeeds({ at: 'garbage', ok: true }, now)[0].title, /unreadable/);
});

test('backup.sh: every step is recorded, a missing part is skipped not failed, old dated folders go and others stay, big logs are trimmed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-'));
  const kb = join(dir, 'PortfolioKB'), root = join(dir, 'backups'), logs = join(dir, 'logs'), status = join(dir, 'status.json');
  mkdirSync(kb, { recursive: true }); writeFileSync(join(kb, 'note.md'), 'x');
  mkdirSync(join(root, '2020-01-01'), { recursive: true }); mkdirSync(join(root, 'keep-me'), { recursive: true });
  execFileSync('touch', ['-t', '202001010000', join(root, '2020-01-01'), join(root, 'keep-me')]);
  mkdirSync(logs); writeFileSync(join(logs, 'big.log'), 'x'.repeat(6 * 1024 * 1024)); writeFileSync(join(logs, 'small.log'), 'hello');
  const script = resolve(import.meta.dirname, '../../../infra/bin/backup.sh');
  execFileSync('bash', [script], { env: { ...process.env, BACKUP_DIR: root, BACKUP_STATUS: status, PORTFOLIO_KB: kb, HERMES_BIN: join(dir, 'no-hermes'), HERMES_HOME: join(dir, 'no-hermes-home'), PAP_LOGS: logs }, stdio: 'pipe' });
  const s = JSON.parse(readFileSync(status, 'utf8'));
  assert.equal(s.ok, true);
  const by = Object.fromEntries(s.steps.map((x: { name: string; result: string }) => [x.name, x.result]));
  assert.equal(by['portfolio-kb'], 'ok');
  assert.equal(by['hermes-state'], 'skipped');
  assert.deepEqual(backupNeeds(s), []);
  const left = execFileSync('ls', [root], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(left.includes('keep-me') && !left.includes('2020-01-01'));
  assert.deepEqual([readFileSync(join(logs, 'big.log')).length, readFileSync(join(logs, 'big.log.1')).length, readFileSync(join(logs, 'small.log'), 'utf8')], [0, 6 * 1024 * 1024, 'hello']);
});

test('outbox: a ready item whose kind has no handler is shown in Needs-you; with a handler, or unchecked, it is not', async () => {
  const kb = mkdtempSync(join(tmpdir(), 'kb-'));
  mkdirSync(join(kb, 'micropace', 'projects'), { recursive: true });
  mkdirSync(join(kb, 'micropace', 'outbox', 'p1'), { recursive: true });
  const p = { id: 'p1', portfolio: 'micropace', objective: null, key_results: [], status: 'active' as const, owner: 'pm', tenant: 'p1', timebox: '7d', created: '2026-11-01', approved: '2026-11-01', repo: null, priority: 3, test_cmd: null, board: null, plan_sha: null, paused_reason: null, charter: emptyCharter({ outcome: 'x' } as never) };
  writeFileSync(join(kb, 'micropace', 'projects', 'p1.md'), serializeProject(p, '\nbody\n'));
  writeFileSync(join(kb, 'micropace', 'outbox', 'p1', 'o1.json'), JSON.stringify({ id: 'o1', project: 'p1', portfolio: 'micropace', kind: 'deploy', target: 'preview.example.com', summary: 'ship v1', status: 'ready' }));
  const titles = async (handlers?: string[]) => ((await workSource({ kb, portfolios: ['micropace'], ...(handlers ? { outboxHandlers: () => handlers } : {}) })()).needs ?? []).map((n) => n.title);
  assert.match((await titles([]))[0], /no deploy handler is set up/);
  assert.deepEqual(await titles(['deploy']), []);
  assert.deepEqual(await titles(), []);
});

test('rollup carries its shape version', () => {
  assert.equal(buildRollup([], []).schemaVersion, ROLLUP_VERSION);
});

test('the page: no inline script or event handler (the script policy would block them), and only its own files are served', async () => {
  const { createServer } = await import('node:http');
  const { createApp } = await import('../src/app.ts');
  const pub = resolve(import.meta.dirname, '../public');
  const html = readFileSync(join(pub, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline <script>');
  assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, 'no inline event handler in the markup');
  assert.doesNotMatch(readFileSync(join(pub, 'app.js'), 'utf8'), /<[a-z][^>`]*\son(click|change|input|submit|error|load)\s*=/i, 'no inline event handler in generated markup');
  const srv = createServer((q, s) => void createApp({ publicDir: pub, guard: { allowedHosts: [] } } as never)(q, s));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`;
  try {
    const page = await fetch(base + '/');
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    const types = await Promise.all(['/app.js', '/styles.css', '/favicon.svg'].map(async (p) => { const r = await fetch(base + p); return [r.status, r.headers.get('content-type')?.split(';')[0]]; }));
    assert.deepEqual(types, [[200, 'text/javascript'], [200, 'text/css'], [200, 'image/svg+xml']]);
    for (const p of ['/app.ts', '/../src/app.ts', '/%2e%2e/src/server.ts', '/styles.css/../../src/app.ts']) assert.equal((await fetch(base + p)).status, 404, p);
  } finally { srv.close(); }
});

test('portal health: silent while it answers, silent for one failed check (a restart takes a few seconds), then one Needs-you item until it answers again', async () => {
  const { portalHealthSource, FAILS_BEFORE_ALERT } = await import('../src/sources/portalHealth.ts');
  let up = true;
  const fake = (async () => (up ? new Response('ok') : Promise.reject(new Error('ECONNREFUSED')))) as unknown as typeof fetch;
  const check = portalHealthSource('http://127.0.0.1:8888', fake);
  const needs = async () => (await check()).needs ?? [];
  assert.deepEqual(await needs(), []);
  up = false;
  for (let i = 1; i < FAILS_BEFORE_ALERT; i++) assert.deepEqual(await needs(), [], 'one failure is not an alert');
  const down = await needs();
  assert.equal(down.length, 1);
  assert.match(down[0].title, /Utility Portal is not answering at http:\/\/127\.0\.0\.1:8888.*launchctl kickstart/);
  up = true;
  assert.deepEqual(await needs(), [], 'recovers by itself');
  const bad = portalHealthSource('http://127.0.0.1:8888', (async () => new Response('no', { status: 500 })) as unknown as typeof fetch);
  await bad();
  assert.equal(((await bad()).needs ?? []).length, 1, 'an error status counts as down');
});

test('deploy health: a failed deploy and a stopped checker each raise a Needs-you item; a good deploy with a fresh heartbeat raises none', async () => {
  const { deployNeeds, deploySource, HEARTBEAT_STALE_MINUTES } = await import('../src/sources/deploy.ts');
  const good = { target: 'platform', at: 't', ok: true, from: 'aaa111', to: 'bbb222' };
  assert.deepEqual(deployNeeds('platform', good, 3), []);
  const bad = deployNeeds('platform', { ...good, ok: false, message: 'tests failed (3 failing)' }, 3);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].severity, 'alert');
  assert.match(bad[0].title, /Deploy of platform bbb222 failed: tests failed \(3 failing\)\. Prod is still running aaa111/);
  assert.match(deployNeeds('platform', good, null)[0].title, /never run/);
  assert.match(deployNeeds('platform', good, HEARTBEAT_STALE_MINUTES + 15)[0].title, /has not checked platform for 35 minutes/);
  // from files
  const dir = mkdtempSync(join(tmpdir(), 'deploy-'));
  writeFileSync(join(dir, 'deploy-status-platform.json'), JSON.stringify({ ...good, ok: false, message: 'unhealthy after restart' }));
  writeFileSync(join(dir, 'deploy-heartbeat-platform'), '');
  const got = (await deploySource(dir, ['platform', 'utility-portal'])()).needs ?? [];
  assert.deepEqual(got.map((n) => n.title.slice(0, 28)), ['Deploy of platform bbb222 fa', 'Auto-deploy has never run fo']);
});
