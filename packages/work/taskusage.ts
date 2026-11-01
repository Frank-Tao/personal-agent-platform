import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// What each task cost: runs, wall time and tokens. A kanban run says "profile P worked on task T from A to B"; a session of P that
// starts inside that window (a little slack either side) is that run's worker. Read-only; counts and times only, never text.

export interface TaskUsage { runs: number; started: number | null; ended: number | null; seconds: number; tokens: number; cost: number; models: string[] }

const SLACK_BEFORE = 30, SLACK_AFTER = 120;

export function taskUsage(hermesHome: string, board: string, taskIds: string[], now = Date.now() / 1000): Map<string, TaskUsage> {
  const out = new Map<string, TaskUsage>();
  const want = new Set(taskIds);
  const path = join(hermesHome, 'kanban', 'boards', board, 'kanban.db');
  if (!want.size || !existsSync(path)) return out;
  type Run = { task: string; profile: string; s: number; e: number | null };
  let runs: Run[] = [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    runs = (db.prepare('SELECT task_id task, COALESCE(profile, \'default\') profile, started_at s, ended_at e FROM task_runs').all() as Run[]);
  } catch { return out; } finally { db?.close(); }
  for (const r of runs) {
    if (!want.has(r.task)) continue;
    const u = out.get(r.task) ?? { runs: 0, started: null, ended: null, seconds: 0, tokens: 0, cost: 0, models: [] };
    u.runs++; u.seconds += Math.max(0, (r.e ?? now) - r.s);
    u.started = u.started === null ? r.s : Math.min(u.started, r.s);
    u.ended = r.e === null ? null : (u.ended === null && u.runs > 1 ? u.ended : Math.max(u.ended ?? 0, r.e));
    out.set(r.task, u);
  }
  if (!out.size) return out;
  const since = Math.min(...runs.filter((r) => want.has(r.task)).map((r) => r.s)) - SLACK_BEFORE;
  for (const profile of new Set(runs.filter((r) => want.has(r.task)).map((r) => r.profile))) {
    const sp = profile === 'default' ? join(hermesHome, 'state.db') : join(hermesHome, 'profiles', profile, 'state.db');
    if (!existsSync(sp)) continue;
    const mine = runs.filter((r) => r.profile === profile);
    let sdb: DatabaseSync | undefined;
    try {
      sdb = new DatabaseSync(sp, { readOnly: true });
      for (const s of sdb.prepare(`SELECT started_at ts, COALESCE(input_tokens,0)+COALESCE(output_tokens,0) tok, COALESCE(actual_cost_usd, estimated_cost_usd, 0) cost, COALESCE(NULLIF(model,''),'') model FROM sessions WHERE started_at >= ?`).all(since) as Array<{ ts: number; tok: number; cost: number; model: string }>) {
        let best: Run | null = null;
        for (const r of mine) if (s.ts >= r.s - SLACK_BEFORE && s.ts <= (r.e ?? now) + SLACK_AFTER && (!best || r.s > best.s)) best = r;
        const u = best && out.get(best.task);
        if (u) { u.tokens += s.tok; u.cost += s.cost; if (s.model && !u.models.includes(s.model)) u.models.push(s.model); }
      }
    } catch { /* a profile whose sessions cannot be read adds nothing */ } finally { sdb?.close(); }
  }
  return out;
}
