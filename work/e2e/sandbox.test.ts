import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTER, BOARD, MARKER, NATIVE_BIN, PROJECT, createSandbox, nativeRunner, profile, refusal, removeSandbox } from './sandbox.ts';

// The feedback-loop sandbox (TEST DATA ONLY): the board adapter's allowlist, the scrubbed environment, the sandbox-exec profile and the
// guarded cleanup. The full run needs macOS sandbox-exec and a Hermes install, so it is `npm run feedback:e2e`, not part of npm test.

const fakeHermes = { agentDir: '/opt/hermes-agent', python: '/opt/hermes/venv/bin/python3' };
function world(env: NodeJS.ProcessEnv = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fb-sbx-')));
  const realHome = join(dir, 'real-hermes');
  mkdirSync(realHome);
  const base = join(dir, 'base');
  mkdirSync(base);
  return { dir, base, realHome, s: createSandbox(base, { env: { FEEDBACK_E2E_REAL_KANBAN_HOME: realHome, ...env }, hermes: fakeHermes }) };
}
const create = (...extra: string[]) => ['kanban', '--board', BOARD, 'create', '--json', '--tenant', PROJECT, '--idempotency-key', `project:${PROJECT}:k1`, ...extra, '--', `[${PROJECT}] title`];

test('the adapter allows only the sandbox board, the converter\'s actions, and tasks of the sandbox project', () => {
  const s = { board: BOARD, project: PROJECT };
  assert.equal(refusal(s, NATIVE_BIN, ['kanban', 'boards', 'create', BOARD]), null);
  assert.equal(refusal(s, NATIVE_BIN, ['kanban', '--board', BOARD, 'list', '--tenant', PROJECT, '--json']), null);
  assert.equal(refusal(s, NATIVE_BIN, ['kanban', '--board', BOARD, 'show', '--json', 't_1']), null);
  assert.equal(refusal(s, NATIVE_BIN, create()), null);
  const refused: Array<[string, string[]]> = [
    ['hermes', ['kanban', '--board', BOARD, 'list']],
    ['git', ['status']],
    [NATIVE_BIN, ['kanban', 'boards', 'create', 'micropace-labs']],
    [NATIVE_BIN, ['kanban', 'boards', 'rm', BOARD]],
    [NATIVE_BIN, ['kanban', '--board', 'micropace-labs', 'list', '--json']],
    [NATIVE_BIN, ['kanban', 'list', '--json']],
    [NATIVE_BIN, ['kanban', '--board', BOARD, 'complete', 't_1']],
    [NATIVE_BIN, ['kanban', '--board', BOARD, 'dispatch']],
    [NATIVE_BIN, ['kanban', '--board', BOARD, 'list', '--tenant', 'cockpit-improvement']],
    [NATIVE_BIN, create('--workspace', '/Users/someone/codes/x')],
    [NATIVE_BIN, create().map((a) => (a === PROJECT ? 'cockpit-improvement' : a))],
    [NATIVE_BIN, create().map((a) => (a.startsWith('project:') ? 'project:other:k1' : a))],
    [NATIVE_BIN, create().map((a) => (a.startsWith('[') ? 'untagged title' : a))],
  ];
  for (const [cmd, args] of refused) assert.ok(refusal(s, cmd, args), `${cmd} ${args.join(' ')} must be refused`);
});

test('a refused call never runs and is recorded; an allowed one runs Hermes\' handler through the adapter with the sandbox env only', () => {
  const { s } = world();
  const seen: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const exec = ((file: string, args: string[], o: { env: NodeJS.ProcessEnv }) => { seen.push({ file, args, env: o.env }); return '[]'; }) as never;
  const run = nativeRunner(s, exec);
  assert.throws(() => run(NATIVE_BIN, ['kanban', '--board', 'micropace-labs', 'list']), /sandbox adapter refused/);
  assert.equal(seen.length, 0);
  assert.equal(run(NATIVE_BIN, ['kanban', '--board', BOARD, 'list', '--json']), '[]');
  assert.equal(seen[0].file, fakeHermes.python);
  assert.deepEqual(seen[0].args, ['-I', '-B', ADAPTER, '--board', BOARD, 'list', '--json']);
  assert.equal(seen[0].env, s.env);
  assert.deepEqual(s.calls.map((c) => c.ok), [false, true]);
});

