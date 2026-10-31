import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paperclipSource, statusFor } from '../src/sources/paperclip.ts';
import { fileCardsSource } from '../src/sources/fileCards.ts';
import { buildRollup, collect } from '../src/rollup.ts';
import { buildBrief } from '../src/brief.ts';
import { Store } from '../src/store.ts';
import { demoSource } from '../src/sources/demo.ts';

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: any) => {
    const path = String(input).replace('http://pc', '');
    if (!(path in routes)) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(routes[path]), { status: 200 });
  }) as typeof fetch;
}

const dashboard = {
  agents: { active: 3, running: 1, paused: 0, error: 1 },
  tasks: { open: 4, inProgress: 2, blocked: 1, done: 9 },
  costs: { monthSpendCents: 9500, monthBudgetCents: 10000, monthUtilizationPercent: 95 },
  pendingApprovals: 2,
  budgets: { activeIncidents: 0 },
  runActivity: [{ date: '2026-10-24', succeeded: 5, failed: 1, total: 6 }],
};

test('paperclip adapter maps dashboard + approvals, tolerating list envelopes', async () => {
  const src = paperclipSource({
    baseUrl: 'http://pc',
    fetch: fakeFetch({
      '/api/companies': { companies: [{ id: 'c1', name: 'Software' }] },
      '/api/companies/c1/dashboard': dashboard,
      '/api/companies/c1/approvals?status=pending': [{ type: 'deploy', payload: { title: 'Deploy v2' } }],
    }),
  });
  const { cards, errors } = await src();
  assert.deepEqual(errors, []);
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.status, 'alert'); // agent error + 95% budget
  assert.equal(c.spend?.spentCents, 9500);
  const kinds = c.needsYou.map((n) => n.kind).sort();
  assert.deepEqual(kinds, ['alert', 'approval', 'approval', 'blocker']); // 2 approvals (1 titled + 1 from count)
  assert.ok(c.needsYou.some((n) => n.title === 'Deploy v2'));
});

test('paperclip down degrades to an error, not a throw', async () => {
  const { cards, errors } = await paperclipSource({ baseUrl: 'http://pc', fetch: fakeFetch({}) })();
  assert.equal(cards.length, 0);
  assert.match(errors[0], /cannot list companies/);
});

test('one failing company does not hide the others', async () => {
  const { cards, errors } = await paperclipSource({
    baseUrl: 'http://pc',
    fetch: fakeFetch({
      '/api/companies': [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      '/api/companies/a/dashboard': {},
    }),
  })();
  assert.deepEqual(cards.map((c) => c.id), ['a']);
  assert.equal(errors.length, 1);
});

test('statusFor thresholds', () => {
  assert.equal(statusFor({}), 'ok');
  assert.equal(statusFor({ pendingApprovals: 1 }), 'warn');
  assert.equal(statusFor({ costs: { monthUtilizationPercent: 80 } }), 'warn');
  assert.equal(statusFor({ costs: { monthUtilizationPercent: 91 } }), 'alert');
});

test('private summaries: clean file accepted, PII file rejected without echoing content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hq-priv-'));
  const now = new Date().toISOString();
  await writeFile(join(dir, 'personal.json'), JSON.stringify({
    id: 'personal', name: 'Personal', status: 'ok', headline: 'Cash runway 7.2 months', updatedAt: now,
    alerts: [{ title: 'Q4 estimated tax due', dueAt: '2027-01-15' }],
  }));
  await writeFile(join(dir, 'leaky.json'), JSON.stringify({
    id: 'leaky', name: 'Leaky', headline: 'Checking acct 123456789012 low', updatedAt: now,
  }));
  const { cards, errors } = await fileCardsSource(dir, 'private')();
  assert.deepEqual(cards.map((c) => c.id), ['personal']);
  assert.equal(cards[0].needsYou[0].kind, 'deadline');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /leaky\.json rejected/);
  assert.ok(!errors[0].includes('123456789012'));
});

test('stale data is flagged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hq-man-'));
  await writeFile(join(dir, 'inv.json'), JSON.stringify({
    id: 'inv', name: 'Inv', status: 'ok', headline: 'x', updatedAt: '2020-01-01T00:00:00Z',
  }));
  const { cards } = await fileCardsSource(dir, 'manual')();
  assert.equal(cards[0].status, 'warn');
  assert.ok(cards[0].needsYou.some((n) => /stale/i.test(n.title)));
});

test('missing directory is not an error', async () => {
  const r = await fileCardsSource('/definitely/not/here', 'manual')();
  assert.deepEqual(r, { cards: [], errors: [] });
});

test('rollup aggregates spend, sorts needs-you by severity, merges runs', async () => {
  const { cards, errors } = await collect([demoSource]);
  const r = buildRollup(cards, errors);
  assert.equal(r.portfolios.length, 5);
  assert.equal(r.spend.spentCents, 6400 + 2100 + 900 + 7400);
  assert.equal(r.spend.budgetCents, 15000 + 8000 + 5000 + 8000);
  assert.equal(r.needsYou[0].severity, 'alert');
  assert.equal(r.runs.length, 14);
});

test('collect survives a throwing source', async () => {
  const { cards, errors } = await collect([demoSource, async () => { throw new Error('boom'); }]);
  assert.equal(cards.length, 5);
  assert.match(errors[0], /boom/);
});

test('brief lists needs-you and portfolios', async () => {
  const { cards, errors } = await collect([demoSource]);
  const md = buildBrief(buildRollup(cards, errors));
  assert.match(md, /Needs you \(/);
  assert.match(md, /\*\*Software\*\*/);
  assert.match(md, /Spend this month/);
});

test('store round-trips latest and daily history', async () => {
  const store = new Store(':memory:');
  assert.equal(store.latest(), undefined);
  const { cards, errors } = await collect([demoSource]);
  const r = buildRollup(cards, errors);
  store.save(r);
  assert.equal(store.latest()?.portfolios.length, 5);
  assert.equal(store.history(7).length, 1);
  store.close();
});
