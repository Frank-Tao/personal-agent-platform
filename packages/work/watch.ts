import { MAX_HOPS } from './hops.ts';
import { SUBTASK_LINE, timeboxHours, type Project } from './model.ts';

// The watchdog: the charter's limits, enforced by code on a timer. Pure: it returns what to do; the CLI does it.

export interface WatchTask { id: string; status: string; tenant?: string | null; body?: string | null; created_by?: string | null }

export interface Verdict {
  /** Pause the project and hold its open tasks. */
  pause: boolean;
  reasons: string[];
  /** Open tasks that should be blocked while paused. */
  hold: string[];
}

const OPEN = new Set(['ready', 'todo', 'triage']);

/** `deepestHop` is the longest chain of agent-created tasks (packages/work/hops.ts); 0 when unknown. */
export function evaluateProject(p: Project, tasks: WatchTask[], laneMinutes: number, nowIso: string, deepestHop = 0): Verdict {
  const reasons: string[] = [];
  if (p.status !== 'active') return { pause: false, reasons, hold: [] };
  const live = tasks.filter((t) => t.status !== 'archived');
  // The limit counts ACTIVE top-level work: the plan's top-level tasks plus side tasks that are not from the plan (triage), not yet done.
  // Finished tasks, subtasks and the planning task do not count. Steps Hermes' auto-decomposer made inside a plan task are that task's own implementation, not new scope.
  const topLevel = live.filter((t) => t.status !== 'done' && !SUBTASK_LINE.test(t.body ?? '') && !/^\[(plan-for|triage-for):/.test((t.body ?? '').trim()) && t.created_by !== 'auto-decomposer').length;
  if (topLevel > p.charter.max_tasks) reasons.push(`over-scope: ${topLevel} active tasks, charter allows ${p.charter.max_tasks} (group related tasks under a parent: work plan regroup ${p.id})`);
  const limit = timeboxHours(p.timebox);
  const since = Date.parse(p.approved ?? p.created);
  if (limit && Number.isFinite(since) && (Date.parse(nowIso) - since) / 3_600_000 > limit) reasons.push(`over-timebox: more than ${p.timebox} since approval`);
  if (p.charter.budget.lane_minutes > 0 && laneMinutes > p.charter.budget.lane_minutes) reasons.push(`over-budget: ${Math.round(laneMinutes)} lane minutes, charter allows ${p.charter.budget.lane_minutes}`);
  if (deepestHop > MAX_HOPS) reasons.push(`runaway: tasks created by agents are ${deepestHop} levels deep, limit ${MAX_HOPS}`);
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
