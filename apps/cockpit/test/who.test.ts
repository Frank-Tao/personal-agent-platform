import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type AppDeps } from '../src/app.ts';
import { resolveIdentity, type Whois } from '../src/identity.ts';
import { mentionsHidden, redactRollup, scrubDeep, scrubText } from '../src/visibility.ts';
import { buildRollup, collect } from '../src/rollup.ts';
import { demoSource } from '../src/sources/demo.ts';

const reqOf = (xff: string | undefined, peer = '127.0.0.1') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: peer } }) as never;
const noWhois: Whois = () => { throw new Error('should not be asked'); };

test('identity: the HP X360 is Diane (and restricted), this Mac and every other device is Frank; anything unresolvable is a restricted Guest', () => {
  assert.deepEqual([resolveIdentity(reqOf(undefined), noWhois).name, resolveIdentity(reqOf(undefined), noWhois).hide], ['Frank', []]);
  const diane = resolveIdentity(reqOf('100.102.99.110'), noWhois);     // known address: no lookup needed
  assert.deepEqual([diane.name, diane.hide, diane.device], ['Diane', ['investments'], 'hp-x360']);
  const byName: Whois = (a) => (a === '100.9.9.9' ? 'huawei-laptop' : a === '100.8.8.8' ? 'hp-x360' : null);
  assert.equal(resolveIdentity(reqOf('100.9.9.9'), byName).name, 'Frank');
  assert.equal(resolveIdentity(reqOf('100.8.8.8'), byName).name, 'Diane');          // another address that tailscale says is the hp-x360
  assert.equal(resolveIdentity(reqOf('100.7.7.7'), byName).name, 'Guest');          // not a tailnet device
  assert.equal(resolveIdentity(reqOf('100.9.9.9'), () => { throw new Error('tailscale down'); }).name, 'Guest');
  // only the last forwarded entry counts: a client cannot claim to be Frank by sending its own header
  assert.equal(resolveIdentity(reqOf('100.9.9.9, 100.102.99.110'), byName).name, 'Diane');
  assert.equal(resolveIdentity(reqOf('not-an-ip'), byName).name, 'Guest');
  // forwarded headers are not believed from a non-local peer
  assert.equal(resolveIdentity(reqOf('100.9.9.9', '192.168.1.50'), byName).name, 'Guest');
  assert.equal(resolveIdentity(reqOf(undefined, '192.168.1.50'), byName).name, 'Guest');
});

test('visibility: a hidden portfolio disappears from the rollup, its totals are recomputed, agents no longer list it, text lines about it are dropped', async () => {
  const { cards, errors, atlas, usage, lanes, agents } = await collect([demoSource]);
  const full = buildRollup(cards, errors, atlas, { usage, lanes, agents });
  assert.ok(full.portfolios.some((p) => p.group === 'investments'), 'the demo data has an investments card');
  const who = { hide: ['investments'] };
  const r = redactRollup(full, who);
  assert.ok(!r.portfolios.some((p) => p.group === 'investments' || p.id === 'investments'));
  assert.ok(!r.needsYou.some((n) => n.portfolioId === 'investments'));
  assert.ok(!JSON.stringify(r.ui.groups).includes('"investments"'));
  assert.ok(r.agents.every((a) => !a.portfolios.includes('investments') && !('investments' in a.byPortfolio)));
  assert.ok(!(r.usage?.byPortfolio ?? []).some((s) => s.id === 'investments'));
  const spent = r.portfolios.reduce((n, p) => n + (p.spend?.spentCents ?? 0), 0);
  assert.equal(r.spend.spentCents, spent);
  assert.equal(redactRollup(full, { hide: [] }), full);                                  // nothing hidden: untouched
  assert.equal(scrubText(who, 'Likes tea\nTracks the Investments portfolio weekly\nShort answers'), 'Likes tea\nShort answers');
  assert.deepEqual(scrubDeep(who, { about: [{ text: 'ok' }, { text: 'buy ETFs monthly' }], note: 'a\nportfolio-tracker b\nc' }), { about: [{ text: 'ok' }], note: 'a\nc' });
  assert.equal(mentionsHidden(who, 'how are my investments doing?'), true);
  assert.equal(mentionsHidden(who, 'please investigate the failing test'), false);
});

