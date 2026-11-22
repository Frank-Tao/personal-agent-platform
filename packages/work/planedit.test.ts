import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editPlan } from './planedit.ts';
import type { PlanTask } from './model.ts';

const T = (o: Partial<PlanTask> & { key: string }): PlanTask => ({ title: o.key, owner: 'coding', accept: 'x', lane: null, model: null, provider: null, needs: [], outward: null, workspace: null, max_runtime: '2h', goal: false, ...o });
const add = (plan: PlanTask[], task: Partial<PlanTask> & { key: string }) => editPlan(plan, { op: 'add', task: { title: task.key, owner: 'coding', accept: 'x', ...task } });
const planOf = (r: ReturnType<typeof editPlan>): PlanTask[] => { assert.ok('plan' in r, JSON.stringify(r)); return (r as { plan: PlanTask[] }).plan; };

test('a requirement becomes at most three top-level tasks: one build, one verify, one release; the rest go under them as subtasks', () => {
  let plan: PlanTask[] = [T({ key: 'r', owner: 'pm', desc: 'ask' })];
  plan = planOf(add(plan, { key: 'r-build', req: 'r', role: 'build' }));
  // a second build is refused and pointed at the first
  const dup = add(plan, { key: 'r-build-2', req: 'r', role: 'build' });
  assert.match((dup as { error: string }).error, /one build task per requirement.*--parent r-build/);
  // as a subtask (another agent's part, a second piece of work) it is fine, and so is a different agent
  plan = planOf(add(plan, { key: 'r-build-ui', req: 'r', role: 'build', parent: 'r-build' }));
  plan = planOf(add(plan, { key: 'r-study', req: 'r', owner: 'personal', parent: 'r-build' }));
  plan = planOf(add(plan, { key: 'r-verify', req: 'r', role: 'verify', owner: 'qa', needs: ['r-build'] }));
  plan = planOf(add(plan, { key: 'r-release', req: 'r', role: 'release', needs: ['r-verify'] }));
  // a fourth top-level task for the same requirement is refused
  const fourth = add(plan, { key: 'r-extra', req: 'r' });
  assert.match((fourth as { error: string }).error, /already has 3 top-level tasks \(build, verify, release\): at most 3/);
  // ...but a subtask of any of them is allowed, and tasks of other requirements or of none are not affected
  plan = planOf(add(plan, { key: 'r-frank', req: 'r', owner: 'you', parent: 'r-release' }));
  plan = planOf(add(plan, { key: 'other', owner: 'coding' }));
  plan = planOf(add(plan, { key: 'other2', req: 'r2', role: 'build' }));
  assert.equal(plan.length, 9);
});

test('plans that already exist are not rewritten by the rule: it only governs what is added', () => {
  const old = [T({ key: 'r', owner: 'pm', desc: 'ask' }), T({ key: 'a', req: 'r', role: 'verify' }), T({ key: 'b', req: 'r', role: 'verify' }), T({ key: 'c', req: 'r', role: 'build' }), T({ key: 'd', req: 'r' })];
  const r = editPlan(old, { op: 'set', key: 'a', fields: { title: 'renamed' } });
  assert.ok('plan' in r);
  assert.ok(editPlan(old, { op: 'remove', key: 'd' }).hasOwnProperty('plan'));
});