test('the sandbox is labelled, synthetic, and its environment inherits no credential or real path; a worker fence travels unchanged', () => {
  const { s, realHome } = world({ TELEGRAM_BOT_TOKEN: 'x', ANTHROPIC_API_KEY: 'x', HERMES_KANBAN_DB: '/real/kanban.db', HERMES_KANBAN_TASK: 't_1', PAP_DATA_DIR: '/real/data', HERMES_DELEGATED_CHILD_CONTEXT: '/real/hermes' });
  assert.ok(existsSync(join(s.root, MARKER)));
  assert.match(s.root, /\/TEST-feedback-e2e-[A-Za-z0-9]+$/);
  for (const k of ['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'HERMES_KANBAN_DB', 'HERMES_KANBAN_TASK']) assert.equal(s.env[k], undefined, k);
  assert.equal(s.env.HERMES_DELEGATED_CHILD_CONTEXT, '/real/hermes');
  assert.equal(s.env.PAP_DATA_DIR, s.data);
  assert.equal(s.env.FEEDBACK_DIR, s.data);
  assert.equal(s.env.HERMES_KANBAN_HOME, s.hermesHome);
  assert.equal(s.env.FEEDBACK_WEEKLY, '0');
  assert.equal(s.env.FEEDBACK_E2E_REAL_KANBAN_HOME, realHome);
  for (const [k, v] of Object.entries(s.env)) if (typeof v === 'string' && v.startsWith('/') && !['HERMES_AGENT_DIR', 'HERMES_PYTHON', 'KB_TEMPLATE', 'FEEDBACK_E2E_REAL_KANBAN_HOME', 'HERMES_DELEGATED_CHILD_CONTEXT', 'PATH'].includes(k)) assert.ok(v.startsWith(s.root), `${k}=${v} is outside the sandbox`);
  assert.deepEqual(JSON.parse(readFileSync(join(s.root, 'cockpit.json'), 'utf8')).boards, { [BOARD]: 'micropace' });
  assert.deepEqual(JSON.parse(readFileSync(join(s.root, 'outbox.json'), 'utf8')), { handlers: {} });
});

test('a sandbox inside the real kanban home is refused (a QA worker\'s TMPDIR can be there)', () => {
  const { realHome } = world();
  mkdirSync(join(realHome, 'kanban', 'boards', 'x', 'workspaces'), { recursive: true });
  assert.throws(() => createSandbox(join(realHome, 'kanban', 'boards', 'x', 'workspaces'), { env: { FEEDBACK_E2E_REAL_KANBAN_HOME: realHome }, hermes: fakeHermes }), /overlaps the real kanban home/);
});

test('the sandbox-exec profile: loopback-only network, writes only in the sandbox, no platform data or secrets, node and Hermes Python only', () => {
  const { s } = world();
  const sb = profile(s, { home: '/Users/someone', repo: '/Users/someone/codes/pap', node: '/usr/local/bin/node' });
  assert.match(sb, /\(deny network-outbound\)\n\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
  assert.match(sb, new RegExp(`\\(deny file-write\\*\\)\\n\\(allow file-write\\* \\(subpath "${s.root}"\\) \\(subpath "/dev"\\)\\)`));
  assert.match(sb, /\(deny file-read-data \(subpath "\/Users\/someone"\)/);
  assert.match(sb, /\(deny file-read-data \(subpath "\/Users\/someone\/codes\/pap\/data"\) \(literal "\/Users\/someone\/codes\/pap\/infra\/env"\)/);
  assert.match(sb, /\(deny process-exec\)\n\(allow process-exec \(literal "\/usr\/local\/bin\/node"\).*\(literal "\/opt\/hermes\/venv\/bin\/python3"\)/);
  assert.throws(() => profile({ ...s, root: '/tmp/a") (allow default' }), /unsafe path/);
});

test('cleanup deletes only a marked sandbox directly under its base', () => {
  const { s, base, dir } = world();
  const stray = join(base, 'TEST-feedback-e2e-nomarker');
  mkdirSync(stray);
  assert.throws(() => removeSandbox(stray, base), /refusing/);
  assert.throws(() => removeSandbox(s.root, dir), /refusing/);
  assert.throws(() => removeSandbox(base, dir), /refusing/);
  writeFileSync(join(dir, MARKER), 'x');
  assert.throws(() => removeSandbox(dir, tmpdir()), /refusing/);
  removeSandbox(s.root, base);
  assert.equal(existsSync(s.root), false);
  assert.ok(existsSync(stray));
});

test('the Python adapter refuses on its own, before importing Hermes: wrong board, wrong action, unmarked root, real board pinned', (t) => {
  if (spawnSync('python3', ['-c', '0']).status !== 0) return t.skip('no python3');
  const { s, realHome } = world();
  const py = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync('python3', ['-I', '-B', ADAPTER, ...args], { env: { ...s.env, HERMES_AGENT_DIR: '/nonexistent', ...env }, encoding: 'utf8' });
  const cases: Array<[string[], NodeJS.ProcessEnv, RegExp]> = [
    [['--board', 'micropace-labs', 'list'], {}, /only `boards create/],
    [['--board', BOARD, 'complete', 't_1'], {}, /only `boards create/],
    [['boards', 'create', 'other'], {}, /only `boards create/],
    [['--board', BOARD, 'list'], { HERMES_KANBAN_DB: '/real/kanban.db' }, /HERMES_KANBAN_DB is set/],
    [['--board', BOARD, 'list'], { FEEDBACK_E2E_ROOT: realHome }, /no TEST-DATA-ONLY marker/],
    [['--board', BOARD, 'list'], { HERMES_KANBAN_HOME: realHome, HERMES_HOME: realHome }, /must both be <root>\/hermes/],
    [['--board', BOARD, 'list'], { FEEDBACK_E2E_REAL_KANBAN_HOME: s.root }, /overlaps the real one/],
  ];
  for (const [args, env, why] of cases) {
    const r = py(args, env);
    assert.equal(r.status, 97, `${args.join(' ')} ${JSON.stringify(env)}: ${r.stderr}`);
    assert.match(r.stderr, why);
  }
});