test('Diane over HTTP: no Investments in any read, no writes to it, no questions about it; Frank sees everything; /api/me says who is asking', async () => {
  const { cards, errors, atlas, usage, lanes, agents } = await collect([demoSource]);
  const rollup = buildRollup(cards, errors, atlas, { usage, lanes, agents });
  const dir = mkdtempSync(join(tmpdir(), 'who-'));
  writeFileSync(join(dir, 'index.html'), '<html>x</html>');
  const projects = [{ id: 'p-inv', portfolio: 'investments' }, { id: 'p-mp', portfolio: 'micropace' }];
  const deps = {
    publicDir: dir, guard: { allowedHosts: [] }, chat: { apiUrl: 'http://127.0.0.1:1', apiKey: 'k' },
    tasks: { run: async () => '{"id":"t_1","status":"ready"}', boardFor: (p: string) => p },
    getRollup: async () => rollup, history: () => [], agentDetail: () => null, catalog: () => [], privacyAsk: async () => ({ answer: 'x', masked: 0 }),
    growthRun: () => ({ code: 0, output: '{}' }), agentsRun: () => ({ code: 0, output: '' }), modelsPath: join(dir, 'm.json'),
    work: (argv: string[]) => ({ code: 0, output: argv[0] === 'projects' ? JSON.stringify(argv[1] === '--id' ? projects.filter((p) => p.id === argv[2]) : projects) : argv[0] === 'repos' ? JSON.stringify([{ id: 'a', portfolio: 'investments' }, { id: 'b', portfolio: 'family' }]) : '' }),
    invalidate: () => {}, groupOfBoard: (b: string) => b,
    identify: (req: { headers: Record<string, unknown> }) => (req.headers['x-test-as'] === 'diane' ? { name: 'Diane', hide: ['investments'], device: 'hp-x360' } : { name: 'Frank', hide: [], device: null }),
  } as unknown as AppDeps;
  const srv: Server = createServer((q, s) => void createApp(deps)(q, s));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const as = (who: string) => ({ 'x-test-as': who });
  const get = (path: string, who: string) => fetch(base + path, { headers: as(who) });
  const post = (path: string, body: unknown, who: string) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...as(who) }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await get('/api/me', 'diane')).json(), { name: 'Diane', device: 'hp-x360', restricted: true, admin: false });
    assert.equal(((await (await get('/api/me', 'frank')).json()) as { name: string }).name, 'Frank');
    const dr = (await (await get('/api/rollup', 'diane')).json()) as { portfolios: Array<{ group: string }> };
    const fr = (await (await get('/api/rollup', 'frank')).json()) as { portfolios: Array<{ group: string }> };
    assert.ok(fr.portfolios.some((p) => p.group === 'investments'));
    assert.ok(!dr.portfolios.some((p) => p.group === 'investments'));
    assert.ok(!JSON.stringify(dr).toLowerCase().includes('"portfolioid":"investments"'));
    assert.deepEqual(((await (await get('/api/projects', 'diane')).json()) as Array<{ id: string }>).map((p) => p.id), ['p-mp']);
    assert.deepEqual(((await (await get('/api/projects', 'frank')).json()) as Array<{ id: string }>).map((p) => p.id), ['p-inv', 'p-mp']);
    assert.deepEqual(((await (await get('/api/repos', 'diane')).json()) as Array<{ id: string }>).map((p) => p.id), ['b']);
    assert.equal((await get('/api/task?board=investments&id=t_1', 'diane')).status, 403);
    assert.equal((await post('/api/projects/act', { project: 'p-inv', action: 'pause' }, 'diane')).status, 403);
    assert.equal((await post('/api/tasks', { portfolio: 'investments', title: 'x' }, 'diane')).status, 403);
    assert.equal((await post('/api/tasks/assign', { board: 'investments', id: 't_1', assignee: 'pm' }, 'diane')).status, 403);
    const chat = await post('/api/chat', { message: 'How are my investments doing?', sessionId: 'cockpit-abcdef12' }, 'diane');
    assert.equal(chat.status, 403);
    assert.match(((await chat.json()) as { error: string }).error, /cannot discuss/);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('growth API: an always-apply rule is added with --always, and toggled with about set; nothing else becomes a flag', async () => {
  const { growthArgs } = await import('../src/growthApi.ts');
  assert.deepEqual(growthArgs({ agent: '*', action: 'about-add', text: 'Never deploy on Fridays', kind: 'constraint', always: true }), ['about', 'add', '*', '--text', 'Never deploy on Fridays', '--kind', 'constraint', '--source', 'user-said', '--ref', 'cockpit', '--always', '--apply']);
  assert.ok(!growthArgs({ agent: '*', action: 'about-add', text: 'x', always: 'yes' }).includes('--always'));
  assert.deepEqual(growthArgs({ agent: 'pm', action: 'about-always', id: 'a-0123ab', always: true }), ['about', 'set', 'a-0123ab', '--always', '--apply']);
  assert.deepEqual(growthArgs({ agent: 'pm', action: 'about-always', id: 'a-0123ab', always: false }), ['about', 'set', 'a-0123ab', '--no-always', '--apply']);
  assert.throws(() => growthArgs({ agent: 'pm', action: 'about-always', id: '../x', always: true }), /bad entry/);
});

