import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Where each agent's tokens went in a window: per portfolio and per project (kanban tenant). Same method as taskusage.ts: a kanban run says
// "profile P worked on task T from A to B"; a session of P starting inside that window belongs to that task's board and project. Sessions
// that match no run (chat, cron, planning outside a task) are "other". Read-only; counts only, never text.

export interface AgentTraffic { tokens: number; sessions: number; other: number; byPortfolio: Record<string, { tokens: number; projects: Record<string, number> }> }

const SLACK_BEFORE = 30, SLACK_AFTER = 120;
type Run = { s: number; e: number | null; group: string; project: string };

export function agentTraffic(hermesHome: string, groupOfBoard: (board: string) => string | undefined, days = 7, now = Date.now() / 1000): Map<string, AgentTraffic> {
  const since = now - days * 86_400;
  const runs = new Map<string, Run[]>();
  const boardsDir = join(hermesHome, 'kanban', 'boards');
  let boards: string[] = [];
  try { boards = readdirSync(boardsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name); } catch { /* no boards */ }
  for (const board of boards) {
    const path = join(boardsDir, board, 'kanban.db');
    if (!existsSync(path)) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const rows = db.prepare(`SELECT COALESCE(r.profile,'default') profile, r.started_at s, r.ended_at e, t.tenant tenant, t.title title FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE COALESCE(r.ended_at, ?) >= ?`).all(now, since - SLACK_BEFORE) as Array<{ profile: string; s: number; e: number | null; tenant: string | null; title: string }>;
      for (const r of rows) {
        const list = runs.get(r.profile) ?? [];
        list.push({ s: r.s, e: r.e, group: groupOfBoard(board) ?? board, project: r.tenant || 'no project' });
        runs.set(r.profile, list);
      }
    } catch { /* an unreadable board adds nothing */ } finally { db?.close(); }
  }
  const out = new Map<string, AgentTraffic>();
  const profiles = ['default'];
  try { for (const d of readdirSync(join(hermesHome, 'profiles'), { withFileTypes: true })) if (d.isDirectory()) profiles.push(d.name); } catch { /* none */ }
  for (const profile of profiles) {
    const sp = profile === 'default' ? join(hermesHome, 'state.db') : join(hermesHome, 'profiles', profile, 'state.db');
    if (!existsSync(sp)) continue;
    const mine = runs.get(profile) ?? [];
    const t: AgentTraffic = { tokens: 0, sessions: 0, other: 0, byPortfolio: {} };
    let sdb: DatabaseSync | undefined;
    try {
      sdb = new DatabaseSync(sp, { readOnly: true });
      for (const s of sdb.prepare(`SELECT started_at ts, COALESCE(input_tokens,0)+COALESCE(output_tokens,0) tok FROM sessions WHERE started_at >= ?`).all(since) as Array<{ ts: number; tok: number }>) {
        let best: Run | null = null;
        for (const r of mine) if (s.ts >= r.s - SLACK_BEFORE && s.ts <= (r.e ?? now) + SLACK_AFTER && (!best || r.s > best.s)) best = r;
        t.tokens += s.tok; t.sessions++;
        if (!best) { t.other += s.tok; continue; }
        const g = (t.byPortfolio[best.group] ??= { tokens: 0, projects: {} });
        g.tokens += s.tok; g.projects[best.project] = (g.projects[best.project] ?? 0) + s.tok;
      }
    } catch { continue; } finally { sdb?.close(); }
    out.set(profile, t);
  }
  return out;
}
