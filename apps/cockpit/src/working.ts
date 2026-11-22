import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { maskSensitive } from './sources/agentDetail.ts';

// What is working right now, for the header: every kanban task with a live run, with its agent, project and portfolio. Titles only (masked), never task text.
// A run whose worker has not sent a heartbeat for a while is "stalled": shown, but not as working.

export const STALL_AFTER = 15 * 60;
export interface Working { id: string; board: string; portfolio: string; project: string | null; title: string; agent: string; since: number; stalled: boolean; quiet: number }
export interface NowWorking { now: number; items: Working[]; waiting: number }

interface Row { id: string; title: string; tenant: string | null; assignee: string | null; profile: string | null; started: number | null; run_started: number | null; hb: number | null }

/** Pure: turn board rows into what the header shows. `portfolioOf` maps a board to its portfolio. */
export function shapeWorking(boards: Array<{ board: string; rows: Row[]; waiting: number }>, portfolioOf: (board: string) => string | undefined, now: number): NowWorking {
  const items: Working[] = [];
  let waiting = 0;
  for (const { board, rows, waiting: w } of boards) {
    waiting += w;
    for (const r of rows) {
      const since = r.run_started ?? r.started ?? now, seen = r.hb ?? since;
      items.push({
        id: r.id, board, portfolio: portfolioOf(board) ?? board, project: r.tenant || null,
        title: maskSensitive(String(r.title ?? '')).replace(/^\[[a-z0-9-]+\]\s*/, '').replace(/^\[[a-z0-9-]+\]\s*/, '').slice(0, 140),
        agent: r.profile || r.assignee || 'agent', since, stalled: now - seen > STALL_AFTER, quiet: Math.max(0, Math.round((now - seen) / 60)),
      });
    }
  }
  items.sort((a, b) => Number(a.stalled) - Number(b.stalled) || a.since - b.since);
  return { now, items, waiting };
}

export function readWorking(hermesHome: string, portfolioOf: (board: string) => string | undefined, now = Date.now() / 1000): NowWorking {
  const boardsDir = join(hermesHome, 'kanban', 'boards');
  let names: string[] = [];
  try { names = readdirSync(boardsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name); } catch { /* no boards */ }
  const boards: Array<{ board: string; rows: Row[]; waiting: number }> = [];
  for (const board of names) {
    const path = join(boardsDir, board, 'kanban.db');
    if (!existsSync(path)) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const rows = db.prepare(`SELECT t.id id, t.title title, t.tenant tenant, t.assignee assignee, r.profile profile, t.started_at started, r.started_at run_started, COALESCE(r.last_heartbeat_at, t.last_heartbeat_at) hb
        FROM tasks t LEFT JOIN task_runs r ON r.id = t.current_run_id WHERE t.status = 'running'`).all() as unknown as Row[];
      const waiting = (db.prepare(`SELECT COUNT(*) n FROM tasks WHERE status = 'ready'`).get() as { n: number }).n;
      boards.push({ board, rows, waiting });
    } catch { /* an unreadable board adds nothing */ } finally { db?.close(); }
  }
  return shapeWorking(boards, portfolioOf, now);
}

/** Invented rows for the demo (nothing real). */
export function demoWorking(now = Date.now() / 1000): NowWorking {
  return { now, waiting: 2, items: [
    { id: 't_d0000001', board: 'demo', portfolio: 'micropace', project: 'notice-v1', title: 'Build the reminder screen', agent: 'coding', since: now - 540, stalled: false, quiet: 0 },
    { id: 't_d0000002', board: 'demo', portfolio: 'ai-thrival', project: 'launch-kit', title: 'Draft the store listing text', agent: 'content', since: now - 1260, stalled: false, quiet: 1 },
  ] };
}
