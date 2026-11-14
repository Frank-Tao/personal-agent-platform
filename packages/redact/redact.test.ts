import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPii, redact, assertNoPii } from './redact.ts';

test('flags common PII', () => {
  const samples: Record<string, string> = {
    ssn: 'SSN 123-45-6789',
    card: 'card 4111 1111 1111 1111',
    'account-number': 'acct 123456789012',
    email: 'me@example.com',
    phone: 'call (415) 555-0134',
    'street-address': 'lives at 742 Evergreen Terrace Ave',
  };
  for (const [kind, text] of Object.entries(samples)) {
    assert.ok(findPii(text).some((h) => h.kind === kind), `${kind} not detected in "${text}"`);
  }
});

test('allows aggregate figures and dates', () => {
  for (const ok of ['Cash runway 7.2 months', '$12,345.67 across 3 accounts', 'Q4 estimate due 2026-01-15', '+2.1% MTD']) {
    assert.deepEqual(findPii(ok), [], ok);
  }
});

test('redact replaces matches', () => {
  assert.equal(redact('mail me@example.com now'), 'mail [REDACTED:email] now');
});

test('assertNoPii walks nested objects and keys', () => {
  assert.doesNotThrow(() => assertNoPii({ headline: 'Cash 7.2 mo', metrics: [{ label: 'Runway', value: '7.2 mo' }] }));
  assert.throws(() => assertNoPii({ metrics: [{ label: 'x', value: 'acct 123456789' }] }), /account-number/);
  assert.throws(() => assertNoPii({ 'me@example.com': 1 }), /email/);
});

import { privacyCheck } from './topics.ts';
test('privacyCheck: private values and private topics are caught; ordinary work talk is not; reasons never contain the text', () => {
  assert.deepEqual(privacyCheck('Please summarise my bank statement for October').reasons, ['bank-statement']);
  assert.ok(privacyCheck('my TFN is 123 456 789').reasons.includes('tfn'));
  assert.ok(privacyCheck('transfer to BSB 062-000 account 12345678').reasons.includes('bsb'));
  assert.ok(privacyCheck('born 12/03/1985').reasons.includes('date-of-birth'));
  assert.ok(privacyCheck('email me at frank@example.com').reasons.includes('email'));
  for (const ok of ['Plan the MicroPace project and assign the coding agent', 'what is the status of the Changes app review?', 'draft a LinkedIn post about our launch']) assert.equal(privacyCheck(ok).private, false, ok);
  assert.ok(!JSON.stringify(privacyCheck('my TFN is 123 456 789')).includes('123 456'));
});

test('privacyCheck: allow-listed emails are not private, digits inside them included; other emails and bare numbers still are; share-ok is case-insensitive', async () => {
  const { privacyCheck, isAllowedEmail } = await import('./topics.ts');
  const allow = { emails: ['me@example.com'], domains: ['users.noreply.github.com'] };
  const gh = 'My GitHub noreply email is 139962828+Dihanzhang@users.noreply.github.com. Yes, make the commits under my identity.';
  assert.equal(privacyCheck(gh, { emails: [], domains: [] }).private, true);              // without the allow-list: a 9-digit id looks like a tax or account number
  assert.equal(privacyCheck(gh, allow).private, false);
  assert.equal(privacyCheck('write to me@example.com or ME@Example.com', allow).private, false);   // exact address, any capitals
  assert.deepEqual(privacyCheck('write to other@example.com', allow).reasons, ['email']);        // another address on the same domain is not allowed
  assert.equal(privacyCheck('mail x@sub.users.noreply.github.com', allow).private, false);       // sub-domains of an allowed domain
  assert.ok(privacyCheck('my account is 139962828 and mail 1+a@users.noreply.github.com', allow).private);   // a bare number is still private
  assert.equal(isAllowedEmail('a@notusers.noreply.github.com.evil.io', allow), false);
  for (const tag of ['share-ok:', 'Share-ok:', 'SHARE-OK:', ' share-OK : ', 'share ok:', 'Share_OK:']) assert.equal(privacyCheck(`${tag} setup for a@b.com code 482913`, { emails: [], domains: [] }).private, false, tag);
  for (const m of ['share-okay: a@b.com', 'please share-ok: a@b.com', 'share-ok a@b.com']) assert.equal(privacyCheck(m, { emails: [], domains: [] }).private, true, m);   // must start the message, with a colon
  assert.equal(privacyCheck('share-ok: a@b.com my TFN is 123 456 789', { emails: [], domains: [] }).private, true);   // share-ok never waives anything but email
});
