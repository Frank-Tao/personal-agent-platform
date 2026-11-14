import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hopDepths, overHopLimit, MAX_HOPS } from './hops.ts';
import { evaluateProject } from './watch.ts';
import { whyTask } from './why.ts';
import { parseProject } from './model.ts';

// Failure guarded: agents creating tasks that create tasks forever, with nothing counting the depth.

const chain = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, created_by: 'atlas', parents: i ? [`t${i - 1}`] : [] }));

test('depth: people and `work` start a chain at 0; each agent-created task adds one past its deepest parent', () => {
  const d = hopDepths([{ id: 'a', created_by: 'work' }, { id: 'b', created_by: 'atlas', parents: ['a'] }, { id: 'c', created_by: 'coding', parents: ['b'] }, { id: 'x', created_by: 'user', parents: ['c'] }]);
  assert.deepEqual([d.get('a'), d.get('b'), d.get('c'), d.get('x')], [0, 1, 2, 0]);
});

test('limit: a chain of 9 agent-created tasks trips the breaker, 8 does not; a parent cycle terminates', () => {
  assert.equal(overHopLimit(chain(MAX_HOPS)), null);
  assert.deepEqual(overHopLimit(chain(MAX_HOPS + 1)), { id: `t${MAX_HOPS}`, depth: MAX_HOPS + 1 });
  assert.ok(hopDepths([{ id: 'p', created_by: 'a', parents: ['q'] }, { id: 'q', created_by: 'a', parents: ['p'] }]).size > 0);
});

test('watchdog: a runaway chain pauses the project and holds its open tasks', () => {
  const p = parseProject('---\nid: x\nportfolio: micropace\nstatus: active\ncreated: 2026-11-01\napproved: 2026-11-01\ntimebox: 30d\ncharter:\n  max_tasks: 9\n---\n').project;
  const ok = evaluateProject(p, [{ id: 'a', status: 'ready' }], 0, '2026-11-02T00:00:00Z', 8);
  assert.equal(ok.pause, false);
  const bad = evaluateProject(p, [{ id: 'a', status: 'ready' }], 0, '2026-11-02T00:00:00Z', 9);
  assert.equal(bad.pause, true); assert.match(bad.reasons[0], /runaway.*9 levels deep, limit 8/); assert.deepEqual(bad.hold, ['a']);
});

test('why: names the project and plan task, what it waits for, hides heartbeats, shows the last failure', () => {
  const lines = whyTask({
    task: { id: 't_1', title: '[p] Build', status: 'blocked', assignee: 'coding', created_by: 'work', created_at: 1794045899, body: '[work:p:build]\nrest', last_failure_error: 'tests failed' },
    parents: [{ id: 't_0' }], children: [], events: [{ kind: 'created', created_at: 1794045899 }, { kind: 'heartbeat' }, { kind: 'blocked', created_at: 1794046000, payload: { reason: 'needs input' } }], runs: [],
  }, 0).join('\n');
  assert.match(lines, /project p, plan task "build"/); assert.match(lines, /waits for: t_0/); assert.match(lines, /1 heartbeats hidden/); assert.match(lines, /last failure: tests failed/); assert.match(lines, /hop 0/);
});
