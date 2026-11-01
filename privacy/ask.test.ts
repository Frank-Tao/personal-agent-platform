import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WRAP, askPersonalPrivacy } from './ask.ts';

test('the answer is redacted by code even if the local model leaks, and only kinds and counts are logged', async () => {
  const log: object[] = [];
  const r = await askPersonalPrivacy(async (q) => { assert.match(q, /my payslip/); return 'Net pay looks fine. Account 123456789012 got it; contact frank@example.com.'; }, 'Is my payslip right? TFN 123 456 789', (l) => log.push(l), 'atlas');
  assert.ok(!/123456789012|frank@example\.com/.test(r.answer));
  assert.match(r.answer, /\[REDACTED:account-number\]/);
  assert.equal(r.masked, 2);
  assert.ok(r.reasons.includes('tfn') && r.reasons.includes('payslip'));
  const logged = JSON.stringify(log);
  assert.ok(!/123 456|payslip right|Net pay|frank@/.test(logged));
  assert.match(logged, /"via":"atlas"/);
});

test('an empty local answer is an error, never a silent pass-through; the prompt tells the model to mask details', async () => {
  await assert.rejects(askPersonalPrivacy(async () => '', 'my bank statement'), /returned nothing/);
  assert.match(WRAP('x'), /never repeat account numbers/);
});