test('notifications are not scoped: Frank and Diane both see every portfolio\'s items; only Investments is hidden from Diane; a Guest sees none; Admin sees all', async () => {
  const { cards, errors, atlas, usage, lanes, agents } = await collect([demoSource]);
  const full = buildRollup(cards, errors, atlas, { usage, lanes, agents });
  const groupOf = (n: { portfolioId: string; task?: { portfolio: string } }) => full.portfolios.find((c) => c.id === n.portfolioId)?.group ?? n.task?.portfolio ?? n.portfolioId;
  const frank = redactRollup(full, { hide: [], system: true });
  assert.equal(frank, full);                                                                // Frank: untouched
  const diane = redactRollup(full, { hide: ['investments'], system: true });
  const dg = new Set(diane.needsYou.map(groupOf));
  assert.ok(!dg.has('investments'), 'Diane gets no Investments item');
  assert.equal(diane.needsYou.length, full.needsYou.filter((n) => groupOf(n) !== 'investments').length);   // everything else, not just her own
  assert.ok(diane.portfolios.filter((c) => c.group !== 'investments').every((c) => c.needsYou.length === full.portfolios.find((f) => f.id === c.id)!.needsYou.length));
  assert.equal(redactRollup(full, { hide: [], owns: '*' as const, system: true }), full);   // admin: untouched
  const guest = redactRollup(full, { hide: ['investments'], owns: [], system: false, guest: true });
  assert.equal(guest.needsYou.length, 0);
  // items that belong to no portfolio (Atlas health) reach Frank and Diane, not a Guest
  const sys = { ...full, needsYou: [{ portfolioId: 'atlas', kind: 'alert' as const, title: 'gateway down', severity: 'alert' as const }] };
  assert.equal(redactRollup(sys, { hide: ['investments'], system: true }).needsYou.length, 1);
  assert.equal(redactRollup(sys, { hide: ['investments'], owns: [], system: false, guest: true }).needsYou.length, 0);
});

