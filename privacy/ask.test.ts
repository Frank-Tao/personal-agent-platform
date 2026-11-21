import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASK_TIMEOUT_MS, CONTEXT_MAX, WRAP, askPersonalPrivacy, cleanContext } from './ask.ts';

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

test('the privacy agent is told what it cannot know: background and the date reach it, private-looking background is dropped, and it waits long enough for a local model', async () => {
  assert.ok(ASK_TIMEOUT_MS >= 300_000);
  const w = WRAP('compare with the previous quarter', 'Follow-up to a question about spending by category. Frank wants a one-line answer.', '2026-11-21');
  assert.match(w, /Today is 2026-11-21/); assert.match(w, /no memory of the chat/); assert.match(w, /BACKGROUND[\s\S]*one-line answer[\s\S]*QUESTION:\ncompare with the previous quarter/);
  assert.ok(!/BACKGROUND/.test(WRAP('q', '', '2026-11-21')), 'no background section when there is none');
  assert.deepEqual(cleanContext('  a   spaced\n out  note '), { text: 'a spaced out note', dropped: null });
  assert.equal(cleanContext('x'.repeat(5000)).text.length, CONTEXT_MAX);
  const bad = cleanContext('His account number is 12345678901 and his TFN is 123 456 789');
  assert.equal(bad.text, ''); assert.match(bad.dropped!, /account-number|tfn/);
  const seen: Array<[string, string | undefined]> = [], logs: object[] = [];
  const ask = async (t: string, c?: string) => { seen.push([t, c]); return 'ok'; };
  await askPersonalPrivacy(ask, 'my tax return', (l) => logs.push(l), 'atlas', 'The topic is last year\'s tax return; a short answer please.');
  await askPersonalPrivacy(ask, 'my tax return', (l) => logs.push(l), 'atlas', 'account 12345678901');
  assert.equal(seen[0][1], 'The topic is last year\'s tax return; a short answer please.');
  assert.equal(seen[1][1], undefined, 'private-looking context is not passed on');
  assert.ok(JSON.stringify(logs).includes('contextDropped') && !JSON.stringify(logs).includes('12345678901'), 'only the reason is logged');
});
