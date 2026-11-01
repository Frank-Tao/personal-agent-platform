import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyCharter, type PlanTask, type Project } from './model.ts';
import { nextAction, planMarkerOf } from './advance.ts';

const proj = (status: Project['status'] = 'active'): Project => ({ id: 'p1', portfolio: 'micropace', objective: null, key_results: [], status, owner: 'pm', tenant: 'p1', timebox: '7d', created: '2026-11-01', approved: '2026-11-01', repo: null, priority: 3, test_cmd: null, plan_sha: null, paused_reason: null, charter: emptyCharter({ outcome: 'x', done_when: ['y'], team: ['pm'] } as never) });
const t = (key: string): PlanTask => ({ key, title: key, owner: 'coding', lane: null, model: null, provider: null, needs: [], accept: 'a', outward: null, workspace: null, max_runtime: '2h', goal: false });
const k = (status: string) => ({ id: 'x', status });

test('advance: an approved project with no plan asks pm once, waits while pm works, retries once, then reports it stalled', () => {
  assert.deepEqual(nextAction(proj(), [], [], [], true), { do: 'ask-pm', retry: false });
  assert.equal(nextAction(proj(), [], [k('ready')], [], true).do, 'wait');
  assert.equal(nextAction(proj(), [], [k('running')], [], true).do, 'wait');
  assert.deepEqual(nextAction(proj(), [], [k('done')], [], true), { do: 'ask-pm', retry: true });
  assert.equal(nextAction(proj(), [], [k('done'), k('done')], [], true).do, 'stalled');
  assert.equal(nextAction(proj(), [], [k('blocked')], [], true).do, 'stalled');
  assert.deepEqual(nextAction(proj(), [], [k('archived')], [], true), { do: 'ask-pm', retry: false });
});

test('advance: a written but unapplied (or changed) plan is applied by code, if it passes its checks', () => {
  assert.equal(nextAction(proj(), [t('a')], [k('done')], [], true).do, 'apply-plan');
  assert.equal(nextAction(proj(), [t('a')], [k('done')], [], true, false).do, 'stalled');
  assert.equal(nextAction(proj(), [t('a')], [k('done')], [k('ready')], false).do, 'wait');
});

test('advance: when every plan task is done the project goes to review; nothing happens to projects that are not active', () => {
  assert.equal(nextAction(proj(), [t('a'), t('b')], [], [k('done'), k('done')], false).do, 'mark-review');
  assert.equal(nextAction(proj(), [t('a'), t('b')], [], [k('done'), k('running')], false).do, 'wait');
  assert.equal(nextAction(proj(), [t('a'), t('b')], [], [k('done')], false).do, 'wait'); // one task not created yet
  for (const s of ['proposed', 'paused', 'review', 'done', 'cancelled'] as const) assert.equal(nextAction(proj(s), [], [], [], true).do, 'wait');
});

test('planning tasks are found by their marker', () => {
  assert.equal(planMarkerOf('[plan-for:notice-v1]\nbody'), 'notice-v1');
  assert.equal(planMarkerOf('[work:notice-v1:gate]'), null);
  assert.equal(planMarkerOf(null), null);
});
