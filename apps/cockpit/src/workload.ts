import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// How busy the agent system was, as a timeline: for every 15-minute slot, how many agents were working (average over the slot) and how many
// tasks were waiting for a worker. Counts only: no titles, no text. Read-only from the kanban boards.
//   working = a kanban run (claimed by a worker, from its start to its end)
//   waiting = a task that was ready to run and not yet claimed. Waits under 3 minutes are the dispatcher's normal one-minute rhythm, not a queue.

export const STEP = 900;                       // seconds per slot
export const MIN_WAIT = 180;                   // shorter waits are not "queued"
export interface Interval { s: number; e: number }
export interface Workload {
  /** Epoch seconds of the first slot; slot i covers [start + i*step, start + (i+1)*step). */
  start: number; step: number; slots: number; now: number;
  /** Per portfolio (so a person who may not see one never gets its numbers): average agents working and average tasks waiting, per slot. */
  groups: Record<string, { run: number[]; queue: number[] }>;
}

/** Average number of intervals open during each slot (total overlap seconds / slot length), 2 decimals. */
export function occupancy(intervals: Interval[], start: number, slots: number, step = STEP): number[] {
  const out = new Array<number>(slots).fill(0);
  const end = start + slots * step;
  for (const iv of intervals) {
    const s = Math.max(iv.s, start), e = Math.min(iv.e, end);
    if (!(e > s)) continue;
    for (let i = Math.floor((s - start) / step); i < slots && start + i * step < e; i++) {
      const a = Math.max(s, start + i * step), b = Math.min(e, start + (i + 1) * step);
      if (b > a) out[i] += (b - a) / step;
    }
  }
  return out.map((v) => Math.round(v * 100) / 100);
}

export interface EventRow { task_id: string; kind: string; payload: string | null; created_at: number }
const READY = new Set(['promoted', 'unblocked', 'reclaimed', 'changes_requested', 'reopened']);
const LEAVE = new Set(['claimed', 'blocked', 'archived', 'completed', 'gave_up', 'review_requested']);

/** When each task was ready and waiting for a worker. `status` is the task's status now: a wait with no recorded end only counts up to `now` if the task is still `ready`. */
export function waitIntervals(events: EventRow[], status: ReadonlyMap<string, string>, now: number): Interval[] {
  const byTask = new Map<string, EventRow[]>();
  for (const e of events) (byTask.get(e.task_id) ?? byTask.set(e.task_id, []).get(e.task_id)!).push(e);
  const out: Interval[] = [];
  for (const [id, list] of byTask) {
    let since: number | null = null;
    for (const e of list) {   // already in id order, which is time order
      let startsReady = READY.has(e.kind);
      if (e.kind === 'created') { try { startsReady = JSON.parse(e.payload ?? '{}')?.status === 'ready'; } catch { startsReady = false; } }
      if (startsReady) { since ??= e.created_at; continue; }
      if (LEAVE.has(e.kind) && since !== null) { if (e.created_at - since >= MIN_WAIT) out.push({ s: since, e: e.created_at }); since = null; }
    }
    if (since !== null && status.get(id) === 'ready' && now - since >= MIN_WAIT) out.push({ s: since, e: now });
  }
  return out;
}

export interface RunRow { s: number; e: number | null; status?: string | null; hb?: number | null; max?: number | null }
/** A run's working time. A run with no end that is not really running (a crash that left no record) stops at its last heartbeat. */
export function runIntervals(rows: RunRow[], now: number): Interval[] {
  return rows.map((r) => {
    const cap = r.max && r.max > 0 ? r.s + r.max : r.s + 4 * 3600;
    const e = r.e ?? (r.status === 'running' ? Math.min(now, cap) : (r.hb ?? r.s));
    return { s: r.s, e: Math.max(e, r.s) };
  }).filter((i) => i.e > i.s);
}

