import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { needsHuman } from './watch.ts';
import { WORK_MARKER as MARKER } from './model.ts';

// Track record: trust is earned from outcomes, so this measures them. For every agent, over a window (4 weeks) and the window before it:
// how much it finished, how much passed the first time, how often it needed a person, how often it failed. And for every choice of owner
// (pm in a plan, Atlas or a person on the board), whether that choice worked out, next to the one-line reason given for it.
// Everything is read from Hermes' boards (read-only), the project plans, and data/staffing.jsonl. No tokens are spent.

export type Trust = 'new' | 'trusted' | 'steady' | 'watch';
export interface Window { done: number; firstPass: number; retries: number; neededYou: number; failures: number; medianMinutes: number | null }
export interface AgentCard { agent: string; now: Window; before: Window; open: number; blocked: number; trust: Trust; why: string }
export interface Pick { task: string; board: string; title: string; agent: string; by: string; why: string | null; at: number; outcome: 'first-pass' | 'needed-fixing' | 'open' }
export interface DeciderCard { by: string; picks: number; good: number; withReason: number; recent: Pick[] }
export interface Scorecard { since: string; days: number; agents: AgentCard[]; deciders: DeciderCard[] }
export interface StaffingRecord { at: string; board: string; task: string; agent: string; by: string; why: string }

/** Plan tasks' owner reasons, by "<project>/<key>": what pm wrote when it chose the owner. */
export type PlanReasons = Map<string, { owner: string; why: string | null }>;

const REWORK = new Set(['changes_requested', 'reopened', 'gave_up', 'crashed', 'worker_lost', 'block_loop_detected']);
const FAIL = new Set(['crashed', 'gave_up', 'worker_lost', 'spawn_failed']);

export const staffingLog = (data: string) => join(data, 'staffing.jsonl');
export function recordStaffing(data: string, r: StaffingRecord): void {
  mkdirSync(dirname(staffingLog(data)), { recursive: true });
  appendFileSync(staffingLog(data), JSON.stringify(r) + '\n');
}
export function readStaffing(data: string): StaffingRecord[] {
  try { return readFileSync(staffingLog(data), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as StaffingRecord]; } catch { return []; } }); } catch { return []; }
}

interface Row { board: string; id: string; title: string; assignee: string; status: string; created: number; completed: number | null; runs: number; runSecs: number; events: Array<{ kind: string; payload: { reason?: string } | null }>; marker: [string, string] | null; planning: boolean }

