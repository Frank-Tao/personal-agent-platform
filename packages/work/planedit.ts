import { TASK_KEY, type PlanTask } from './model.ts';

// Editing a plan from Cockpit or the CLI. Pure: returns a new plan or an error; the caller validates it with checkPlan.
// Plan edits are below the charter, so they need no approval; the 9-task cap and team limits still apply (checkPlan).

export type PlanOp =
  | { op: 'move'; key: string; to: number }
  | { op: 'remove'; key: string }
  | { op: 'add'; task: Partial<PlanTask> & { key: string; title: string; owner: string; accept: string } }
  | { op: 'set'; key: string; fields: Partial<Pick<PlanTask, 'title' | 'owner' | 'lane' | 'accept' | 'max_runtime' | 'needs' | 'outward' | 'model' | 'provider'>> };

const SETTABLE = new Set(['title', 'owner', 'lane', 'accept', 'max_runtime', 'needs', 'outward', 'model', 'provider']);

export function editPlan(plan: PlanTask[], op: PlanOp): { plan: PlanTask[] } | { error: string } {
  const idx = (k: string) => plan.findIndex((t) => t.key === k);
  if (op.op === 'add') {
    const t = op.task;
    if (!TASK_KEY.test(t.key)) return { error: `bad task key "${t.key}"` };
    if (idx(t.key) >= 0) return { error: `task "${t.key}" already exists` };
    const full: PlanTask = { lane: null, model: null, provider: null, needs: [], outward: null, workspace: null, max_runtime: '2h', goal: false, ...t };
    return { plan: [...plan, full] };
  }
  const i = idx(op.key);
  if (i < 0) return { error: `no task "${op.key}" in the plan` };
  if (op.op === 'remove') {
    const dependants = plan.filter((t) => t.needs.includes(op.key)).map((t) => t.key);
    if (dependants.length) return { error: `${dependants.join(', ')} depend on "${op.key}"; remove or re-point them first` };
    return { plan: plan.filter((_, j) => j !== i) };
  }
  if (op.op === 'move') {
    if (!Number.isInteger(op.to) || op.to < 1 || op.to > plan.length) return { error: `position must be 1–${plan.length}` };
    const next = plan.slice();
    const [t] = next.splice(i, 1);
    next.splice(op.to - 1, 0, t);
    return { plan: next };
  }
  const bad = Object.keys(op.fields).filter((k) => !SETTABLE.has(k));
  if (bad.length) return { error: `cannot set ${bad.join(', ')}` };
  return { plan: plan.map((t, j) => (j === i ? { ...t, ...op.fields } : t)) };
}
