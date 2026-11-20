import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadLayout } from '../apps/cockpit/src/config.ts';
import { GROUPS } from '../apps/cockpit/src/types.ts';
import { loadCatalogCached } from '../packages/roster/catalog.ts';
import { loadRegistry } from '../packages/roster/roster.ts';
import { WORK_MARKER, isFinishedStatus, parseProject, type AgentLite, type Findings, type PlanTask, type Project } from '../packages/work/model.ts';
import { HUMAN_CREATORS, hopDepths, type HopTask } from '../packages/work/hops.ts';
import { type ShowJson } from '../packages/work/why.ts';
import { type ShowCache } from '../packages/work/showcache.ts';
import { liveConfig } from '../packages/paths/paths.ts';

// What every `work` command shares: the context of one run, where things live, and the calls to Hermes. The commands are in work/commands/.

export const root = resolve(import.meta.dirname, '..');
export const PORTFOLIOS = GROUPS.map((g) => g.id as string);

export interface Ctx {
  kb: string;
  layoutPath: string;
  registryPath: string;
  hermesBin: string;
  hermesHome: string;
  templateDir: string;
  today: string;
  out: (s: string) => void;
  run: (cmd: string, args: string[]) => string;
  apply: boolean;
  flags: Map<string, string[] | true>;
  pos: string[];
  env: NodeJS.ProcessEnv;
  /** Kept `kanban show` answers (see packages/work/showcache.ts), used by the read-only project list only. */
  shows?: ShowCache;
  /** Run another `work` command with the same environment and Hermes runner (advance applies a plan this way). Set by main. */
  rerun?: (argv: string[], out: (s: string) => void) => number;
}

export const BOOL = new Set(['no-github', 'propose', 'apply', 'force', 'json', 'verbose', 'stdin', 'question', 'all', 'due', 'preview']);

export function parseArgs(argv: string[]): { pos: string[]; flags: Map<string, string[] | true> } {
  const pos: string[] = [];
  const flags = new Map<string, string[] | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (BOOL.has(k)) flags.set(k, true);
    else {
      const val = v !== undefined ? v : argv[++i];
      if (val === undefined) throw new Error(`--${k} needs a value`);
      const cur = flags.get(k);
      flags.set(k, [...(Array.isArray(cur) ? cur : []), val]);
    }
  }
  return { pos, flags };
}

/** Now, as an ISO time (WORK_NOW in tests). */
export const nowIso = (c: Ctx): string => c.env.WORK_NOW ? new Date(c.env.WORK_NOW).toISOString() : new Date().toISOString();

export const flag = (c: Ctx, k: string): string | undefined => { const v = c.flags.get(k); return Array.isArray(v) ? v[v.length - 1] : undefined; };
export const flagAll = (c: Ctx, k: string): string[] => { const v = c.flags.get(k); return Array.isArray(v) ? v : []; };
export const csv = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

/* ---------- places ---------- */

export const portfolioDir = (c: Ctx, p: string) => join(c.kb, p);
export const objectivesPath = (c: Ctx, p: string) => join(portfolioDir(c, p), 'objectives.md');

export function allProjects(c: Ctx, only?: string): Array<{ path: string; project: Project; body: string }> {
  const out: Array<{ path: string; project: Project; body: string }> = [];
  for (const portfolio of only ? [only] : PORTFOLIOS) {
    const dir = join(portfolioDir(c, portfolio), 'projects');
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const path = join(dir, f);
      try { out.push({ path, ...parseProject(readFileSync(path, 'utf8')) }); } catch (e) { c.out(`  ! ${path}: ${(e as Error).message}`); }
    }
  }
  return out;
}

export function loadProject(c: Ctx, id: string) {
  const found = allProjects(c).find((p) => p.project.id === id);
  if (!found) throw new Error(`no project "${id}" under ${c.kb} (see: work project list)`);
  return found;
}

