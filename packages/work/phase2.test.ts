import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyCharter, type Project } from './model.ts';
import { decide } from './outbox.ts';
import { evaluateProject, runMinutes } from './watch.ts';

const proj = (over: Partial<Project> = {}, charter = {}): Project => ({
  id: 'p1', portfolio: 'micropace', objective: null, key_results: [], status: 'active', owner: 'pm', tenant: 'p1', timebox: '7d', created: '2026-11-01', approved: '2026-11-01',
  repo: null, plan_sha: null, paused_reason: null, charter: emptyCharter({ outcome: 'x', done_when: ['y'], team: ['pm'], ...charter } as never), ...over,
});

test('decide: deploy only to charter targets', () => {
  const p = proj({}, { outward: { deploy: { allowed: true, targets: ['preview.example.com'] } } });
  assert.equal(decide(p, { kind: 'deploy', target: 'preview.example.com', usd: 0 }).status, 'ready');
  assert.equal(decide(p, { kind: 'deploy', target: 'evil.example.com', usd: 0 }).status, 'denied');
  assert.equal(decide(proj(), { kind: 'deploy', target: 'x', usd: 0 }).status, 'denied');
});

test('decide: publish is draft-only by default, auto needs an approved channel and respects the weekly limit', () => {
  const draft = proj({}, { outward: { publish: { channels: ['blog'] } } });
  assert.equal(decide(draft, { kind: 'publish', target: 'blog', usd: 0 }).status, 'held');
  assert.equal(decide(draft, { kind: 'publish', target: 'twitter', usd: 0 }).status, 'denied');
  const auto = proj({}, { outward: { publish: { allowed: 'auto', channels: ['blog'], max_per_week: 2 } } });
  assert.equal(decide(auto, { kind: 'publish', target: 'blog', usd: 0 }, 1).status, 'ready');
  assert.equal(decide(auto, { kind: 'publish', target: 'blog', usd: 0 }, 2).status, 'held');
  assert.equal(decide(proj({}, { outward: { publish: { allowed: 'no' } } }), { kind: 'publish', target: 'blog', usd: 0 }).status, 'denied');
});

test('decide: spend is denied unless allowed and always waits for a human; paused projects deny everything', () => {
  const s = proj({}, { outward: { spend: { allowed: true, max_usd: 10 } } });
  assert.equal(decide(s, { kind: 'spend', target: 'api', usd: 5 }).status, 'held');
  assert.match(decide(s, { kind: 'spend', target: 'api', usd: 50 }).reason, /over the charter limit/);
  assert.equal(decide(proj(), { kind: 'spend', target: 'api', usd: 1 }).status, 'denied');
  assert.equal(decide({ ...s, status: 'paused' }, { kind: 'spend', target: 'api', usd: 1 }).status, 'denied');
});

test('watchdog: over scope, timebox and lane minutes pause the project and hold only open tasks', () => {
  const p = proj({}, { max_tasks: 2, budget: { usd: 0, lane_minutes: 60 } });
  const t = (id: string, status: string) => ({ id, status });
  const ok = evaluateProject(p, [t('a', 'ready'), t('b', 'done')], 10, '2026-11-02T00:00:00Z');
  assert.equal(ok.pause, false);
  const scope = evaluateProject(p, [t('a', 'ready'), t('b', 'running'), t('c', 'todo'), t('d', 'done')], 10, '2026-11-02T00:00:00Z');
  assert.deepEqual([scope.pause, scope.hold], [true, ['a', 'c']]);
  assert.match(evaluateProject(p, [t('a', 'ready')], 61, '2026-11-02T00:00:00Z').reasons[0], /over-budget/);
  assert.match(evaluateProject(p, [t('a', 'ready')], 1, '2026-11-09T00:00:00Z').reasons[0], /over-timebox/);
  assert.equal(evaluateProject({ ...p, status: 'paused' }, [t('a', 'ready'), t('b', 'ready'), t('c', 'ready')], 999, '2027-01-01T00:00:00Z').pause, false);
});

test('runMinutes reads whatever duration fields exist and ignores junk', () => {
  assert.equal(runMinutes([{ duration_seconds: 120 }, { started_at: '2026-11-01T00:00:00Z', ended_at: '2026-11-01T00:03:00Z' }, { started_at: 1, ended_at: 'x' }, null]), 5);
  assert.equal(runMinutes('nope'), 0);
});
