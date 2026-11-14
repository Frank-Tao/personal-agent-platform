// Hop circuit breaker: tasks that agents create can create more tasks. A chain deeper than MAX_HOPS is a runaway, not a plan.
// A task made by a person or by `work` starts a chain at 0; a task made by anything else is one hop past its deepest parent.

export const MAX_HOPS = 8;
export const HUMAN_CREATORS = new Set(['work', 'cockpit', 'user', 'frank', 'cli']);

export interface HopTask { id: string; created_by?: string | null; parents?: string[] }

/** Hop depth of every task, given the parents known for each. Unknown parents count as depth 0; a parent cycle is cut. */
export function hopDepths(tasks: HopTask[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, number>();
  const walk = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    const t = byId.get(id);
    if (!t || seen.has(id)) return 0;
    if (HUMAN_CREATORS.has(t.created_by ?? '')) { memo.set(id, 0); return 0; }
    seen.add(id);
    const d = 1 + Math.max(0, ...(t.parents ?? []).map((p) => walk(p, seen)));
    seen.delete(id);
    memo.set(id, d);
    return d;
  };
  for (const t of tasks) walk(t.id, new Set());
  return memo;
}

/** The deepest chain among `tasks`, or null when none passes the limit. */
export function overHopLimit(tasks: HopTask[], limit = MAX_HOPS): { id: string; depth: number } | null {
  let worst: { id: string; depth: number } | null = null;
  for (const [id, depth] of hopDepths(tasks)) if (depth > limit && (!worst || depth > worst.depth)) worst = { id, depth };
  return worst;
}
