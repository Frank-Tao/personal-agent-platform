import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addFeedback, list } from './feedback.ts';
import { applyDigest, planDigest, readProposals } from './digest.ts';
import { decide, listProposals, pendingCount } from './decide.ts';
import { feedbackSource } from '../../apps/cockpit/src/sources/feedback.ts';

const NOW = new Date('2026-11-07T00:00:00Z');
function sample() {
  const dir = mkdtempSync(join(tmpdir(), 'fbdec-'));
  const o = { dir, now: () => NOW };
  addFeedback({ text: 'The blocked tasks list is hidden on mobile', by: 'Frank' }, o);
  addFeedback({ text: 'Blocked tasks list hidden on mobile screens', by: 'Diane' }, o);
  addFeedback({ text: 'Sidebar needs a feedback item', by: 'Frank' }, { ...o, now: () => new Date('2026-10-01T00:00:00Z') });
  applyDigest(planDigest(o), o);
  return { dir, o };
}

test('decide: approve, defer and reject update the proposal and its items; defer and reject need a reason', async () => {
  const { dir, o } = sample();
  const ps = listProposals(o);
  assert.ok(ps.length >= 2, 'sample makes at least two pending proposals');
  assert.equal(pendingCount(o), ps.length);
  const [a, b, c] = ps;

  assert.throws(() => decide({ id: b.id, action: 'defer', reason: '  ' }, o), /needs a reason/);
  assert.throws(() => decide({ id: b.id, action: 'reject' }, o), /needs a reason/);
  assert.throws(() => decide({ id: b.id, action: 'nope' }, o), /action must be/);
  assert.throws(() => decide({ id: 'fp-none', action: 'approve' }, o), /no such proposal/);
  assert.equal(pendingCount(o), ps.length, 'refused decisions change nothing');

  const ap = decide({ id: a.id, action: 'approve', by: 'Frank' }, o);
  assert.equal(ap.status, 'approved');
  assert.deepEqual(list(o).filter((i) => a.items.includes(i.id)).map((i) => i.status), a.items.map(() => 'accepted'));

  const df = decide({ id: b.id, action: 'defer', reason: 'after launch', by: 'Frank' }, o);
  assert.equal(df.status, 'deferred');
  assert.equal((df.decision as any).until, '2026-12-05');   // +28 days

  if (c) {
    const rj = decide({ id: c.id, action: 'reject', reason: 'not now', by: 'Frank' }, o);
    assert.equal(rj.status, 'rejected');
    assert.ok(list(o).filter((i) => c.items.includes(i.id)).every((i) => i.status === 'rejected' && i.note === 'not now'));
  }
  assert.throws(() => decide({ id: a.id, action: 'reject', reason: 'x' }, o), /already approved/);   // second decision refused
  assert.equal(pendingCount(o), ps.length - (c ? 3 : 2));
  assert.equal(listProposals(o).find((p) => p.id === a.id)!.status, 'approved');
  assert.equal(readProposals(dir).length, ps.length);   // last line per id wins; no duplicates in the view
});

test('pending proposals count in Needs you, and drop out once decided', async () => {
  const { dir, o } = sample();
  const before = (await feedbackSource(dir)()).needs!;
  assert.equal(before.length, pendingCount(o));
  assert.match(before[0].title, /^Feedback proposal/);
  decide({ id: listProposals(o)[0].id, action: 'approve' }, o);
  assert.equal((await feedbackSource(dir)()).needs!.length, before.length - 1);
});
