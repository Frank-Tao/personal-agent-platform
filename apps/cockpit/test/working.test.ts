import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeWorking, STALL_AFTER } from '../src/working.ts';

const row = (o: Partial<Parameters<typeof shapeWorking>[0][0]['rows'][0]> = {}) => ({ id: 't_a1', title: '[notice-v1] Build the reminder screen', tenant: 'notice-v1', assignee: 'coding', profile: 'coding', started: 1000, run_started: 1000, hb: 1900, ...o });

test('running tasks become header lines: agent, project, portfolio, a clean title; stalled ones are marked and listed last', () => {
  const now = 2000;
  const r = shapeWorking([{ board: 'micropace-labs', waiting: 2, rows: [row({ id: 't_old', hb: now - STALL_AFTER - 600, run_started: 500, title: 'Old stuck one' }), row()] }, { board: 'ai-thrival', waiting: 1, rows: [row({ id: 't_b', tenant: null, title: 'Plain title', profile: null, assignee: 'content', run_started: 1500, hb: null })] }], (b) => ({ 'micropace-labs': 'micropace', 'ai-thrival': 'ai-thrival' } as Record<string, string>)[b], now);
  assert.deepEqual(r.items.map((x) => [x.id, x.stalled]), [['t_a1', false], ['t_b', false], ['t_old', true]]);   // working first (oldest start first), stalled last
  const a = r.items[0];
  assert.deepEqual([a.portfolio, a.project, a.title, a.agent], ['micropace', 'notice-v1', 'Build the reminder screen', 'coding']);
  assert.deepEqual([r.items[1].project, r.items[1].agent], [null, 'content']);   // no project, agent from the assignee
  assert.equal(r.waiting, 3);
  assert.equal(r.items[2].quiet >= 15, true);
});

test('nothing running is an empty list, not an error', () => {
  assert.deepEqual(shapeWorking([], () => undefined, 5), { now: 5, items: [], waiting: 0 });
});
