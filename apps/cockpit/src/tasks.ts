import type { Runner } from './sources/hermesKanban.ts';

// Adding work from Cockpit. It drives the same Hermes kanban CLI everything else uses, with fixed arguments (no
// shell), so a task made here is identical to one made from Telegram or the Hermes dashboard.
//
//   not assigned → created `blocked` ("waiting for a human decision"): nothing can start until someone, or Atlas,
//                  picks an owner. (An unassigned `ready` task might be claimed by the default profile.)
//   assigned     → created `ready`: the dispatcher starts the agent on it within about a minute.

export const TITLE_MAX = 200;
export const BODY_MAX = 6_000;
const TASK_ID = /^t_[a-z0-9]{4,20}$/i;

import { maskSensitive } from './sources/agentDetail.ts';

export interface TaskDeps {
  run: Runner;
  /** Kanban board slug for a portfolio id, if one is mapped. */
  boardFor: (portfolio: string) => string | undefined;
  /** Profiles that may be assigned work (active roster agents). */
  assignable: () => string[];
}

export class TaskError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function board(deps: TaskDeps, portfolio: string): string {
  const b = deps.boardFor(portfolio);
  if (!b) throw new TaskError(400, `no kanban board is mapped to "${portfolio}" (create one with hermes kanban boards create, then list it under boards in config/cockpit.json)`);
  return b;
}

function profile(deps: TaskDeps, assignee: string): string {
  if (!deps.assignable().includes(assignee)) throw new TaskError(400, `"${assignee}" is not an active agent (proposed agents have no Hermes profile yet)`);
  return assignee;
}

export interface CreatedTask {
  id: string;
  status: string;
  board: string;
  assignee: string | null;
  title: string;
}

export async function createTask(deps: TaskDeps, input: any): Promise<CreatedTask> {
  const title = str(input.title);
  const body = str(input.body);
  const assignee = str(input.assignee);
  if (!title) throw new TaskError(400, 'title is empty');
  if (title.length > TITLE_MAX) throw new TaskError(400, `title is longer than ${TITLE_MAX} characters`);
  if (body.length > BODY_MAX) throw new TaskError(400, `details are longer than ${BODY_MAX} characters`);
  const slug = board(deps, str(input.portfolio));
  const owner = assignee ? profile(deps, assignee) : null;

  const args = ['kanban', '--board', slug, 'create', '--json', '--created-by', 'cockpit', ...(owner ? ['--assignee', owner] : ['--initial-status', 'blocked']), ...(body ? ['--body', body] : []), '--', title];
  let made: any;
  try {
    made = JSON.parse(await deps.run(args));
  } catch (e) {
    throw new TaskError(502, `Hermes could not create the task (${(e as Error).message.slice(0, 120)})`);
  }
  if (!made?.id || !TASK_ID.test(String(made.id))) throw new TaskError(502, 'Hermes did not return a task id');
  return { id: String(made.id), status: String(made.status ?? ''), board: slug, assignee: owner, title };
}

export async function assignTask(deps: TaskDeps, input: any): Promise<{ id: string; status: string; assignee: string }> {
  const id = str(input.id);
  if (!TASK_ID.test(id)) throw new TaskError(400, 'bad task id');
  const slug = board(deps, str(input.portfolio));
  const owner = profile(deps, str(input.assignee));
  try {
    const cur = JSON.parse(await deps.run(['kanban', '--board', slug, 'show', id, '--json']));
    const status = String(cur?.task?.status ?? cur?.status ?? '');
    if (!status) throw new Error('task not found');
    if (status === 'done' || status === 'archived') throw new TaskError(409, `task is already ${status}`);
    await deps.run(['kanban', '--board', slug, 'assign', id, owner]);
    // A task parked for a staffing decision is released as soon as it has an owner.
    if (status === 'blocked') await deps.run(['kanban', '--board', slug, 'unblock', id]);
    return { id, status: status === 'blocked' ? 'ready' : status, assignee: owner };
  } catch (e) {
    if (e instanceof TaskError) throw e;
    throw new TaskError(502, `Hermes could not assign the task (${(e as Error).message.slice(0, 120)})`);
  }
}

const iso = (n: unknown): string | null => (typeof n === 'number' && n > 0 ? new Date(n * 1000).toISOString() : null);

