import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromText, validateExtraction, type Extraction } from '../src/extract.ts';
import { summarize } from '../src/summarize.ts';
import { aliasFor } from '../src/run.ts';
import { assertNoPii } from '../../../packages/redact/redact.ts';

const ex = (periodEnd: string, endingBalance: number, totalIn: number, totalOut: number, c = 0, t = 0): Extraction => ({
  periodEnd, endingBalance, totalIn, totalOut, upcomingBillsCount: c, upcomingBillsTotal: t,
});

test('validateExtraction accepts good data and rejects junk', () => {
  assert.equal(validateExtraction(ex('2026-09', 100, 1, 2)).periodEnd, '2026-09');
  assert.equal(validateExtraction({ ...ex('2026-09', 1, 1, 1), periodEnd: '2026-09-30' }).periodEnd, '2026-09');
  assert.throws(() => validateExtraction({ ...ex('2026-9', 1, 1, 1) }), /periodEnd/);
  assert.throws(() => validateExtraction({ ...ex('2026-09', 1, 1, 1), periodEnd: 'September 2026' }), /periodEnd/);
  assert.throws(() => validateExtraction({ ...ex('2026-09', 1, 1, 1), endingBalance: 'lots' }), /endingBalance/);
  assert.throws(() => validateExtraction({ ...ex('2026-09', 1, -5, 1) }), /negative/);
});

test('extractFromText sends numbers-only schema and validates the reply', async () => {
  let sent: any;
  const fetchStub = (async (_u: any, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ message: { content: JSON.stringify(ex('2026-09', 5000, 3000, 2000)) } }));
  }) as typeof fetch;
  const r = await extractFromText('statement text', { url: 'http://o', model: 'm', fetch: fetchStub });
  assert.equal(r.endingBalance, 5000);
  assert.equal(sent.format.type, 'object');
  assert.equal(sent.options.temperature, 0);
  assert.equal(sent.keep_alive, '30s');
});

test('extractFromText rejects a model reply with extra prose/invalid shape', async () => {
  const fetchStub = (async () => new Response(JSON.stringify({ message: { content: 'Sure! Here is...' } }))) as typeof fetch;
  await assert.rejects(extractFromText('x', { url: 'http://o', model: 'm', fetch: fetchStub }));
});

test('summarize computes cash, burn, runway and passes the PII gate', () => {
  const s = summarize(
    {
      checking: [ex('2026-07', 9000, 4000, 5000), ex('2026-08', 8000, 4000, 5000), ex('2026-09', 7000, 4000, 5000, 3, 640)],
      savings: [ex('2026-09', 30000, 0, 0)],
    },
    { nextEstimatedTaxDue: '2027-01-15' },
    new Date('2026-10-01T00:00:00Z'),
  );
  assert.equal(s.headline, 'Cash runway 37.0 months'); // 37000 / 1000 burn
  assert.deepEqual(s.metrics.map((m) => m.label), ['Cash', 'Runway', 'Net burn / mo', 'Upcoming bills']);
  assert.equal(s.status, 'ok');
  assert.equal(s.alerts[0].dueAt, '2027-01-15');
  assert.doesNotThrow(() => assertNoPii(s));
});

test('summarize raises alerts on short runway and handles empty/positive-flow cases', () => {
  const low = summarize({ checking: [ex('2026-09', 2000, 1000, 2000)] });
  assert.equal(low.status, 'alert');
  assert.match(low.alerts[0].title, /under 3 months/);
  assert.equal(summarize({}).status, 'unknown');
  assert.match(summarize({ a: [ex('2026-09', 1000, 3000, 1000)] }).headline, /positive net flow/);
});

test('aliasFor derives the account alias from the file name only', () => {
  assert.equal(aliasFor('checking-2026-09.txt'), 'checking');
  assert.equal(aliasFor('Savings_Sep.csv'), 'savings');
  assert.throws(() => aliasFor('2026-09.txt'), /alias/);
});
