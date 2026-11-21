import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nudgeTask, type NudgeTask } from './nudge.ts';

const agents = new Set(['coding', 'qa', 'pm']);
const T = (o: Partial<NudgeTask>): NudgeTask => ({ id: 't1', status: 'blocked', parents: [], events: [], comments: [], ...o });
const NOW = 100_000;

test('a todo task whose parents are all done is promoted', () => {
  assert.equal(nudgeTask(T({ status: 'todo', parents: [{ id: 'a', status: 'done' }] }), NOW, agents)?.do, 'promote');
  assert.equal(nudgeTask(T({ status: 'todo', parents: [{ id: 'a', status: 'done' }, { id: 'b', status: 'running' }] }), NOW, agents), null);
});

test('a task blocked for a capability or needs_input is escalated, never retried blindly', () => {
  const ev = [{ kind: 'blocked', created_at: NOW - 7200, payload: { kind: 'capability', reason: 'write denied' } }];
  assert.equal(nudgeTask(T({ events: ev }), NOW, agents)?.do, 'escalate');
});

test('a spawn failure is retried once after 30 minutes, then escalated', () => {
  const ev = [{ kind: 'gave_up', created_at: NOW - 3600, payload: null }];
  assert.equal(nudgeTask(T({ events: [{ kind: 'gave_up', created_at: NOW - 600 }] }), NOW, agents), null);
  assert.deepEqual(nudgeTask(T({ events: ev }), NOW, agents), { do: 'retry', id: 't1', why: 'blocked for 60 min with no one touching it', attempt: 1 });
  assert.equal(nudgeTask(T({ events: ev, comments: [{ author: 'work', body: '[auto-retry 1/1] x' }] }), NOW, agents)?.do, 'escalate');
});

test('rewording or a human comment after the block re-runs the task, even for needs_input', () => {
  const blocked = { kind: 'blocked', created_at: NOW - 600, payload: { kind: 'needs_input', reason: 'unclear' } };
  assert.equal(nudgeTask(T({ events: [blocked, { kind: 'edited', created_at: NOW - 100 }] }), NOW, agents)?.do, 'retry');
  assert.equal(nudgeTask(T({ events: [blocked, { kind: 'commented', created_at: NOW - 100, payload: { author: 'frank' } }] }), NOW, agents)?.do, 'retry');
  assert.equal(nudgeTask(T({ events: [blocked, { kind: 'commented', created_at: NOW - 100, payload: { author: 'qa' } }] }), NOW, agents)?.do, 'escalate');
});

test('other statuses are left alone', () => {
  assert.equal(nudgeTask(T({ status: 'running' }), NOW, agents), null);
  assert.equal(nudgeTask(T({ status: 'done' }), NOW, agents), null);
});

test('a project can pin the board its tasks live on, and the pin survives a save', async () => {
  const { parseProject, serializeProject } = await import('./model.ts');
  const md = ['---', 'id: p1', 'portfolio: investments', 'status: active', 'board: family', 'charter:', '  outcome: x', '  done_when: [a]', '  team: [pm]', '---', '', '## Plan', '', '## Log', ''].join('\n');
  const { project, body } = parseProject(md);
  assert.equal(project.board, 'family');
  assert.match(serializeProject(project, body), /^board: family$/m);
  assert.equal(parseProject(md.replace('board: family\n', '')).project.board, null);
});

test('a ready task held back by Hermes\' open-PR guard is spotted only after several guarded ticks, once, with its PR links', async () => {
  const { heldByPrGuard, REASSIGN_MARK } = await import('./nudge.ts');
  const now = 10_000;
  const guard = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'respawn_guarded', created_at: now - 60 * (n - i), payload: { reason: 'active_pr' } }));
  const base = { id: 't_1', status: 'ready', parents: [], events: guard(6), comments: [{ author: 'coding', body: 'PR https://github.com/o/r/pull/8 is open.' }, { body: 'again https://github.com/o/r/pull/8 and https://github.com/o/r/pull/9' }] };
  assert.deepEqual(heldByPrGuard(base, now), { prs: ['https://github.com/o/r/pull/8', 'https://github.com/o/r/pull/9'] });
  assert.equal(heldByPrGuard({ ...base, events: guard(3) }, now), null, 'not held for long enough');
  assert.equal(heldByPrGuard({ ...base, events: guard(6).map((e) => ({ ...e, created_at: now - 3600 })) }, now), null, 'not held right now');
  assert.equal(heldByPrGuard({ ...base, status: 'blocked' }, now), null);
  assert.equal(heldByPrGuard({ ...base, comments: [...base.comments, { body: `${REASSIGN_MARK}] done` }] }, now), null, 'only once');
  assert.equal(heldByPrGuard({ ...base, comments: [{ body: 'no links here' }] }, now), null);
});
