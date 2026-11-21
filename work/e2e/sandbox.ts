import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Ctx } from '../shared.ts';

// The disposable world for the feedback-loop end-to-end check (feedback-loop.ts). TEST DATA ONLY.
//
// One fresh folder holds everything the run may touch: synthetic configs, an empty KB, an empty feedback store, and a Hermes kanban
// home with ONE board. Hermes' dispatcher only polls boards under its own kanban home (kanban_home() / "kanban" / "boards"), so a
// board here is never dispatched; the worker write fence guards that real root, and this one is outside it, so nothing is bypassed.
// The run itself executes under macOS sandbox-exec (profile() below): writes only inside the folder, no reads of real Hermes or
// platform data, network only on loopback, and only node and the Hermes Python may be executed.

export const BOARD = 'feedback-e2e-sandbox';
export const PROJECT = 'e2e-feedback-test';
export const LABEL = '[TEST DATA ONLY]';
/** What HERMES_BIN is set to inside the sandbox: not a program, a name only nativeRunner answers to. */
export const NATIVE_BIN = 'hermes-native-sandbox';
export const MARKER = 'TEST-DATA-ONLY';
export const ACTIONS = new Set(['list', 'show', 'create', 'edit', 'link', 'block']);
export const ADAPTER = join(import.meta.dirname, 'hermes_native.py');
export const REPO = resolve(import.meta.dirname, '..', '..');

export interface Sandbox {
  root: string; board: string; project: string;
  hermesHome: string; data: string; kb: string; evidence: string;
  realKanbanHome: string; python: string; agentDir: string;
  env: NodeJS.ProcessEnv;
  /** Every board call the converter made, with the adapter's verdict: the audit trail for the report. */
  calls: Array<{ args: string[]; ok: boolean; error?: string }>;
}

const inside = (child: string, parent: string) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** The kanban home the real dispatcher polls: HERMES_KANBAN_HOME, else the default Hermes root (~/.hermes), as kanban_home() does. */
export function realKanbanHome(env: NodeJS.ProcessEnv = process.env): string {
  return real(env.FEEDBACK_E2E_REAL_KANBAN_HOME || env.HERMES_KANBAN_HOME || join(homedir(), '.hermes'));
}

/** Hermes' own source and the Python it runs on, read-only. HERMES_AGENT_DIR / HERMES_PYTHON override; else the newest installed venv. */
export function findHermes(env: NodeJS.ProcessEnv = process.env): { agentDir: string; python: string } {
  const agentDir = real(env.HERMES_AGENT_DIR || join(homedir(), '.hermes', 'hermes-agent'));
  if (!existsSync(join(agentDir, 'hermes_cli', 'kanban.py'))) throw new Error(`no Hermes source at ${agentDir} (set HERMES_AGENT_DIR)`);
  if (env.HERMES_PYTHON) return { agentDir, python: env.HERMES_PYTHON };
  const installs = join(homedir(), '.hermes', 'installs');
  const found: Array<{ p: string; t: number }> = [];
  for (const i of existsSync(installs) ? readdirSync(installs) : []) {
    const envs = join(installs, i, 'environments');
    for (const e of existsSync(envs) ? readdirSync(envs) : []) {
      const p = join(envs, e, 'venv', 'bin', 'python3');
      if (existsSync(p)) found.push({ p, t: statSync(p).mtimeMs });
    }
  }
  if (!found.length) throw new Error('no Hermes Python found under ~/.hermes/installs (set HERMES_PYTHON)');
  return { agentDir, python: found.sort((a, b) => b.t - a.t)[0].p };
}

/** A base folder for the sandbox that is outside the real kanban home (a QA worker's TMPDIR can sit inside ~/.hermes). */
export function defaultBase(realHome: string): string {
  for (const b of [tmpdir(), '/tmp']) { const r = real(b); if (!inside(r, realHome) && !inside(realHome, r)) return r; }
  throw new Error('no temporary folder outside the real kanban home; pass --base');
}

