import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { needsHuman } from '../work/watch.ts';

// Is an agent actually getting better? Measured, not asserted, from what Hermes already records: finished tasks, how many needed a
// person, how many attempts they took, how long they ran, and what they cost in tokens. Weekly buckets (Monday start) and daily buckets.

export interface Bucket { key: string; start: string; done: number; untouched: number; retries: number; minutes: number; tokens: number }

export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function mondayOf(d: Date): Date { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear(), w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

interface Row { completed: number; runs: number; secs: number; touched: boolean }

/** Finished tasks assigned to `profile` since `since` (epoch seconds), from every board's database. */
export function finishedTasks(boardsDir: string, profile: string, since: number): Row[] {
  const out: Row[] = [];
  let boards: string[] = [];
  try { boards = readdirSync(boardsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const b of boards) {
    const path = join(boardsDir, b, 'kanban.db');
    if (!existsSync(path)) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const tasks = db.prepare(`SELECT id, completed_at c FROM tasks WHERE assignee = ? AND status = 'done' AND completed_at >= ?`).all(profile, since) as Array<{ id: string; c: number }>;
      for (const t of tasks) {
        const runs = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(COALESCE(ended_at, started_at) - started_at), 0) s FROM task_runs WHERE task_id = ?`).get(t.id) as { n: number; s: number };
        const events = (db.prepare(`SELECT kind, payload FROM task_events WHERE task_id = ?`).all(t.id) as Array<{ kind: string; payload: string | null }>).map((e) => { let p: unknown = null; try { p = e.payload ? JSON.parse(e.payload) : null; } catch { /* keep null */ } return { kind: e.kind, payload: p as { reason?: string } | null }; });
        out.push({ completed: t.c, runs: runs.n, secs: runs.s, touched: needsHuman(events) });
      }
    } catch { /* an unreadable board contributes nothing */ } finally { db?.close(); }
  }
  return out;
}

/** Tokens per day for a profile from its sessions ledger (counts only). */
export function tokensByDay(stateDb: string, since: number): Map<string, number> {
  const m = new Map<string, number>();
  if (!existsSync(stateDb)) return m;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(stateDb, { readOnly: true });
    for (const r of db.prepare(`SELECT date(started_at,'unixepoch','localtime') d, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) t FROM sessions WHERE started_at >= ? GROUP BY d`).all(since) as Array<{ d: string; t: number }>) m.set(r.d, r.t);
  } catch { /* no ledger */ } finally { db?.close(); }
  return m;
}

export function agentMetrics(o: { boardsDir: string; stateDb: string; profile: string; now?: Date; weeks?: number; days?: number }): { weeks: Bucket[]; days: Bucket[] } {
  const now = o.now ?? new Date(), nW = o.weeks ?? 8, nD = o.days ?? 14;
  const start = new Date(mondayOf(now)); start.setDate(start.getDate() - 7 * (nW - 1));
  const since = start.getTime() / 1000;
  const rows = finishedTasks(o.boardsDir, o.profile, since);
  const tok = tokensByDay(o.stateDb, since);
  const fill = (b: Bucket, r: Row) => { b.done++; if (!r.touched) b.untouched++; b.retries += Math.max(0, r.runs - 1); b.minutes += r.secs / 60; };
  const weeks: Bucket[] = Array.from({ length: nW }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + 7 * i); return { key: isoWeek(d), start: ymd(d), done: 0, untouched: 0, retries: 0, minutes: 0, tokens: 0 }; });
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (nD - 1));
  const days: Bucket[] = Array.from({ length: nD }, (_, i) => { const d = new Date(dayStart); d.setDate(d.getDate() + i); return { key: ymd(d), start: ymd(d), done: 0, untouched: 0, retries: 0, minutes: 0, tokens: tok.get(ymd(d)) ?? 0 }; });
  for (const r of rows) {
    const d = new Date(r.completed * 1000);
    const w = weeks.find((x) => x.key === isoWeek(d)); if (w) fill(w, r);
    const dd = days.find((x) => x.key === ymd(d)); if (dd) fill(dd, r);
  }
  for (const [d, t] of tok) { const dt = new Date(d + 'T12:00:00'); const w = weeks.find((x) => x.key === isoWeek(dt)); if (w) w.tokens += t; }
  return { weeks, days };
}
