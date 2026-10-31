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
