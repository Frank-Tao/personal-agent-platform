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

test('privacy allow: add, list and remove exact emails and domains; bad input is refused', async () => {
  const { allowCommand } = await import('./ask.ts');
  const { mkdtempSync, writeFileSync: wf, readFileSync: rf } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const path = join(mkdtempSync(join(tmpdir(), 'allow-')), 'privacy.json'); wf(path, '{"_comment":"keep","allowedEmails":[],"allowedEmailDomains":["users.noreply.github.com"]}');
  const out: string[] = [];
  assert.equal(allowCommand(['add', 'Me@Example.com'], (s) => out.push(s), path), 0);
  assert.equal(allowCommand(['add', '@Corp.example.org'], (s) => out.push(s), path), 0);
  const j = JSON.parse(rf(path, 'utf8'));
  assert.deepEqual([j.allowedEmails, j.allowedEmailDomains, j._comment], [['me@example.com'], ['users.noreply.github.com', 'corp.example.org'], 'keep']);
  assert.equal(allowCommand(['remove', 'me@example.com'], (s) => out.push(s), path), 0);
  assert.deepEqual(JSON.parse(rf(path, 'utf8')).allowedEmails, []);
  assert.equal(allowCommand(['add', 'not-an-email'], (s) => out.push(s), path), 2);
  assert.equal(allowCommand(['add', '@x'], (s) => out.push(s), path), 2);
});
