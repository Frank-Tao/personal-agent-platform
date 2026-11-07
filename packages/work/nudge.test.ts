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
