import { MAX_SUBTASKS, isFinishedStatus, topoOrder, type PlanTask } from './model.ts';

// Over the limit of active tasks? Group them. A parent task wraps its subtasks (it runs last, after they are done) and only the parent counts
// against the limit. The natural candidates are tasks that exist only as prerequisites of ONE other task: they become that task's subtasks.
//
// A subtask also waits for whatever its parent waited for, so a task is only moved when that adds no new waiting (the parent's other
// prerequisites are already behind it), which also rules out cycles. Tasks that are running or in review are not touched, and a task is only
// grouped with one that is in the same state of existing (both already in Hermes, or neither yet), so the board and the plan stay in step.

export interface Group { parent: string; children: string[] }
export interface RegroupResult { groups: Group[]; plan: PlanTask[]; activeBefore: number; activeAfter: number; target: number; reached: boolean }

/** Statuses a task may be moved in; a task that is not in Hermes yet (null) can always be moved. */
const MOVABLE = new Set(['todo', 'ready', 'blocked', 'triage']);

export function suggestRegroup(i: { plan: PlanTask[]; cap: number; headroom?: number; status: (key: string) => string | null }): RegroupResult {
  const plan = i.plan.map((t) => ({ ...t, needs: [...t.needs] }));
  const by = new Map(plan.map((t) => [t.key, t]));
  const finished = (k: string) => isFinishedStatus(i.status(k));
  const movable = (k: string) => { const s = i.status(k); return s === null || MOVABLE.has(s); };
  const exists = (k: string) => i.status(k) !== null;
  const activeTop = () => plan.filter((t) => !t.parent && !finished(t.key)).length;
  const target = Math.max(1, i.cap - (i.headroom ?? 2));
  const activeBefore = activeTop();
  const groups = new Map<string, string[]>();

  /** Everything a task waits for, directly or through others (a subtask also waits for its parent's prerequisites). */
  const closure = (k: string): Set<string> => {
    const seen = new Set<string>(), stack = [k];
    while (stack.length) {
      const t = by.get(stack.pop()!);
      if (!t) continue;
      for (const n of [...t.needs, ...(t.parent ? by.get(t.parent)?.needs ?? [] : [])]) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    return seen;
  };
  const banned = new Set<string>();

  while (activeTop() > target) {
    let best: { parent: string; children: string[] } | null = null;
    for (const P of plan) {
      if (P.parent || finished(P.key) || !movable(P.key) || banned.has(P.key)) continue;
      const room = MAX_SUBTASKS - plan.filter((x) => x.parent === P.key).length;
      if (room <= 0) continue;
      let eligible = P.needs.filter((ck) => {
        const C = by.get(ck);
        if (!C || C.parent || C.key === P.key || finished(ck) || !movable(ck) || exists(ck) !== exists(P.key)) return false;
        if (plan.some((x) => x.parent === ck)) return false;                                   // two levels only: a parent cannot become a subtask
        if (plan.some((x) => x.key !== P.key && x.parent !== P.key && !finished(x.key) && x.needs.includes(ck))) return false;   // something else also needs it
        return !closure(ck).has(P.key);
      }).slice(0, room);
      // A subtask waits for whatever its parent waits for. Once the children are moved the parent no longer lists them, so what they inherit is
      // the parent's remaining prerequisites: a child stays only if it is already behind all of them. Dropping one can add to what the rest
      // inherit, so repeat until it settles.
      for (let again = true; again && eligible.length;) {
        const inherited = P.needs.filter((n) => !eligible.includes(n));
        const keep = eligible.filter((ck) => { const behind = closure(ck); return inherited.every((n) => behind.has(n)); });
        again = keep.length !== eligible.length; eligible = keep;
      }
      if (eligible.length && (!best || eligible.length > best.children.length)) best = { parent: P.key, children: eligible };
    }
    if (!best) break;
    // apply the group to a copy and keep it only if the plan still has an order (no cycle)
    const P = by.get(best.parent)!;
    const before = { needs: P.needs, parents: best.children.map((k) => [k, by.get(k)!.parent] as const) };
    P.needs = P.needs.filter((n) => !best!.children.includes(n));
    for (const k of best.children) by.get(k)!.parent = best.parent;
    if (!topoOrder(plan)) {
      P.needs = before.needs;
      for (const [k, par] of before.parents) { if (par === undefined) delete by.get(k)!.parent; else by.get(k)!.parent = par; }
      banned.add(best.parent);
      continue;
    }
    groups.set(best.parent, [...(groups.get(best.parent) ?? []), ...best.children]);
  }
  const after = activeTop();
  return { groups: [...groups].map(([parent, children]) => ({ parent, children })), plan, activeBefore, activeAfter: after, target, reached: after <= target };
}
