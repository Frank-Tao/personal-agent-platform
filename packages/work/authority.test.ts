import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorityOf, ownerSees } from './authority.ts';

const D = (title: string, why = '', notes = '') => ({ title, why, notes, by: 'pm' });
const ledger = (n: number) => (n === 20 ? { n: 20, by: 'Frank' } : n === 23 ? { n: 23, by: 'pm' } : undefined);

test('the real Vanguard items: planning notes go to the project manager, the ones about Frank\'s data or rules stay with Frank', () => {
  // D24 how the local agent hands files over, D26 how statements are stored, D28 / D29 risks the pm noticed: its own planning
  assert.equal(authorityOf(D('The personal agent has file tools only: no terminal and no git. So it hands off files through ~/codes/frank-web/statement-handoff/ (outside the repo). coding runs the privacy check on them'), ledger).owner, false);
  assert.equal(authorityOf(D('How a statement is stored (D23): each upload becomes a snapshot row with its statement details and a file fingerprint (SHA-256), and every parsed row is kept in a new statement_rows table'), ledger).owner, false);
  assert.equal(authorityOf(D("personal studies the PDFs with read_file's text extraction, but the app will use pdfjs-dist. The text lines may differ, so Frank's check may fail on the first pass and need another round with personal"), ledger).owner, false);
  assert.equal(authorityOf(D("If Frank's step fails, the fix goes back to personal and needs a new task. I did not plan one in advance"), ledger).owner, false);
  // D25 replaces Frank's own D20 about his real files; D27 makes the release wait for his real-file step
  const d25 = authorityOf(D('Real PDFs are run only by Frank on this Mac (the human step), not by personal. That replaces "personal runs the parser on the real files" in D20'), ledger);
  assert.deepEqual([d25.owner, /real or personal data/.test(d25.why)], [true, true]);
  assert.equal(authorityOf(D("The release waits for Frank's real-file step as well as both QA checks"), ledger).owner, true);
});

test('what is always the owner\'s: secrets, money and publishing, charter and scope, an explicit ask, a change to a decision Frank made, and anything an agent escalated', () => {
  const owner = (t: string, notes = '') => authorityOf(D(t, '', notes), ledger);
  assert.equal(owner('Store the API key in the repo .env').owner, true);
  assert.equal(owner('Spend $20 a month on a market data subscription').owner, true);
  assert.equal(owner('Deploy the app to a hosted server').owner, true);
  assert.equal(owner('Add a fourth done-when item to the charter').owner, true);
  assert.equal(owner('Frank must decide whether Yahoo terms allow polling').owner, true);
  assert.equal(owner('This changes D20 so the parser may run in the cloud').owner, true);          // D20 is Frank's
  assert.equal(owner('This changes D23 so rows are stored in two tables').owner, false);           // D23 is the pm's own
  assert.equal(owner('Use a retry of three attempts', '- escalated by pm: not sure this is mine').owner, true);
});

test('nothing disappears: with no steward, or when the steward has not settled it for a day and a half, the owner sees an agent-level item', () => {
  const item = { ...D('Use a 5 minute cache for quotes'), date: '2026-11-22' };
  const now = Date.parse('2026-11-22T12:00:00Z');
  assert.equal(ownerSees(item, ledger, true, now).owner, false);                                   // fresh and has a steward: the steward's
  assert.match(ownerSees(item, ledger, false, now).why, /no steward/);
  assert.equal(ownerSees(item, ledger, false, now).owner, true);
  assert.equal(ownerSees(item, ledger, true, Date.parse('2026-11-24T06:00:00Z')).owner, true);       // 54 hours later
  assert.match(ownerSees(item, ledger, true, Date.parse('2026-11-24T06:00:00Z')).why, /has not settled it in 36 hours/);
});