/** Make a fresh, labelled sandbox under `base` with synthetic configs only. Nothing is copied from the real platform data. */
export function createSandbox(base: string, opts: { env?: NodeJS.ProcessEnv; hermes?: { agentDir: string; python: string } } = {}): Sandbox {
  const env0 = opts.env ?? process.env;
  const realHome = realKanbanHome(env0);
  const b = real(base);
  if (inside(b, realHome) || inside(realHome, b)) throw new Error(`base ${b} overlaps the real kanban home ${realHome}`);
  const root = real(mkdtempSync(join(b, 'TEST-feedback-e2e-')));
  writeFileSync(join(root, MARKER), `${LABEL} disposable feedback-loop sandbox; safe to delete. Created ${new Date().toISOString()}\n`);
  const p = (...s: string[]) => join(root, ...s);
  for (const d of ['home', 'tmp', 'data', 'kb', 'codes', 'evidence', 'catalog/marketing', 'hermes/kanban/boards']) mkdirSync(p(d), { recursive: true });
  // Inert profile folders: `work` only checks that an owner's profile exists. No config, credentials or memory in them.
  for (const a of ['pm', 'coding', 'qa']) mkdirSync(p('hermes', 'profiles', a), { recursive: true });
  const agent = (id: string) => ({ id, profile: id, name: id, role: `${id} (sandbox stub)`, managed: false, lanes: [], portfolios: ['micropace'] });
  writeFileSync(p('catalog', 'divisions.json'), JSON.stringify({ divisions: { marketing: {} } }));
  writeFileSync(p('agents.json'), JSON.stringify({ catalog: { repo: 'sandbox', commit: 'sandbox', dir: p('catalog') }, agents: ['pm', 'coding', 'qa'].map(agent) }, null, 2));
  writeFileSync(p('cockpit.json'), JSON.stringify({ boards: { [BOARD]: 'micropace' } }, null, 2));
  writeFileSync(p('projects.json'), JSON.stringify({ repos: {} }));
  writeFileSync(p('outbox.json'), JSON.stringify({ handlers: {} }));
  const hermes = opts.hermes ?? findHermes(env0);
  const s: Sandbox = {
    root, board: BOARD, project: PROJECT, hermesHome: p('hermes'), data: p('data'), kb: p('kb'), evidence: p('evidence'),
    realKanbanHome: realHome, python: hermes.python, agentDir: hermes.agentDir, env: {}, calls: [],
  };
  s.env = sandboxEnv(s, env0);
  return s;
}

/** The whole environment of the sandboxed run: built from nothing, so no token, key or real path is inherited. */
export function sandboxEnv(s: Sandbox, inherit: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const p = (...x: string[]) => join(s.root, ...x);
  return {
    PATH: '/usr/bin:/bin', HOME: p('home'), TMPDIR: p('tmp'), LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1',
    HERMES_HOME: s.hermesHome, HERMES_KANBAN_HOME: s.hermesHome, HERMES_BIN: NATIVE_BIN, HERMES_AGENT_DIR: s.agentDir, HERMES_PYTHON: s.python,
    PAP_ENV: 'dev', PAP_DATA_DIR: s.data, FEEDBACK_DIR: s.data, FEEDBACK_WEEKLY: '0', PORTFOLIO_KB: s.kb, CODES_DIR: p('codes'),
    COCKPIT_LAYOUT: p('cockpit.json'), AGENTS_REGISTRY: p('agents.json'), PROJECTS_CONFIG: p('projects.json'), OUTBOX_CONFIG: p('outbox.json'),
    KB_TEMPLATE: join(REPO, 'kb-template'), WORK_SHOW_CACHE: p('data', 'work-show-cache.json'),
    FEEDBACK_E2E_ROOT: s.root, FEEDBACK_E2E_BOARD: s.board, FEEDBACK_E2E_REAL_KANBAN_HOME: s.realKanbanHome,
    // A worker's write fence travels with it unchanged; it covers the real board root, which this run never writes.
    ...(inherit.HERMES_DELEGATED_CHILD_CONTEXT ? { HERMES_DELEGATED_CHILD_CONTEXT: inherit.HERMES_DELEGATED_CHILD_CONTEXT } : {}),
  };
}