export function save(c: Ctx, path: string, content: string, why: string) {
  c.out(`  ${c.apply ? '✓' : '·'} ${why} → ${path.replace(homedir(), '~')}`);
  if (!c.apply) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function agentsLite(c: Ctx): AgentLite[] {
  const reg = loadRegistry(c.registryPath);
  const exists = (profile: string) => profile === 'default' || existsSync(join(c.hermesHome, 'profiles', profile));
  return reg.agents.map((a) => ({
    id: a.id, profile: a.profile, state: exists(a.profile) ? 'active' : 'proposed',
    portfolios: a.portfolios.includes('*') ? PORTFOLIOS : a.portfolios, allPortfolios: a.portfolios.includes('*'),
  }));
}

/** Keys of the plan tasks whose Hermes task is done or archived (they do not count against the limit). Empty when the board cannot be read. */
export function finishedKeys(c: Ctx, p: Project): Set<string> {
  const out = new Set<string>();
  const board = boardOf(c, p);
  if (!board) return out;
  try {
    for (const t of tenantTasks(c, board, p.tenant)) {
      const m = (t.body ?? '').match(WORK_MARKER);
      if (m && m[1] === p.id && isFinishedStatus(t.status)) out.add(m[2]);
    }
  } catch { /* board unreachable: everything counts */ }
  return out;
}

export function checkCtx(c: Ctx) {
  const reg = loadRegistry(c.registryPath);
  const catalog = loadCatalogCached(reg.catalog.dir);
  return { portfolios: PORTFOLIOS, agents: agentsLite(c), catalogSlugs: catalog.length ? catalog.map((e) => e.slug) : undefined };
}

export const boardFor = (c: Ctx, portfolio: string): string | undefined => Object.entries(loadLayout(c.layoutPath).boards).find(([, g]) => g === portfolio)?.[0];

/** The board a project's tasks are on: its own pin if it has one, else its portfolio's. */
export const boardOf = (c: Ctx, p: Project): string | undefined => p.board ?? boardFor(c, p.portfolio);

export function show(c: Ctx, label: string, f: Findings): boolean {
  for (const e of f.errors) c.out(`  ✗ ${label}: ${e}`);
  for (const w of f.warnings) c.out(`  ▲ ${label}: ${w}`);
  return f.errors.length === 0;
}

export interface KTask { id: string; title: string; status: string; assignee: string | null; tenant: string | null; body: string | null; created_by?: string | null; created_at?: number; started_at?: number | null; completed_at?: number | null }
export const iso = (n?: number | null): string | null => (n ? new Date(n * 1000).toISOString() : null);

export function kanban(c: Ctx, board: string, args: string[]): string {
  // `show` is the slow, repeated call (a second each, about a hundred per project list): answer from the kept copy while the task is unchanged.
  const id = args[0] === 'show' ? args.find((a) => /^t_/.test(a)) : undefined;
  if (!id) return c.run(c.hermesBin, ['kanban', '--board', board, ...args]);
  const kept = c.shows?.get(board, id);
  if (kept !== undefined) return kept;
  const raw = c.run(c.hermesBin, ['kanban', '--board', board, ...args]);
  c.shows?.set(board, id, raw);
  return raw;
}

/** What the task is called in Hermes: the project id first, so every task can be traced to its project. */
export const taskTitle = (p: Project, t: PlanTask): string => `[${p.id}] ${t.title}`;

/** Does this repo have a git remote? Unknown (no such folder, git missing) counts as yes, so the usual rules apply. */
export function repoHasRemote(repoPath: string | null): boolean {
  if (!repoPath || !existsSync(repoPath)) return true;
  try { return execFileSync('git', ['-C', repoPath, 'remote'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0; } catch { return true; }
}

/**
 * The project's tasks. Hermes' auto-decomposer may rewrite a task's body and drop the [work:project:key] line that links it to the plan;
 * the key `work` gave the task at creation (project:<id>:<key>) survives in the board database, so the line is put back, in memory only.
 */
export function tenantTasks(c: Ctx, board: string, tenant: string): KTask[] {
  return recoverMarkers(c, board, JSON.parse(kanban(c, board, ['list', '--tenant', tenant, '--json'])) as KTask[]);
}
/** Put the lost [work:project:key] line back (in memory) on tasks `work` created, from the key stored in the board database. */
/**
 * Steps Hermes' auto-decomposer split a plan task into: tasks it created (no [work:] line) that feed a plan task. Keyed by the plan task's
 * id, oldest first, so the project page can show what is really going on. At most 12 are looked up per board.
 */
export function autoSubtasks(c: Ctx, board: string, tasks: KTask[]): Map<string, KTask[]> {
  const out = new Map<string, KTask[]>();
  const marked = new Set(tasks.filter((t) => WORK_MARKER.test(t.body ?? '')).map((t) => t.id));
  const split = tasks.filter((t) => !WORK_MARKER.test(t.body ?? '') && t.created_by === 'auto-decomposer').slice(0, 12);
  const kids = new Map<string, string[]>();
  for (const t of split) {
    let d: { children?: string[] };
    try { d = JSON.parse(kanban(c, board, ['show', '--json', t.id])); } catch { continue; }
    kids.set(t.id, d.children ?? []);
  }
  // A step can itself be split again (its steps feed it, not the plan task), so follow the chain up to the plan task.
  const rootOf = (id: string, seen = new Set<string>()): string | null => {
    if (seen.has(id)) return null;
    seen.add(id);
    for (const ch of kids.get(id) ?? []) { if (marked.has(ch)) return ch; const r = rootOf(ch, seen); if (r) return r; }
    return null;
  };
  for (const t of split) { const root = rootOf(t.id); if (root) out.set(root, [...(out.get(root) ?? []), t]); }
  for (const list of out.values()) list.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  return out;
}

/**
 * Why a blocked or review task is stuck, in a sentence a person can act on: what its last run said, or, when its worker keeps crashing, that
 * and where to look. From `kanban show --json`; nothing here is guessed.
 */
export function explainTask(c: Ctx, board: string, t: KTask): { text: string; crashes: number } | null {
  let j: { latest_summary?: string; runs?: Array<{ outcome?: string; status?: string; summary?: string; error?: string }>; events?: Array<{ kind?: string; payload?: { reason?: string } | null }> };
  try { j = JSON.parse(kanban(c, board, ['show', '--json', t.id])); } catch { return null; }
  const runs = j.runs ?? [];
  let crashes = 0;
  for (let i = runs.length - 1; i >= 0 && (runs[i].outcome ?? runs[i].status) === 'crashed'; i--) crashes++;
  const one = (v: unknown, n: number) => { const x = String(v ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
  if (crashes >= 2) {
    const last = runs[runs.length - 1];
    return { crashes, text: `The agent's worker crashed ${crashes} runs in a row (${one(last.error ?? last.summary, 160)}). Its log: ~/.hermes/profiles/${t.assignee ?? 'default'}/logs/managed-worker.log` };
  }
  const reason = [...(j.events ?? [])].reverse().find((e) => e.kind === 'blocked' || e.kind === 'gave_up')?.payload?.reason;
  const text = one(j.latest_summary || runs[runs.length - 1]?.summary || reason, 420);
  return text ? { crashes, text } : null;
}

export function recoverMarkers(c: Ctx, board: string, tasks: KTask[]): KTask[] {
  const lost = tasks.filter((t) => !WORK_MARKER.test(t.body ?? '') && t.created_by === 'work');
  if (!lost.length) return tasks;
  const dbPath = join(c.hermesHome, 'kanban', 'boards', board, 'kanban.db');
  if (!existsSync(dbPath)) return tasks;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const get = db.prepare('SELECT idempotency_key k FROM tasks WHERE id = ?');
    for (const t of lost) {
      const m = ((get.get(t.id) as { k: string | null } | undefined)?.k ?? '').match(/^project:([a-z0-9-]+):([a-z0-9-]+)$/);
      if (m) t.body = `[work:${m[1]}:${m[2]}]\n\n${t.body ?? ''}`;
    }
  } catch { /* no database access: the tasks stay as listed */ } finally { db?.close(); }
  return tasks;
}

/** Parents of agent-created tasks (and of those parents, up the chain) from `kanban show`; the deepest chain of agent-created tasks. */
export function deepestHop(c: Ctx, board: string, tasks: KTask[]): number {
  const known = new Map<string, HopTask>(tasks.map((t) => [t.id, { id: t.id, created_by: t.created_by ?? null }]));
  const fetched = new Set<string>();
  const queue = tasks.filter((t) => !HUMAN_CREATORS.has(t.created_by ?? '')).map((t) => t.id);
  while (queue.length && fetched.size < 60) {
    const id = queue.shift()!;
    if (fetched.has(id)) continue;
    fetched.add(id);
    try {
      const j = JSON.parse(kanban(c, board, ['show', '--json', id])) as ShowJson;
      const parents = (j.parents ?? []).map((x) => (typeof x === 'string' ? x : String((x as { id?: unknown }).id)));
      known.set(id, { id, created_by: String(j.task?.created_by ?? known.get(id)?.created_by ?? ''), parents });
      for (const pid of parents) if (!known.has(pid)) { known.set(pid, { id: pid, created_by: null }); queue.push(pid); } 
    } catch { /* no detail for this task: its chain stops here */ }
  }
  return Math.max(0, ...hopDepths([...known.values()]).values());
}

export const hoursSince = (iso: string | null, today: string) => (iso ? Math.max(0, (Date.parse(today) - Date.parse(iso)) / 3_600_000) : 0);
export const planSha = (plan: PlanTask[]) => createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16);

/* ---------- repo mapping (config/projects.json) ---------- */

export const reposConfig = (c: Ctx): Record<string, Array<{ id: string; path: string | null; note?: string }>> => {
  const path = c.env.PROJECTS_CONFIG ?? liveConfig('projects.json', c.env);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')).repos ?? {}) : {};
};
export const codesDir = (c: Ctx) => c.env.CODES_DIR ?? join(homedir(), 'codes');

/** A repo id from config/projects.json becomes its folder; anything else is kept as given. */
export function resolveRepo(c: Ctx, v?: string): string | null {
  if (!v) return null;
  const hit = Object.values(reposConfig(c)).flat().find((r) => r.id === v);
  return hit ? (hit.path ?? null) : v;
}

/** Only this project may change this repo (the platform's own code). Atlas and every other project's agents stay out of it. */
export const CORE_PROJECT = 'cockpit-improvement';

/** Why a task of project `p` must not be created because it would work inside this repo; null when it is fine. */
/** Every folder that holds the platform's own code: this install, the dev working copy, and PAP_DEV_REPO when set. */
export function platformRoots(c: Ctx): string[] {
  return [...new Set([root, join(codesDir(c), 'personal-agent-platform'), ...(c.env.PAP_DEV_REPO ? [resolve(c.env.PAP_DEV_REPO)] : [])].map((p) => resolve(p)))];
}

export function coreRepoViolation(c: Ctx, p: Project, plan: PlanTask[]): string | null {
  if (p.id === CORE_PROJECT) return null;
  const inCore = (v: string | null) => {
    if (!v) return false;
    const m = v.match(/^dir:(.*)$/);
    const path = m ? m[1] : v;
    const abs = resolve(path.startsWith('/') ? path : join(codesDir(c), path));
    // The platform's code lives in more than one place: this install (prod runs from ~/services) and the working copy agents and Frank
    // edit (~/codes/personal-agent-platform, or PAP_DEV_REPO). All of them are the platform's own code.
    return platformRoots(c).some((r) => { const rel = relative(r, abs); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); });
  };
  const hit = inCore(p.repo) ? `repo ${p.repo}` : plan.find((t) => inCore(t.workspace)) ? `a task workspace` : null;
  return hit ? `${hit} is the platform's own code; only the "${CORE_PROJECT}" project may change it. Propose the change there (work feedback add, or ask in that project) instead` : null;
}
