import { timeboxHours, type Project } from './model.ts';

// The watchdog: the charter's limits, enforced by code on a timer. Pure: it returns what to do; the CLI does it.

export interface WatchTask { id: string; status: string; tenant?: string | null }

export interface Verdict {
  /** Pause the project and hold its open tasks. */
  pause: boolean;
  reasons: string[];
  /** Open tasks that should be blocked while paused. */
  hold: string[];
}

const OPEN = new Set(['ready', 'todo', 'triage']);

export function evaluateProject(p: Project, tasks: WatchTask[], laneMinutes: number, nowIso: string): Verdict {
  const reasons: string[] = [];
  if (p.status !== 'active') return { pause: false, reasons, hold: [] };
  const live = tasks.filter((t) => t.status !== 'archived');
  if (live.length > p.charter.max_tasks) reasons.push(`over-scope: ${live.length} tasks, charter allows ${p.charter.max_tasks}`);
  const limit = timeboxHours(p.timebox);
  const since = Date.parse(p.approved ?? p.created);
  if (limit && Number.isFinite(since) && (Date.parse(nowIso) - since) / 3_600_000 > limit) reasons.push(`over-timebox: more than ${p.timebox} since approval`);
  if (p.charter.budget.lane_minutes > 0 && laneMinutes > p.charter.budget.lane_minutes) reasons.push(`over-budget: ${Math.round(laneMinutes)} lane minutes, charter allows ${p.charter.budget.lane_minutes}`);
  return { pause: reasons.length > 0, reasons, hold: reasons.length ? live.filter((t) => OPEN.has(t.status)).map((t) => t.id) : [] };
}

/** Minutes of agent run time in `hermes kanban runs --json`. Fields vary by version, so read what is there and ignore the rest. */
export function runMinutes(runs: unknown): number {
  if (!Array.isArray(runs)) return 0;
  const at = (v: unknown): number | null => (typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
  let ms = 0;
  for (const r of runs as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.duration_seconds === 'number') ms += r.duration_seconds * 1000;
    else if (typeof r.elapsed_seconds === 'number') ms += r.elapsed_seconds * 1000;
    else {
      const a = at(r.started_at ?? r.start), b = at(r.ended_at ?? r.finished_at ?? r.end);
      if (a !== null && b !== null && b >= a) ms += b - a;
    }
  }
  return ms / 60_000;
}

/** Did a human (or the watchdog asking for one) have to step in on this task? From `hermes kanban show --json` events. */
const TOUCH = new Set(['unblocked', 'reassigned', 'changes_requested', 'reopened', 'edited', 'reclaimed']);
export function needsHuman(events: unknown): boolean {
  if (!Array.isArray(events)) return false;
  return (events as Array<{ kind?: string; payload?: { reason?: string } }>).some((e) => e && (TOUCH.has(String(e.kind)) || (e.kind === 'blocked' && e.payload?.reason !== 'initial_status')));
}