test('admin view: ?admin=secret sets a cookie and leaves the URL; the session slides, and secret and session die after 720 hours unused; ?admin=off leaves; wrong guesses are limited', async () => {
  const { adminSession, handleAdminParam, tokenStatus, IDLE_MS } = await import('../src/admin.ts');
  const HOUR = 3_600_000, DAY = 24 * HOUR;
  const mem = (last: number | null) => { const st = { last, lastUsed: () => st.last, touch: (n: number) => { st.last = n; } }; return st; };
  const reply = () => { const r: { status?: number; headers?: Record<string, string>; body?: string } = {}; return { r, res: { writeHead: (s: number, h: Record<string, string>) => { r.status = s; r.headers = h; }, end: (b?: string) => { r.body = b; } } as never }; };
  const req = (xff = '100.9.9.9', extra: Record<string, string> = {}) => ({ headers: { 'x-forwarded-for': xff, 'x-forwarded-proto': 'https', ...extra }, socket: { remoteAddress: '127.0.0.1' } }) as never;
  const TOKEN = 'correct-horse-battery-staple-123', T0 = Date.UTC(2026, 10, 7);
  assert.equal(IDLE_MS, 720 * HOUR);
  const store = mem(T0);
  assert.equal(handleAdminParam(req(), reply().res, new URL('http://x/'), TOKEN, store, T0), false);   // no parameter: not handled
  // right secret: cookie (HttpOnly, SameSite=Strict, Secure behind https, 30 days) holding a signed time, not the secret; redirect without the parameter
  let a = reply();
  assert.equal(handleAdminParam(req(), a.res, new URL(`http://x/page?admin=${TOKEN}&x=1`), TOKEN, store, T0), true);
  assert.equal(a.r.status, 302); assert.equal(a.r.headers!.location, '/page?x=1');
  const set = a.r.headers!['set-cookie'];
  assert.match(set, /HttpOnly; SameSite=Strict; Max-Age=2592000; Secure/); assert.ok(!set.includes(TOKEN));
  const cookie = set.split(';')[0];
  const as = (c: string, now: number, st = store, token: string | null = TOKEN) => adminSession(req('100.9.9.9', { cookie: c }), token ?? undefined, st, now);
  assert.equal(as(cookie, T0 + 10 * 60_000).ok, true);
  assert.equal(as(cookie, T0 + 10 * 60_000).renew, false);                       // used again within the hour: nothing to refresh
  assert.equal(as('cockpit_admin=1.abc', T0).ok, false);
  assert.equal(as(cookie, T0, store, null).ok, false);                       // no secret configured: no admin
  assert.equal(as(cookie, T0, store, 'another-secret').ok, false);                // a cookie from an old secret stops working when the secret changes
  // sliding: used on day 20, the session and the secret live on; the renewed cookie carries the new time
  const day20 = as(cookie, T0 + 20 * DAY);
  assert.deepEqual([day20.ok, day20.renew], [true, true]);
  assert.equal(store.last, T0 + 20 * DAY);
  const renewed = day20.cookie!.split(';')[0];
  assert.equal(as(renewed, T0 + 40 * DAY).ok, true);                              // 20 days after the last use
  // 720 hours (30 days) without use: the session and the secret are dead
  assert.equal(as(renewed, T0 + 20 * DAY + 30 * DAY + HOUR).ok, false);
  const stale = mem(T0 - 31 * DAY);
  assert.equal(tokenStatus(stale, T0).expired, true);
  assert.equal(as(cookie, T0, stale).ok, false);
  a = reply(); handleAdminParam(req(), a.res, new URL(`http://x/?admin=${TOKEN}`), TOKEN, stale, T0);
  assert.equal(a.r.status, 403); assert.match(a.r.body!, /expired.*admin-token -- new/);
  // off
  a = reply(); handleAdminParam(req(), a.res, new URL('http://x/?admin=off'), TOKEN, store, T0);
  assert.match(a.r.headers!['set-cookie'], /Max-Age=0/);
  // wrong guesses: refused, locked after five, free again after five minutes
  for (let i = 0; i < 5; i++) { a = reply(); handleAdminParam(req('100.7.7.7'), a.res, new URL('http://x/?admin=nope'), TOKEN, store, 1000); assert.equal(a.r.status, 403); }
  a = reply(); handleAdminParam(req('100.7.7.7'), a.res, new URL(`http://x/?admin=${TOKEN}`), TOKEN, mem(2000), 2000);
  assert.equal(a.r.status, 403, 'locked out even with the right secret for a while');
  a = reply(); handleAdminParam(req('100.7.7.7'), a.res, new URL(`http://x/?admin=${TOKEN}`), TOKEN, mem(1000 + 6 * 60_000), 1000 + 6 * 60_000);
  assert.equal(a.r.status, 302);
  // identity: the session makes anyone Admin, whatever device (even the HP X360); otherwise unchanged
  const diane = resolveIdentity(reqOf('100.102.99.110'), noWhois, true);
  assert.deepEqual([diane.name, diane.hide, diane.owns, diane.admin, diane.device], ['Admin', [], '*', true, 'hp-x360']);
  assert.equal(resolveIdentity(reqOf('100.102.99.110'), noWhois, false).name, 'Diane');
});

test('admin token file source: read from infra/env on every use so a new secret needs no restart; the last-use clock starts at the env file date', async () => {
  const { fileTokenSource, fileStore } = await import('../src/admin.ts');
  const { mkdtempSync, writeFileSync: wf, utimesSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'adm-')), env = join(dir, 'env');
  wf(env, '# c\nCOCKPIT_ADMIN_TOKEN=first\nOTHER=1\n');
  const src = fileTokenSource(env, undefined, 0);
  assert.equal(src(), 'first');
  wf(env, 'COCKPIT_ADMIN_TOKEN=second\n');
  assert.equal(src(), 'second');
  assert.equal(fileTokenSource(join(dir, 'missing'), 'fromenv', 0)(), 'fromenv');
  const old = new Date('2026-01-01T00:00:00Z'); utimesSync(env, old, old);
  const store = fileStore(join(dir, 'state.json'), env);
  assert.equal(store.lastUsed(), old.getTime());                                   // never used: the clock started when the secret was written
  store.touch(5000); assert.equal(store.lastUsed(), 5000);
});

test('visibility: tool links and the dashboard link stay for Frank and Diane and are removed only for a Guest', async () => {
  const { cards, errors, atlas, usage, lanes, agents } = await collect([demoSource]);
  const base = buildRollup(cards, errors, atlas, { usage, lanes, agents });
  const full = { ...base, ui: { ...base.ui, dashboardUrl: 'https://{host}:9443', links: [{ name: 'Voicebox TTS', url: 'http://{host}:8888/tts', group: 'Utility Portal' }] } };
  for (const who of [{ hide: [] as string[], system: true }, { hide: ['investments'], system: true }]) {
    const r = redactRollup(full, who);
    assert.equal(r.ui.links?.length, 1);
    assert.equal(r.ui.dashboardUrl, 'https://{host}:9443');
  }
  const guest = redactRollup(full, { hide: ['investments'], owns: [], system: false, guest: true });
  assert.deepEqual([guest.ui.links, guest.ui.dashboardUrl], [[], '']);
});