/** Why the converter may not make this board call; null when it is allowed. The Python adapter repeats these checks. */
export function refusal(s: Pick<Sandbox, 'board' | 'project'>, cmd: string, args: string[]): string | null {
  if (cmd !== NATIVE_BIN) return `only the sandbox board adapter may run here, not "${cmd}"`;
  if (args[0] !== 'kanban') return 'only kanban calls are allowed';
  if (args[1] === 'boards') return args.length === 4 && args[2] === 'create' && args[3] === s.board ? null : `only "boards create ${s.board}" is allowed`;
  if (args[1] !== '--board' || args[2] !== s.board) return `only board "${s.board}" is allowed, got "${args[2] ?? ''}"`;
  const action = args[3];
  if (!ACTIONS.has(action)) return `"${action}" is not one of ${[...ACTIONS].join(', ')}`;
  const val = (f: string) => { const i = args.indexOf(f); return i === -1 ? undefined : args[i + 1]; };
  if ((action === 'list' || action === 'create') && val('--tenant') !== undefined && val('--tenant') !== s.project) return `tenant must be "${s.project}"`;
  if (action === 'create') {
    if (val('--tenant') !== s.project) return `a task must be created in tenant "${s.project}"`;
    if (!(val('--idempotency-key') ?? '').startsWith(`project:${s.project}:`)) return 'a task needs this project\'s idempotency key';
    if (args.includes('--workspace')) return 'no task workspace may be set in the sandbox';
    const title = args[args.indexOf('--') + 1] ?? '';
    if (!args.includes('--') || !title.startsWith(`[${s.project}]`)) return `the task title must start with [${s.project}]`;
  }
  return null;
}

/** The converter's injected board runner: the allowlist above, then Hermes' own kanban handler through hermes_native.py. */
export function nativeRunner(s: Sandbox, exec: typeof execFileSync = execFileSync): Ctx['run'] {
  return (cmd, args) => {
    const why = refusal(s, cmd, args);
    if (why) { s.calls.push({ args, ok: false, error: why }); throw new Error(`sandbox adapter refused: ${why}`); }
    try {
      const out = String(exec(s.python, ['-I', '-B', ADAPTER, ...args.slice(1)], { env: s.env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }));
      s.calls.push({ args, ok: true });
      return out;
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      s.calls.push({ args, ok: false, error: (err.stderr || err.message).trim().slice(-400) });
      throw e;
    }
  };
}

/** A path as a quoted SBPL string; refuses anything that could break out of the quotes. */
const q = (path: string) => { if (/["\\\n]/.test(path)) throw new Error(`unsafe path for the sandbox profile: ${path}`); return `"${path}"`; };

/**
 * The macOS sandbox-exec profile for the run (last matching rule wins). Writes: only the sandbox (and /dev). Reads: nothing in the
 * home folder except this repo's code (not its data/, infra/env or .git), Hermes' source and its Python. Network: loopback only.
 * Programs: node and the Hermes Python, nothing else (no shell, git, curl or hermes launcher).
 */
export function profile(s: Pick<Sandbox, 'root' | 'python' | 'agentDir'>, o: { home?: string; repo?: string; node?: string } = {}): string {
  const home = real(o.home ?? homedir()), repo = real(o.repo ?? REPO), node = o.node ?? process.execPath;
  const exe = [...new Set([node, real(node), s.python, real(s.python)])];
  const readable = [...new Set([repo, s.agentDir, dirname(dirname(s.python)), dirname(dirname(real(s.python))), dirname(dirname(real(node))), s.root])];
  return [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound)',
    '(allow network-outbound (remote ip "localhost:*"))',
    '(deny network-bind)',
    '(allow network-bind (local ip "localhost:*"))',
    '(deny file-write*)',
    `(allow file-write* (subpath ${q(s.root)}) (subpath "/dev"))`,
    `(deny file-read-data (subpath ${q(home)}) (subpath "/Volumes"))`,
    `(allow file-read-data ${readable.map((r) => `(subpath ${q(r)})`).join(' ')})`,
    `(deny file-read-data (subpath ${q(join(repo, 'data'))}) (literal ${q(join(repo, 'infra', 'env'))}) (subpath ${q(join(repo, '.git'))}))`,
    `(allow file-read-data (subpath ${q(s.root)}))`,
    '(deny process-exec)',
    `(allow process-exec ${exe.map((e) => `(literal ${q(e)})`).join(' ')})`,
    '',
  ].join('\n');
}

/** Delete the sandbox, only when it is exactly a folder this module made: under `base`, named TEST-feedback-e2e-*, with the marker. */
export function removeSandbox(root: string, base: string): void {
  const r = real(root), b = real(base);
  if (dirname(r) !== b || !/^TEST-feedback-e2e-[A-Za-z0-9]+$/.test(r.slice(b.length + 1)) || !existsSync(join(r, MARKER)))
    throw new Error(`refusing to delete ${root}: not a marked sandbox directly under ${base}`);
  rmSync(r, { recursive: true, force: true });
}