/** The window: whole days back from the end of today in UTC-agnostic terms is the client's job, so the server just covers `days` + 1 day of slots ending at the next slot boundary. */
export function windowFor(now: number, days: number): { start: number; slots: number } {
  const slots = Math.ceil(((days + 1) * 86_400) / STEP);
  const end = Math.ceil(now / STEP) * STEP + 86_400;       // one day of slack past now, so a local "today" is always covered
  return { start: end - slots * STEP, slots };
}

export function readWorkload(hermesHome: string, groupOfBoard: (board: string) => string | undefined, days = 7, now = Date.now() / 1000): Workload {
  const { start, slots } = windowFor(now, days);
  const groups: Workload['groups'] = {};
  const boardsDir = join(hermesHome, 'kanban', 'boards');
  let boards: string[] = [];
  try { boards = readdirSync(boardsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name); } catch { /* no boards */ }
  const runsBy = new Map<string, Interval[]>(), waitsBy = new Map<string, Interval[]>();
  for (const board of boards) {
    const path = join(boardsDir, board, 'kanban.db');
    if (!existsSync(path)) continue;
    const g = groupOfBoard(board) ?? board;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const rows = db.prepare('SELECT started_at s, ended_at e, status, last_heartbeat_at hb, max_runtime_seconds max FROM task_runs WHERE started_at IS NOT NULL AND COALESCE(ended_at, ?) >= ?').all(now, start) as unknown as RunRow[];
      (runsBy.get(g) ?? runsBy.set(g, []).get(g)!).push(...runIntervals(rows, now));
      const status = new Map((db.prepare('SELECT id, status FROM tasks').all() as Array<{ id: string; status: string }>).map((t) => [t.id, t.status]));
      // every event of a task that was waiting inside the window: from the earliest event we need (a wait may start before the window)
      const ev = db.prepare("SELECT task_id, kind, payload, created_at FROM task_events WHERE kind IN ('created','promoted','unblocked','reclaimed','changes_requested','reopened','claimed','blocked','archived','completed','gave_up','review_requested') AND task_id IN (SELECT DISTINCT task_id FROM task_events WHERE created_at >= ?) ORDER BY task_id, id").all(start - 7 * 86_400) as unknown as EventRow[];
      (waitsBy.get(g) ?? waitsBy.set(g, []).get(g)!).push(...waitIntervals(ev, status, now));
    } catch { /* an unreadable board adds nothing */ } finally { db?.close(); }
  }
  for (const g of new Set([...runsBy.keys(), ...waitsBy.keys()])) groups[g] = { run: occupancy(runsBy.get(g) ?? [], start, slots), queue: occupancy(waitsBy.get(g) ?? [], start, slots) };
  return { start, step: STEP, slots, now, groups };
}

/** Invented but plausible numbers for the demo (nothing real): busy office hours, a nightly job, a backlog that builds up on one afternoon. */
export function demoWorkload(now = Date.now() / 1000, days = 7): Workload {
  const { start, slots } = windowFor(now, days);
  const run: number[] = [], queue: number[] = [];
  for (let i = 0; i < slots; i++) {
    const t = start + i * STEP, d = new Date(t * 1000), h = d.getUTCHours() + d.getUTCMinutes() / 60, day = Math.floor(t / 86_400);
    const wave = Math.max(0, Math.sin(((h - 3) / 14) * Math.PI)), wk = [0, 6].includes(d.getUTCDay()) ? 0.35 : 1;
    const jitter = ((Math.sin(i * 12.9898 + day) * 43758.5453) % 1 + 1) % 1;
    const r = t > now ? 0 : Math.max(0, Math.round((wave * wk * 2.6 * jitter + (h > 20 && h < 20.5 ? 1 : 0)) * 100) / 100);
    run.push(r < 0.08 ? 0 : r);
    queue.push(t <= now && r > 2 && jitter > 0.55 ? Math.round(jitter * 3 * 100) / 100 : 0);
  }
  return { start, step: STEP, slots, now, groups: { micropace: { run, queue } } };
}
