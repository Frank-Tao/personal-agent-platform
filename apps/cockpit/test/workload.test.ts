import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occupancy, runIntervals, waitIntervals, windowFor, demoWorkload, STEP } from '../src/workload.ts';

test('occupancy: average number of intervals open in each slot, split across slot edges', () => {
  // one run from 10 min into slot 0 to 5 min into slot 1; a second run covering all of slot 1
  const r = occupancy([{ s: 600, e: 1200 }, { s: 900, e: 1800 }], 0, 3);
  assert.deepEqual(r, [0.33, 1.33, 0]);                        // slot0: 300s/900; slot1: 300s + 900s
  assert.deepEqual(occupancy([{ s: -100, e: 50 }, { s: 5000, e: 6000 }], 0, 2), [0.06, 0]);   // outside the window is ignored
});

test('a run with no end stops at its last heartbeat unless it is really running (then at now, capped by its max runtime)', () => {
  const now = 100_000;
  assert.deepEqual(runIntervals([{ s: 1000, e: null, status: 'crashed', hb: 1600 }], now), [{ s: 1000, e: 1600 }]);
  assert.deepEqual(runIntervals([{ s: 99_000, e: null, status: 'running', max: 7200 }], now), [{ s: 99_000, e: 100_000 }]);
  assert.deepEqual(runIntervals([{ s: 1000, e: null, status: 'running', max: 600 }], now), [{ s: 1000, e: 1600 }]);
  assert.deepEqual(runIntervals([{ s: 1000, e: 1000 }], now), []);
});

test('a task is waiting from the moment it is ready until a worker claims it; the dispatcher\'s normal minute is not a queue', () => {
  const ev = (task_id: string, kind: string, created_at: number, payload: unknown = null) => ({ task_id, kind, created_at, payload: payload ? JSON.stringify(payload) : null });
  const rows = [
    ev('a', 'created', 1000, { status: 'ready' }), ev('a', 'claimed', 1060),                    // 1 minute: normal
    ev('b', 'created', 1000, { status: 'blocked' }), ev('b', 'unblocked', 2000), ev('b', 'claimed', 5000),   // 50 min
    ev('c', 'created', 1000, { status: 'todo' }), ev('c', 'promoted', 3000),                    // still ready now
    ev('d', 'created', 1000, { status: 'ready' }), ev('d', 'blocked', 4000),                    // left the queue by blocking
    ev('e', 'promoted', 3000),                                                                  // dangling: its status says running, so no wait to now
  ];
  const w = waitIntervals(rows, new Map([['a', 'done'], ['b', 'done'], ['c', 'ready'], ['d', 'blocked'], ['e', 'running']]), 9000);
  assert.deepEqual(w, [{ s: 2000, e: 5000 }, { s: 3000, e: 9000 }, { s: 1000, e: 4000 }]);
});

test('the window covers the last 7 days up to a day past now, in whole slots', () => {
  const now = 1_800_000_123;
  const { start, slots } = windowFor(now, 7);
  assert.equal(start % STEP, 0);
  assert.ok(start <= now - 7 * 86_400 + STEP && start + slots * STEP >= now + 86_400);
});

test('the demo workload has the same shape and invents numbers only for the past', () => {
  const now = 1_800_000_123, w = demoWorkload(now);
  const g = w.groups.micropace;
  assert.equal(g.run.length, w.slots); assert.equal(g.queue.length, w.slots);
  assert.ok(g.run.some((v) => v > 1) && g.run.some((v) => v === 0));
  const firstFuture = Math.ceil((now - w.start) / STEP);
  assert.ok(g.run.slice(firstFuture + 1).every((v) => v === 0));
});
