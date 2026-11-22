import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanInfo, ADVANCE_EVERY } from '../src/scan.ts';

test('scan timing: the next plan sync is a minute after the last start, never in the past, not while it runs; overdue after three missed intervals', () => {
  const idle = { lastStartAt: 1000, lastEndAt: 1004, running: false, note: 'nothing to move' };
  const a = scanInfo(idle, 500, 900, 1030).advance;
  assert.deepEqual([a.nextAt, a.lastAt, a.overdue, a.note], [1000 + ADVANCE_EVERY, 1004, false, 'nothing to move']);
  assert.equal(scanInfo(idle, 500, null, 1500).advance.nextAt, 1500);                       // late: "now", not a past time
  assert.equal(scanInfo(idle, 500, null, 1500).advance.overdue, true);
  assert.equal(scanInfo({ ...idle, running: true }, 500, null, 1030).advance.nextAt, null);
  assert.equal(scanInfo({ lastStartAt: null, lastEndAt: null, running: false, note: '' }, 2000, null, 2030).advance.nextAt, 2000 + ADVANCE_EVERY);   // before the first run: a minute after boot
  assert.equal(scanInfo(idle, 500, 900, 1030).watch.lastAt, 900);
});
