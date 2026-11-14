import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// `hermes kanban show` starts a Python process and takes about a second. A project list asked for about a hundred of them, every
// time (100 seconds), although a task's answer only changes when something happens to the task. So the answer is kept, together
// with a stamp of the task's state read straight from the board's database (one query per board): its last event, its last run and
// the board's link count. Same stamp = nothing happened = the kept answer is still right. No readable database = no stamp = nothing
// is kept and Hermes is asked every time, as before.

const KEEP_DAYS = 30;

export interface ShowCache {
  /** The kept `show` output for a task, if nothing has happened to the task since it was kept. */
  get(board: string, id: string): string | undefined;
  set(board: string, id: string, raw: string): void;
  /** Write what changed to disk (once, at the end of a command). */
  flush(): void;
}

/** task id → state stamp, or null when the board's database cannot be read. */
export function boardStamps(hermesHome: string, board: string): Map<string, string> | null {
  const path = join(hermesHome, 'kanban', 'boards', board, 'kanban.db');
  if (!existsSync(path)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const links = (db.prepare('SELECT COUNT(*) n FROM task_links').get() as { n: number }).n;
    const out = new Map<string, string>();
    const rows = db.prepare(`SELECT t.id id, t.status s,
        (SELECT MAX(e.id) FROM task_events e WHERE e.task_id = t.id) ev,
        (SELECT MAX(r.id) FROM task_runs r WHERE r.task_id = t.id) run,
        (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) cm
      FROM tasks t`).all() as Array<{ id: string; s: string; ev: number | null; run: number | null; cm: number }>;
    for (const r of rows) out.set(r.id, `${r.s}|${r.ev ?? 0}|${r.run ?? 0}|${r.cm}|${links}`);
    return out;
  } catch {
    return null;   // an older or newer Hermes with other tables: do not guess
  } finally { db?.close(); }
}

export function showCache(file: string, hermesHome: string, now = Date.now()): ShowCache {
  let store: Record<string, { stamp: string; at: number; raw: string }> | undefined;
  let dirty = false;
  const stamps = new Map<string, Map<string, string> | null>();
  const stampOf = (board: string, id: string): string | undefined => {
    if (!stamps.has(board)) stamps.set(board, boardStamps(hermesHome, board));
    return stamps.get(board)?.get(id);
  };
  const load = () => {
    if (!store) { try { store = JSON.parse(readFileSync(file, 'utf8')); } catch { store = {}; } }
    return store!;
  };
  return {
    get(board, id) {
      const stamp = stampOf(board, id);
      if (!stamp) return undefined;
      const hit = load()[`${board}/${id}`];
      if (!hit || hit.stamp !== stamp) return undefined;
      if (now - hit.at > 86_400_000) { hit.at = now; dirty = true; }   // still in use: keep it from ageing out
      return hit.raw;
    },
    set(board, id, raw) {
      const stamp = stampOf(board, id);
      if (!stamp) return;
      load()[`${board}/${id}`] = { stamp, at: now, raw };
      dirty = true;
    },
    flush() {
      if (!dirty || !store) return;
      for (const [k, v] of Object.entries(store)) if (now - v.at > KEEP_DAYS * 86_400_000) delete store[k];
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(store));
        renameSync(tmp, file);   // whole file or nothing: another command reading it never sees half of it
      } catch { /* the cache is an optimisation: failing to save it changes nothing */ }
      dirty = false;
    },
  };
}
