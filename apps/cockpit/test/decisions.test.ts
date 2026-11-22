import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type AppDeps } from '../src/app.ts';
import { decisionArgs, WorkError } from '../src/work.ts';
import { workSource } from '../src/sources/work.ts';
import { addDecision } from '../../../packages/work/decisions.ts';

function setup() {
  const kb = mkdtempSync(join(tmpdir(), 'dkb-'));
  for (const p of ['micropace', 'investments', 'family']) mkdirSync(join(kb, p));
  const add = (portfolio: string, project: string | undefined, title: string, extra: Record<string, unknown> = {}) => addDecision(kb, { portfolio, ...(project ? { project } : {}), title, by: 'Frank', date: '2026-11-15', ...extra });
  add('micropace', 'notice-v1', 'Use SwiftUI for the player view', { why: 'Faster to ship' });
  add('micropace', 'notice-v1', 'Drop the iPad layout for v1', { status: 'proposed', by: 'pm' });
  add('micropace', 'notice-v1', 'Which region do we launch in first?', { kind: 'question', by: 'pm' });
  add('family', 'orbit', 'Family Orbit keeps data on the device only');
  add('investments', 'tracker', 'Rebalance the holdings quarterly');
  add('micropace', 'notice-v1', 'Mention the investments tracker in the release notes');   // a decision in another portfolio that talks about a hidden one
  writeFileSync(join(kb, 'micropace', 'decisions.md'), '2026-11-01 — Name the app Notice — short and clear\n');
  const dir = mkdtempSync(join(tmpdir(), 'dpub-')); writeFileSync(join(dir, 'index.html'), '<html>x</html>');
  const people: Record<string, unknown> = { frank: { name: 'Frank', hide: [], device: null }, diane: { name: 'Diane', hide: ['investments'], device: 'hp-x360' }, guest: { name: 'Guest', hide: ['investments'], device: null, owns: [], system: false, guest: true } };
  const calls: string[][] = [];
  const deps = {
    publicDir: dir, guard: { allowedHosts: [] }, chat: { apiUrl: 'http://127.0.0.1:1', apiKey: 'k' }, tasks: { run: async () => '{}', boardFor: (p: string) => p },
    getRollup: async () => ({ agents: [], needsYou: [], portfolios: [], ui: { groups: [] } }), history: () => [], agentDetail: () => null, catalog: () => [], privacyAsk: async () => ({ answer: 'x', masked: 0 }),
    growthRun: () => ({ code: 0, output: '{}' }), agentsRun: () => ({ code: 0, output: '' }), modelsPath: join(dir, 'm.json'), invalidate: () => {}, groupOfBoard: (b: string) => b,
    work: (argv: string[]) => { calls.push(argv); return { code: argv.some((a) => a.endsWith('/D99')) ? 1 : 0, output: argv.some((a) => a.endsWith('/D99')) ? 'error: no decision micropace/notice-v1/D99' : 'ok' }; },
    decisionsKb: kb,
    identify: (req: { headers: Record<string, string> }) => people[req.headers['x-test-as']],
  } as unknown as AppDeps;
  return { kb, deps, calls };
}
async function serve(deps: AppDeps) {
  const srv: Server = createServer((q, r) => void createApp(deps)(q, r));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const get = async (path: string, who: string) => { const r = await fetch(base + path, { headers: { 'x-test-as': who } }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
  const post = async (path: string, body: unknown, who: string) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-test-as': who }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
  return { srv, get, post };
}

test('decisions API: Frank sees everything; Diane sees every decision except Investments and any that talks about it; a Guest sees nothing', async () => {
  const w = setup(); const s = await serve(w.deps);
  try {
    const frank = await s.get('/api/decisions', 'frank');
    assert.equal(frank.status, 200);
    assert.equal(frank.body.total, 7);                                                        // six in the ledger + the old one-liner
    assert.deepEqual(frank.body.counts, { active: 5, proposed: 1, question: 1 });
    const diane = await s.get('/api/decisions', 'diane');
    const titles = diane.body.decisions.map((x: { title: string }) => x.title);
    assert.ok(titles.includes('Use SwiftUI for the player view') && titles.includes('Family Orbit keeps data on the device only') && titles.includes('Name the app Notice'));
    assert.ok(!titles.some((t: string) => /Rebalance the holdings/.test(t)), 'the Investments portfolio is hidden');
    assert.ok(!titles.some((t: string) => /investments tracker/.test(t)), 'a decision that talks about it is hidden too');
    assert.equal((await s.get('/api/decisions', 'guest')).status, 403);
  } finally { s.srv.close(); }
});

test('decisions API: filters by project, status and search; counts ignore the status filter; newest first', async () => {
  const w = setup(); const s = await serve(w.deps);
  try {
    const p = (await s.get('/api/decisions?project=notice-v1', 'frank')).body;
    assert.deepEqual(p.decisions.map((x: { n: number }) => x.n), [4, 3, 2, 1]);
    const prop = (await s.get('/api/decisions?project=notice-v1&status=proposed', 'frank')).body;
    assert.deepEqual(prop.decisions.map((x: { title: string }) => x.title), ['Drop the iPad layout for v1']);
    assert.equal(prop.counts.active, 2);
    const q = (await s.get('/api/decisions?status=question', 'frank')).body;
    assert.deepEqual(q.decisions.map((x: { title: string }) => x.title), ['Which region do we launch in first?']);
    assert.deepEqual((await s.get('/api/decisions?q=swiftui', 'frank')).body.decisions.map((x: { n: number }) => x.n), [1]);
    assert.equal((await s.get('/api/decisions?status=bogus', 'frank')).status, 400);
  } finally { s.srv.close(); }
});

test('decisions API: only the owner changes the ledger, through the work CLI with fixed arguments; a refused change says why', async () => {
  const w = setup(); const s = await serve(w.deps);
  try {
    const confirm = { action: 'confirm', ref: 'micropace/notice-v1/D2', reason: 'agreed in the call' };
    assert.equal((await s.post('/api/decisions/act', confirm, 'diane')).status, 403);
    assert.equal((await s.post('/api/decisions/act', confirm, 'guest')).status, 403);
    assert.deepEqual(w.calls, []);
    assert.equal((await s.post('/api/decisions/act', confirm, 'frank')).status, 200);
    assert.deepEqual(w.calls[0], ['decision', 'confirm', 'micropace/notice-v1/D2', '--by', 'Frank', '--reason', 'agreed in the call', '--apply']);
    const bad = await s.post('/api/decisions/act', { action: 'reject', ref: 'micropace/notice-v1/D99' }, 'frank');
    assert.deepEqual([bad.status, bad.body.error], [422, 'error: no decision micropace/notice-v1/D99']);
    assert.equal((await s.post('/api/decisions/act', { action: 'confirm', ref: '../../etc/passwd' }, 'frank')).status, 400);
    assert.equal((await s.post('/api/decisions/act', { action: 'delete', ref: 'micropace/notice-v1/D1' }, 'frank')).status, 400);
  } finally { s.srv.close(); }
});

test('decisionArgs: add builds fixed arguments, refuses short titles and odd values, and never passes a flag from the request', () => {
  assert.deepEqual(decisionArgs({ action: 'add', project: 'notice-v1', title: 'Use SwiftUI for the player', why: '  faster ', question: true, supersedes: 'D2' }, "Frank <b>"), ['decision', 'add', 'notice-v1', '--title', 'Use SwiftUI for the player', '--why', 'faster', '--by', 'Frank b', '--source', 'manual', '--question', '--supersedes', 'D2', '--apply']);
  assert.deepEqual(decisionArgs({ action: 'add', portfolio: 'family', title: 'Family-wide rule about devices' }, 'Frank').slice(0, 4), ['decision', 'add', '--portfolio', 'family']);
  for (const bad of [{ action: 'add', title: 'no project here' }, { action: 'add', project: 'p1', title: 'ok' }, { action: 'add', project: 'p1', title: 'A fine title', supersedes: '--apply' }, { action: 'add', project: '--x', title: 'A fine title' }]) assert.throws(() => decisionArgs(bad, 'Frank'), WorkError);
});

test('Needs-you: proposed decisions wait for the owner, one item per project, and disappear once confirmed', async () => {
  const w = setup();
  const needs = async () => ((await workSource({ kb: w.kb, portfolios: ['micropace', 'family', 'investments'] })()).needs ?? []).map((n) => n.title);
  const first = await needs();
  assert.deepEqual(first, ['Confirm 1 proposed decision for notice-v1: "Drop the iPad layout for v1"', 'Answer 1 open question for notice-v1: "Which region do we launch in first?" (project page, Needs you tab)']);
  const { setStatus } = await import('../../../packages/work/decisions.ts');
  setStatus(w.kb, 'micropace/notice-v1/D2', 'active', 'Frank');
  assert.deepEqual(await needs(), ['Answer 1 open question for notice-v1: "Which region do we launch in first?" (project page, Needs you tab)']);
});

test('Needs-you: an open question goes away once it is answered (a decision that replaces it)', async () => {
  const w = setup();
  const { addDecision, readDecisions } = await import('../../../packages/work/decisions.ts');
  const needs = async () => ((await workSource({ kb: w.kb, portfolios: ['micropace', 'family', 'investments'] })()).needs ?? []).map((n) => n.title);
  assert.ok((await needs()).some((t) => /^Answer 1 open question for notice-v1/.test(t)));
  const q = readDecisions(w.kb, { portfolio: 'micropace', status: 'active' }).find((d) => d.kind === 'question')!;
  addDecision(w.kb, { portfolio: 'micropace', project: 'notice-v1', title: `Answer to D${q.n}: Australia first`, why: 'Frank: launch in Australia first.', by: 'Frank', source: 'manual', supersedes: `D${q.n}`, date: '2026-11-22' });
  assert.ok(!(await needs()).some((t) => /open question/.test(t)));
});

test('mail API: only the owner sends or denies a held email, through the work CLI with fixed arguments', async () => {
  const w = setup(); const s = await serve(w.deps);
  try {
    const id = 'm-20261120-010000-ab12';
    assert.equal((await s.post('/api/mail/act', { action: 'release', id }, 'diane')).status, 403);
    assert.equal((await s.post('/api/mail/act', { action: 'release', id }, 'guest')).status, 403);
    assert.equal((await s.post('/api/mail/act', { action: 'release', id: '../x' }, 'frank')).status, 400);
    assert.equal((await s.post('/api/mail/act', { action: 'send-all', id }, 'frank')).status, 400);
    assert.equal((await s.post('/api/mail/act', { action: 'release', id }, 'frank')).status, 200);
    assert.equal((await s.post('/api/mail/act', { action: 'deny', id, reason: 'not now\n--apply' }, 'frank')).status, 200);
    assert.deepEqual(w.calls.slice(-2), [['mail', 'release', id, '--by', 'Frank', '--apply'], ['mail', 'deny', id, '--by', 'Frank', '--reason', 'not now --apply', '--apply']]);
  } finally { s.srv.close(); }
});

test('needs API: only the owner answers or snoozes an item; the answer becomes fixed work act arguments', async () => {
  const w = setup();
  const snoozed: Array<[string, number]> = [];
  const s = await serve({ ...w.deps, snooze: (k: string, d: number) => { snoozed.push([k, d]); return 'later'; } } as AppDeps);
  try {
    const act = { kind: 'approve-charter', project: 'notice-v1' };
    assert.equal((await s.post('/api/needs/act', { act, answer: 'yes' }, 'diane')).status, 403);
    assert.equal((await s.post('/api/needs/act', { act: { kind: 'approve-charter', project: '--apply' }, answer: 'yes' }, 'frank')).status, 400);
    assert.equal((await s.post('/api/needs/act', { act, answer: 'maybe' }, 'frank')).status, 400);
    assert.equal((await s.post('/api/needs/act', { act, answer: 'yes' }, 'frank')).status, 200);
    assert.deepEqual(w.calls.at(-1), ['act', '--kind', 'approve-charter', '--project', 'notice-v1', '--answer', 'yes', '--by', 'Frank', '--via', 'cockpit', '--apply']);
    await s.post('/api/needs/act', { act: { kind: 'decisions', refs: ['micropace/notice-v1/D2', 'x; rm'] }, answer: 'yes' }, 'frank');
    assert.deepEqual(w.calls.at(-1)?.slice(0, 4), ['act', '--kind', 'decisions', '--refs']);
    assert.equal(w.calls.at(-1)?.[4], 'micropace/notice-v1/D2');
    assert.equal((await s.post('/api/needs/snooze', { key: 'approve-charter:notice-v1', days: 1 }, 'diane')).status, 403);
    assert.equal((await s.post('/api/needs/snooze', { key: 'approve-charter:notice-v1', days: 99 }, 'frank')).status, 400);
    assert.equal((await s.post('/api/needs/snooze', { key: 'approve-charter:notice-v1', days: 3 }, 'frank')).status, 200);
    assert.deepEqual(snoozed, [['approve-charter:notice-v1', 3]]);
    assert.equal((await s.post('/api/automation/default', { portfolio: 'research', level: 'full' }, 'diane')).status, 403);
    assert.equal((await s.post('/api/automation/default', { portfolio: 'research', level: 'full' }, 'frank')).status, 200);
    assert.deepEqual(w.calls.at(-1), ['automation', 'default', 'research', 'full', '--by', 'Frank', '--apply']);
  } finally { s.srv.close(); }
});
