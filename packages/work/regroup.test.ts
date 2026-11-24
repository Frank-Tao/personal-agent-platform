import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topoOrder, type PlanTask } from './model.ts';
import { suggestRegroup } from './regroup.ts';

const t = (key: string, needs: string[] = [], over: Partial<PlanTask> = {}): PlanTask => ({ key, title: key, owner: 'coding', lane: null, model: null, provider: null, needs, accept: 'ok', outward: null, workspace: null, max_runtime: '1h', goal: false, ...over } as PlanTask);
const none = () => null;

test('regroup: prerequisites that only one task needs become its subtasks until the active count is under the limit with headroom', () => {
  // two features, each: design → build → verify (verify needs the others); plus a release that needs both verifies
  const plan = [t('d1'), t('b1', ['d1']), t('v1', ['b1']), t('d2'), t('b2', ['d2']), t('v2', ['b2']), t('rel', ['v1', 'v2'])];
  const r = suggestRegroup({ plan, cap: 6, headroom: 1, status: none });
  assert.equal(r.activeBefore, 7);
  assert.equal(r.reached, true);
  assert.ok(r.activeAfter <= 5, `active ${r.activeAfter}`);
  assert.ok(r.groups.length >= 1);
  assert.ok(topoOrder(r.plan), 'the regrouped plan still has an order');
  for (const g of r.groups) for (const c of g.children) {
    const child = r.plan.find((x) => x.key === c)!, parent = r.plan.find((x) => x.key === g.parent)!;
    assert.equal(child.parent, g.parent);
    assert.ok(!parent.needs.includes(c), 'the parent no longer lists its subtask as a prerequisite (the subtask relation implies it)');
    assert.equal(r.plan.find((x) => x.key === g.parent)!.parent, undefined, 'a parent is top-level');
  }
  assert.deepEqual(plan.map((x) => x.parent), plan.map(() => undefined), 'the input is not modified');
});

test('regroup: nothing is moved that is running, finished, needed by something else, or that would wait for something new', () => {
  const running = suggestRegroup({ plan: [t('a'), t('b', ['a']), t('c', ['b'])], cap: 2, headroom: 0, status: (k) => (k === 'b' ? 'running' : 'ready') });
  assert.deepEqual(running.groups, [], 'a running task is left alone');
  assert.equal(running.reached, false);
  const doneTask = suggestRegroup({ plan: [t('a'), t('b', ['a']), t('c', ['b'])], cap: 2, headroom: 0, status: (k) => (k === 'c' ? 'done' : 'ready') });
  assert.equal(doneTask.activeBefore, 2, 'a finished task does not count');
  assert.deepEqual(doneTask.groups, []);
  // x is needed by two other tasks: it is never somebody's subtask
  const shared = suggestRegroup({ plan: [t('x'), t('y', ['x']), t('z', ['x'])], cap: 2, headroom: 0, status: none });
  assert.ok(!shared.groups.some((g) => g.children.includes('x')));
  // moved together, the prerequisites inherit nothing from their parent: both can become its subtasks
  const together = suggestRegroup({ plan: [t('base'), t('c1'), t('p', ['c1', 'base'])], cap: 2, headroom: 0, status: none });
  assert.deepEqual(together.groups, [{ parent: 'p', children: ['c1', 'base'] }]);
  // but a prerequisite that stays behind (other is also needed by q) would be inherited by c1, which does not wait for it: c1 stays top-level
  const inherit = suggestRegroup({ plan: [t('other'), t('c1'), t('p', ['c1', 'other']), t('q', ['other'])], cap: 3, headroom: 0, status: none });
  assert.ok(!inherit.groups.some((g) => g.children.includes('c1')), 'c1 would start to wait for other');
  const behind = suggestRegroup({ plan: [t('base'), t('c1', ['base']), t('p', ['c1', 'base'])], cap: 2, headroom: 0, status: none });
  assert.deepEqual(behind.groups, [{ parent: 'p', children: ['c1'] }], 'c1 already waits for base: nothing new');
  assert.deepEqual(behind.plan.find((x) => x.key === 'p')!.needs, ['base']);
  for (const r of [running, doneTask, shared, together, inherit, behind]) assert.ok(topoOrder(r.plan));
});

test('regroup: a board task is only grouped with a task that is also on the board; at most thirty subtasks per parent; an existing parent cannot become a subtask', () => {
  const plan = [t('b'), t('c', ['b'])];
  assert.deepEqual(suggestRegroup({ plan, cap: 1, headroom: 0, status: (k) => (k === 'c' ? 'todo' : null) }).groups, [], 'c is on the board, b is not yet');
  assert.equal(suggestRegroup({ plan, cap: 1, headroom: 0, status: none }).groups.length, 1);
  const siblings = (n: number) => [...Array.from({ length: n }, (_, i) => t(`s${i}`)), t('p', Array.from({ length: n }, (_, i) => `s${i}`))];
  const nine = suggestRegroup({ plan: siblings(30), cap: 5, headroom: 0, status: none });
  assert.deepEqual([nine.groups[0].children.length, nine.activeAfter], [30, 1], 'thirty prerequisites fit under one parent');
  // thirty-three do not: only thirty could move, and those would then wait for the three left behind, which changes how the work runs
  const twelve = suggestRegroup({ plan: siblings(33), cap: 5, headroom: 0, status: none });
  assert.deepEqual(twelve.groups, []);
  assert.equal(twelve.reached, false);
  const nested = [t('a'), t('b', ['a']), t('c', ['b']), t('d', ['c'])];
  const n = suggestRegroup({ plan: nested, cap: 1, headroom: 0, status: none });
  for (const g of n.groups) assert.ok(!n.plan.find((x) => x.key === g.parent)!.parent, 'two levels only');
  assert.ok(topoOrder(n.plan));
});
