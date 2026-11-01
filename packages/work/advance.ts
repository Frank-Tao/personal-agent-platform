import type { PlanTask, Project } from './model.ts';

// What should happen next to an approved project? Pure: the CLI does the action. Run every minute by Cockpit and every
// ten by launchd, so a project moves through plan → tasks → review without anyone pressing anything after the charter.

export const PLAN_MARKER = (id: string) => `[plan-for:${id}]`;
export const planMarkerOf = (body: string | null | undefined): string | null => (body ?? '').match(/^\[plan-for:([a-z0-9-]+)\]/)?.[1] ?? null;

export interface AdvTask { id: string; status: string; body?: string | null }

export type Action =
  | { do: 'ask-pm'; retry: boolean }
  | { do: 'apply-plan' }
  | { do: 'mark-review' }
  | { do: 'wait'; why: string }
  | { do: 'stalled'; why: string };

const DEAD = new Set(['archived']);
const FAILED = new Set(['blocked', 'crashed', 'failed', 'timed_out']);

/**
 * @param planning  every planning task made for this project (newest last)
 * @param work      the project's plan tasks as they exist in Hermes (by marker)
 * @param planDirty the plan differs from the one last applied (or was never applied)
 */
export function nextAction(p: Project, plan: PlanTask[], planning: AdvTask[], work: AdvTask[], planDirty: boolean, planValid = true): Action {
  if (p.status !== 'active') return { do: 'wait', why: `project is ${p.status}` };
  if (!plan.length) {
    const live = planning.filter((t) => !DEAD.has(t.status));
    const last = live.at(-1);
    if (!last) return { do: 'ask-pm', retry: false };
    if (last.status === 'done') return live.length < 2 ? { do: 'ask-pm', retry: true } : { do: 'stalled', why: 'pm finished twice without writing a plan' };
    if (FAILED.has(last.status)) return { do: 'stalled', why: `the planning task is ${last.status}` };
    return { do: 'wait', why: `pm is planning (${last.status})` };
  }
  if (planDirty) return planValid ? { do: 'apply-plan' } : { do: 'stalled', why: 'the plan does not pass its checks' };
  const live = work.filter((t) => !DEAD.has(t.status));
  if (live.length >= plan.length && live.length > 0 && live.every((t) => t.status === 'done')) return { do: 'mark-review' };
  return { do: 'wait', why: 'agents are working' };
}