/** One finished (or running) task as a person wants to read it: what it was, who ran it, when, and what it handed back. Read-only; secrets and PII are masked. */
export async function showTask(run: Runner, board: string, id: string): Promise<unknown> {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(board) || !/^t_[0-9a-f]{4,16}$/.test(id)) throw new TaskError(400, 'bad board or task id');
  let raw: string;
  try { raw = await run(['kanban', '--board', board, 'show', id, '--json']); } catch { throw new TaskError(502, 'Hermes could not show that task'); }
  let j: any; try { j = JSON.parse(raw); } catch { throw new TaskError(502, 'unreadable task'); }
  const t = j.task ?? {};
  const cut = (v: unknown, n: number) => (typeof v === 'string' ? maskSensitive(v).slice(0, n) : null);
  let runs: unknown[] = [];
  try { runs = (JSON.parse(await run(['kanban', '--board', board, 'runs', id, '--json'])) as any[]).slice(-8).map((r) => ({ outcome: r.outcome ?? r.status, profile: r.profile ?? r.assignee, started: iso(r.started_at), ended: iso(r.ended_at), summary: cut(r.summary, 4000), error: cut(r.error, 600) })); } catch { /* older Hermes: no runs --json */ }
  return {
    id: t.id, board, title: cut(t.title, 200), status: t.status, assignee: t.assignee ?? null, created: iso(t.created_at), started: iso(t.started_at), completed: iso(t.completed_at),
    body: cut(t.body, 6000), result: cut(t.result, 6000), summary: cut(j.latest_summary, 8000), failure: cut(t.last_failure_error, 1500), workspace: t.workspace_path ?? null,
    comments: (j.comments ?? []).slice(-20).map((c: any) => ({ by: c.author ?? c.by ?? null, at: iso(c.created_at), text: cut(c.body ?? c.text, 1500) })),
    events: (j.events ?? []).filter((e: any) => !/^tip_|owner_admitted/.test(String(e.kind))).slice(-30).map((e: any) => ({ kind: e.kind, at: iso(e.created_at) })),
    parents: j.parents ?? [], children: j.children ?? [], runs,
  };
}

/** Find one task by its exact id on any of `boards`, whatever its status (blocked, done, archived) and whether it is a subtask or not. First hit wins; ids are unique across boards in practice. */
export async function findTask(run: Runner, boards: string[], id: string): Promise<{ found: false } | { found: true; task: { id: string; board: string; title: string; status: string; assignee: string | null; project: string | null } }> {
  if (!TASK_ID.test(id)) throw new TaskError(400, 'a task id looks like t_ followed by hex digits');
  const hits = await Promise.all(boards.filter((b) => /^[a-z0-9][a-z0-9_-]{0,40}$/.test(b)).map(async (board) => {
    try { const j = JSON.parse(await run(['kanban', '--board', board, 'show', id, '--json'])); return j?.task?.id === id ? { board, t: j.task } : null; } catch { return null; }   // "no such task" is an error exit
  }));
  const hit = hits.find(Boolean);
  if (!hit) return { found: false };
  const cut = (v: unknown, n: number) => (typeof v === 'string' ? maskSensitive(v).slice(0, n) : '');
  return { found: true, task: { id, board: hit.board, title: cut(hit.t.title, 200), status: String(hit.t.status ?? ''), assignee: hit.t.assignee ?? null, project: typeof hit.t.tenant === 'string' ? hit.t.tenant : null } };
}

export interface TaskHit { id: string; board: string; title: string; status: string; assignee: string | null; project: string | null }
const ORDER: Record<string, number> = { running: 0, blocked: 1, review: 2, ready: 3, todo: 4, triage: 4, scheduled: 4, done: 5, archived: 6 };

/** Tasks whose id, title, project, owner or description contains every word of `q`, on any of `boards`, any status (archived too). Newest-active first, at most `limit`. */
export async function searchTasks(run: Runner, boards: string[], q: string, limit = 40): Promise<{ tasks: TaskHit[]; more: number }> {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length || q.trim().length < 2) return { tasks: [], more: 0 };
  const per = await Promise.all(boards.filter((b) => /^[a-z0-9][a-z0-9_-]{0,40}$/.test(b)).map(async (board) => {
    try { return (JSON.parse(await run(['kanban', '--board', board, 'list', '--json', '--archived'])) as any[]).map((t) => ({ board, t })); } catch { return []; }
  }));
  const hits = per.flat().filter(({ t }) => { const hay = [t.id, t.title, t.tenant, t.assignee, t.body].filter((x) => typeof x === 'string').join(' ').toLowerCase(); return words.every((w) => hay.includes(w)); })
    .sort((a, b) => (ORDER[a.t.status] ?? 5) - (ORDER[b.t.status] ?? 5) || (b.t.created_at ?? 0) - (a.t.created_at ?? 0));
  const cut = (v: unknown, n: number) => (typeof v === 'string' ? maskSensitive(v).slice(0, n) : '');
  return { tasks: hits.slice(0, limit).map(({ board, t }) => ({ id: String(t.id), board, title: cut(t.title, 200), status: String(t.status ?? ''), assignee: t.assignee ?? null, project: typeof t.tenant === 'string' ? t.tenant : null })), more: Math.max(0, hits.length - limit) };
}