function readBoards(boardsDir: string, since: number): Row[] {
  const out: Row[] = [];
  let boards: string[] = [];
  try { boards = readdirSync(boardsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const b of boards) {
    const path = join(boardsDir, b, 'kanban.db');
    if (!existsSync(path)) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const tasks = db.prepare(`SELECT id, title, body, assignee, status, created_at, completed_at FROM tasks WHERE assignee IS NOT NULL AND assignee <> '' AND (status NOT IN ('done','archived') OR completed_at >= ?)`).all(since) as Array<{ id: string; title: string; body: string | null; assignee: string; status: string; created_at: number; completed_at: number | null }>;
      const runQ = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(COALESCE(ended_at, started_at) - started_at), 0) s FROM task_runs WHERE task_id = ?`);
      const evQ = db.prepare(`SELECT kind, payload FROM task_events WHERE task_id = ?`);
      for (const t of tasks) {
        const r = runQ.get(t.id) as { n: number; s: number };
        const events = (evQ.all(t.id) as Array<{ kind: string; payload: string | null }>).map((e) => { let p: { reason?: string } | null = null; try { p = e.payload ? JSON.parse(e.payload) : null; } catch { /* keep null */ } return { kind: e.kind, payload: p }; });
        const m = (t.body ?? '').match(MARKER);
        out.push({ board: b, id: t.id, title: t.title, assignee: t.assignee, status: t.status, created: t.created_at, completed: t.completed_at, runs: r.n, runSecs: r.s, events, marker: m ? [m[1], m[2]] : null, planning: /^\[plan-for:/.test(t.body ?? '') });
      }
    } catch { /* an unreadable board contributes nothing */ } finally { db?.close(); }
  }
  return out;
}

const firstPass = (r: Row) => r.status === 'done' && r.runs <= 1 && !needsHuman(r.events) && !r.events.some((e) => REWORK.has(e.kind));
const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]); };

function windowOf(rows: Row[]): Window {
  const done = rows.filter((r) => r.status === 'done');
  return {
    done: done.length,
    firstPass: done.filter(firstPass).length,
    retries: done.reduce((n, r) => n + Math.max(0, r.runs - 1), 0),
    neededYou: done.filter((r) => needsHuman(r.events)).length,
    failures: rows.reduce((n, r) => n + r.events.filter((e) => FAIL.has(e.kind)).length, 0),
    medianMinutes: median(done.filter((r) => r.runSecs > 0).map((r) => r.runSecs / 60)),
  };
}

/** The rule, in the open: few results → new; mostly first-time passes and rarely needing you → trusted; a weak or failing record → watch. */
export function trustOf(w: Window): { trust: Trust; why: string } {
  const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
  const fp = pct(w.firstPass, w.done), you = pct(w.neededYou, w.done);
  if (w.done < 5) return { trust: 'new', why: `${w.done} finished in the window: too few to judge (needs 5)` };
  if (fp < 60 || w.failures >= 3) return { trust: 'watch', why: fp < 60 ? `only ${fp}% passed the first time` : `${w.failures} crashes or give-ups` };
  if (fp >= 80 && you <= 10) return { trust: 'trusted', why: `${fp}% passed the first time, needed you on ${you}%` };
  return { trust: 'steady', why: `${fp}% passed the first time, needed you on ${you}%` };
}

export function buildScorecard(o: { boardsDir: string; plans: PlanReasons; staffing: StaffingRecord[]; now?: Date; days?: number }): Scorecard {
  const now = (o.now ?? new Date()).getTime() / 1000, days = o.days ?? 28;
  const start = now - days * 86_400, prevStart = start - days * 86_400;
  const rows = readBoards(o.boardsDir, prevStart);
  const inWin = (r: Row, a: number, b: number) => r.status === 'done' ? (r.completed ?? 0) >= a && (r.completed ?? 0) < b : false;
  const agents = [...new Set(rows.map((r) => r.assignee))].filter((a) => a !== 'default' || rows.some((r) => r.assignee === a && inWin(r, start, now + 1)));
  const cards: AgentCard[] = agents.map((agent) => {
    const mine = rows.filter((r) => r.assignee === agent);
    const nowW = windowOf(mine.filter((r) => inWin(r, start, now + 1) || (r.status !== 'done' && r.status !== 'archived' && r.created >= start)));
    const before = windowOf(mine.filter((r) => inWin(r, prevStart, start)));
    const t = trustOf(nowW);
    return { agent, now: nowW, before, open: mine.filter((r) => !['done', 'archived'].includes(r.status)).length, blocked: mine.filter((r) => r.status === 'blocked').length, trust: t.trust, why: t.why };
  }).filter((c) => c.now.done || c.before.done || c.open).sort((a, b) => b.now.done - a.now.done || a.agent.localeCompare(b.agent));

  // Who chose each owner: a staffing record (Atlas or a person on the board), else the plan (pm), else nobody said (Hermes' decomposer, a hand edit).
  const lastPick = new Map<string, StaffingRecord>();
  for (const s of o.staffing) lastPick.set(`${s.board}/${s.task}`, s);
  const picks: Pick[] = rows.filter((r) => r.created >= start || inWin(r, start, now + 1)).map((r) => {
    const s = lastPick.get(`${r.board}/${r.id}`);
    const plan = r.marker ? o.plans.get(`${r.marker[0]}/${r.marker[1]}`) : undefined;
    // the planning task is made by the work CLI for pm on every approved charter: a rule, not a choice
    const by = s ? s.by : plan ? 'pm' : r.planning ? 'rule' : 'unrecorded';
    const why = s ? s.why : plan?.why ?? (r.planning ? 'pm plans every approved project' : null);
    const outcome: Pick['outcome'] = r.status === 'done' ? (firstPass(r) ? 'first-pass' : 'needed-fixing') : 'open';
    return { task: r.id, board: r.board, title: r.title.slice(0, 100), agent: r.assignee, by, why, at: r.completed ?? r.created, outcome };
  });
  const deciders: DeciderCard[] = [...new Set(picks.map((p) => p.by))].map((by) => {
    const mine = picks.filter((p) => p.by === by), closed = mine.filter((p) => p.outcome !== 'open');
    return { by, picks: closed.length, good: closed.filter((p) => p.outcome === 'first-pass').length, withReason: mine.filter((p) => p.why).length, recent: mine.sort((a, b) => b.at - a.at).slice(0, 5) };
  }).sort((a, b) => b.picks - a.picks);
  return { since: new Date(start * 1000).toISOString(), days, agents: cards, deciders };
}

const pctTxt = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const trend = (n: Window, b: Window) => {
  if (!n.done || !b.done) return '';
  const d = Math.round(100 * n.firstPass / n.done) - Math.round(100 * b.firstPass / b.done);
  return d >= 5 ? ` (↑ from ${pctTxt(b.firstPass, b.done)})` : d <= -5 ? ` (↓ from ${pctTxt(b.firstPass, b.done)})` : '';
};
export const TRUST_WORD: Record<Trust, string> = { new: 'new', trusted: 'trusted', steady: 'steady', watch: 'watch' };

/** Plain-text lines for the digest and the terminal. */
export function scorecardLines(s: Scorecard, max = 8): string[] {
  const out = s.agents.slice(0, max).map((c) => `${c.agent} · ${c.now.done} done · ${pctTxt(c.now.firstPass, c.now.done)} first time${trend(c.now, c.before)} · needed you ${c.now.neededYou} · ${TRUST_WORD[c.trust]}${c.blocked ? ` · ${c.blocked} blocked now` : ''}`);
  const who = (by: string) => (by === 'unrecorded' ? 'no reason recorded' : by);
  const picks = s.deciders.filter((d) => d.picks).map((d) => `${who(d.by)} ${d.good}/${d.picks} good`);
  if (picks.length) out.push(`Owner choices that worked first time: ${picks.join(' · ')}`);
  return out;
}
