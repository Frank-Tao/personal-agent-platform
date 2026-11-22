import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedRuns, nudgeTask, pickStandin, delegatorOf, triageBody, type NudgeTask } from './nudge.ts';

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

// ---- the ladder: retry, delegator, stand-in, human ----
const R = { delegator: true, standin: true };
const gaveUp = [{ kind: 'gave_up', created_at: NOW - 3600, payload: null }];
const retried = { author: 'work', body: '[auto-retry 1] x' };

test('after the retry the stuck task goes back to whoever delegated it, not to the human', () => {
  assert.deepEqual(nudgeTask(T({ events: gaveUp, comments: [retried] }), NOW, agents, R), { do: 'triage', id: 't1', why: 'still blocked after 1 automatic retry', round: 1 });
});

test('a block that a retry cannot clear (needs_input, capability) skips the blind retry and goes to the delegator', () => {
  const ev = [{ kind: 'blocked', created_at: NOW - 600, payload: { kind: 'needs_input', reason: 'which API?' } }];
  assert.equal(nudgeTask(T({ events: ev }), NOW, agents, R)?.do, 'triage');
});

test('while the triage task is open, wait; once it is spent, a different agent takes over', () => {
  const c = [retried, { author: 'work', body: '[auto-triage 1 t_aa11] handed' }];
  assert.equal(nudgeTask(T({ events: gaveUp, comments: c, triageStatus: { t_aa11: 'running' } }), NOW, agents, R), null);
  assert.equal(nudgeTask(T({ events: gaveUp, comments: c, triageStatus: { t_aa11: 'done' } }), NOW, agents, R)?.do, 'swap');
});

test('a second triage follows a failed stand-in, then the human; a rung nobody can run is skipped', () => {
  const c1 = [retried, { author: 'work', body: '[auto-triage 1 t_aa11]' }, { author: 'work', body: '[auto-swap from=a to=b]' }];
  assert.deepEqual(nudgeTask(T({ events: gaveUp, comments: c1, triageStatus: { t_aa11: 'done' } }), NOW, agents, R), { do: 'triage', id: 't1', why: 'still blocked after 1 automatic retry', round: 2 });
  const c2 = [...c1, { author: 'work', body: '[auto-triage 2 t_bb22]' }];
  assert.equal(nudgeTask(T({ events: gaveUp, comments: c2, triageStatus: { t_aa11: 'done', t_bb22: 'done' } }), NOW, agents, R)?.do, 'escalate');
  assert.equal(nudgeTask(T({ events: gaveUp, comments: [retried] }), NOW, agents, { standin: true })?.do, 'swap');
  assert.equal(nudgeTask(T({ events: gaveUp, comments: [retried] }), NOW, agents, {})?.do, 'escalate');
});

test('the delegator can say a person is needed, and that ends the automatic attempts', () => {
  const c = [retried, { author: 'pm', body: '[needs-human] needs the App Store password' }];
  assert.equal(nudgeTask(T({ events: gaveUp, comments: c }), NOW, agents, R)?.do, 'escalate');
});

test('the delegator is the creating agent, else the project lead, never the stuck agent', () => {
  assert.equal(delegatorOf(T({ assignee: 'coding', createdBy: 'architect' }), 'pm', new Set(['coding', 'architect', 'pm'])), 'architect');
  assert.equal(delegatorOf(T({ assignee: 'coding', createdBy: 'auto-decomposer' }), 'pm', new Set(['coding', 'pm'])), 'pm');
  assert.equal(delegatorOf(T({ assignee: 'pm', createdBy: 'work' }), 'pm', new Set(['pm'])), null);
});

const roster = [
  { id: 'atlas', state: 'active', portfolios: [], allPortfolios: true, lanes: [] },
  { id: 'coding', state: 'active', portfolios: ['investments', 'family'], lanes: ['claude'], engineering: true },
  { id: 'architect', state: 'active', portfolios: ['investments'], lanes: ['claude'], engineering: true },
  { id: 'qa', state: 'active', portfolios: ['investments'], lanes: ['claude'], engineering: true },
  { id: 'personal', state: 'active', portfolios: ['investments', 'family'], lanes: ['ollama'] },
  { id: 'finance', state: 'active', portfolios: ['investments'], lanes: ['codex'] },
  { id: 'research', state: 'proposed', portfolios: ['investments'], lanes: ['codex'] },
];
test('a stand-in is the same kind of agent, active, untried and on the same portfolio', () => {
  assert.equal(pickStandin('coding', 'investments', new Set(['coding']), roster), 'architect');
  assert.equal(pickStandin('coding', 'investments', new Set(['coding', 'architect']), roster), null);   // qa never stands in for a builder
});
test('work of a local-only agent never moves to a cloud lane, and nothing else moves onto it', () => {
  assert.equal(pickStandin('personal', 'investments', new Set(['personal']), roster), null);
  assert.equal(pickStandin('finance', 'investments', new Set(['finance']), roster), null);   // the local-only agent is no stand-in for a cloud one
});

test('the triage brief names the task, what failed and the exact moves', () => {
  const b = triageBody({ board: 'investments', project: 'p1', id: 't_9', title: 'Audit', assignee: 'personal', round: 1, error: 'crash x2', summary: '', recent: [], tried: ['personal'], standin: null });
  assert.match(b, /^\[triage-for: t_9\]/);
  assert.match(b, /hermes kanban --board investments reassign t_9/);
  assert.match(b, /\[needs-human\]/);
});

test('five failed runs stop the agents: the task waits for the human, whatever rung it was on', () => {
  const crash = (n: number) => ({ kind: 'crashed', created_at: NOW - 3600 + n, run_id: n, payload: null });
  const four = [1, 2, 3, 4].map(crash), five = [1, 2, 3, 4, 5].map(crash);
  assert.equal(failedRuns([...five, { kind: 'gave_up' }, { kind: 'crashed', run_id: 5 }] as never), 5);   // one run, several events: counted once
  assert.equal(nudgeTask(T({ events: four, comments: [retried] }), NOW, agents, R)?.do, 'triage');
  const a = nudgeTask(T({ events: five, comments: [retried] }), NOW, agents, R);
  assert.equal(a?.do, 'escalate');
  assert.match((a as { why: string }).why, /failed 5 times/);
  // ...but a person rewording it still gets it re-run
  assert.equal(nudgeTask(T({ events: [...five, { kind: 'edited', created_at: NOW - 10 }], comments: [retried] }), NOW, agents, R)?.do, 'retry');
});
