import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type AppDeps } from '../src/app.ts';
import { resolveIdentity as resolveIdentityRaw, type Person, type Whois } from '../src/identity.ts';

// The lookups in these tests answer at once, so the identity is known at once (a promise appears only while tailscaled is being asked).
const resolveIdentity = (...a: Parameters<typeof resolveIdentityRaw>): Person => { const r = resolveIdentityRaw(...a); assert.ok(!(r instanceof Promise)); return r as Person; };
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
    // full automation: only the owner turns it on (directly or from the Edit dialog); Diane may turn it off
    assert.equal((await post('/api/projects/act', { project: 'p-mp', action: 'autonomy', level: 'full' }, 'diane')).status, 403);
    assert.equal((await post('/api/projects/act', { project: 'p-mp', action: 'edit', autonomy: 'full', priority: 2 }, 'diane')).status, 403);
    assert.equal((await post('/api/projects/act', { project: 'p-mp', action: 'autonomy', level: 'semi', by: 'Frank' }, 'diane')).status, 200);
    assert.equal((await post('/api/projects/act', { project: 'p-mp', action: 'autonomy', level: 'full' }, 'frank')).status, 200);
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

test('findTailscale: an installed binary is found even when PATH is bare (launchd); TAILSCALE_BIN wins; otherwise the plain name', async () => {
  const { findTailscale } = await import('../src/identity.ts');
  const only = (...have: string[]) => (p: string) => have.includes(p);
  assert.equal(findTailscale({}, only('/usr/local/bin/tailscale')), '/usr/local/bin/tailscale');
  assert.equal(findTailscale({}, only('/Applications/Tailscale.app/Contents/MacOS/Tailscale')), '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  assert.equal(findTailscale({ TAILSCALE_BIN: '/x/ts' }, only('/x/ts', '/usr/local/bin/tailscale')), '/x/ts');
  assert.equal(findTailscale({}, only()), 'tailscale');
});

test('roles: a Guest gets the redacted dashboard and nothing else; Diane cannot decide feedback, act on growth or read the audit log; every route is in the access table', async () => {
  const { ROUTES, checkAccess, roleOf } = await import('../src/access.ts');
  const { readFileSync } = await import('node:fs');
  const guestP = { hide: ['investments'], guest: true }, dianeP = { hide: ['investments'] }, frankP = { hide: [] };
  assert.deepEqual([roleOf(guestP), roleOf(dianeP), roleOf(frankP)], ['guest', 'member', 'owner']);
  const sample = (p: string | RegExp) => (typeof p === 'string' ? p : String(p).includes('growth') ? '/api/agents/coding/growth' : '/api/agents/coding');
  const guestMay = ROUTES.filter((r) => checkAccess(guestP, r.method, sample(r.path)).ok).map((r) => `${r.method} ${sample(r.path)}`);
  assert.deepEqual(guestMay, ['GET /api/me', 'GET /api/rollup', 'GET /api/brief']);
  const dianeMayNot = ROUTES.filter((r) => !checkAccess(dianeP, r.method, sample(r.path)).ok).map((r) => sample(r.path));
  assert.deepEqual(dianeMayNot, ['/api/audit', '/api/sessions', '/api/session', '/api/feedback/decide', '/api/decisions/act', '/api/mail/act', '/api/needs/act', '/api/needs/snooze', '/api/automation/default', '/api/growth/act']);
  assert.ok(ROUTES.every((r) => checkAccess(frankP, r.method, sample(r.path)).ok));
  assert.deepEqual([checkAccess(frankP, 'GET', '/api/nope'), checkAccess(frankP, 'GET', '/api/chat')], [{ ok: false, status: 404 }, { ok: false, status: 405 }]);
  // a handler added to app.ts without a line in the table would be unreachable; this says so by name
  const src = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  const used = new Set([...src.matchAll(/'(\/api\/[a-z/-]+)'/g)].map((m) => m[1]).filter((p) => !p.endsWith('/')));
  for (const p of used) assert.ok(ROUTES.some((r) => r.path === p), `${p} is handled in app.ts but missing from access.ts`);

  // over HTTP: the check runs before any handler, for reads and writes
  const { cards, errors, atlas, usage, lanes, agents } = await collect([demoSource]);
  const rollup = buildRollup(cards, errors, atlas, { usage, lanes, agents });
  const dir = mkdtempSync(join(tmpdir(), 'roles-'));
  writeFileSync(join(dir, 'index.html'), '<html>x</html>');
  const saved: string[] = [];
  const people: Record<string, unknown> = { guest: { name: 'Guest', hide: ['investments'], device: null, owns: [], system: false, guest: true }, diane: { name: 'Diane', hide: ['investments'], device: 'hp-x360' }, frank: { name: 'Frank', hide: [], device: null } };
  const deps = {
    publicDir: dir, guard: { allowedHosts: [] }, chat: { apiUrl: 'http://127.0.0.1:1', apiKey: 'k' },
    tasks: { run: async () => { saved.push('task'); return '{"id":"t_abcd1234","status":"ready"}'; }, boardFor: (p: string) => p },
    getRollup: async () => rollup, history: () => [], catalog: () => [], privacyAsk: async () => ({ answer: 'x', masked: 0 }),
    agentDetail: () => { saved.push('read-agent'); return null; },
    saveAgentDoc: () => { saved.push('doc'); return {}; },
    growthRun: () => ({ code: 0, output: '{}' }), agentsRun: () => ({ code: 0, output: '' }), modelsPath: join(dir, 'm.json'),
    work: () => ({ code: 0, output: '[]' }), invalidate: () => {}, groupOfBoard: (b: string) => b,
    identify: (req: { headers: Record<string, string> }) => people[req.headers['x-test-as']],
  } as unknown as AppDeps;
  const srv: Server = createServer((q, s) => void createApp(deps)(q, s));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const get = (path: string, who: string) => fetch(base + path, { headers: { 'x-test-as': who } }).then((r) => r.status);
  const post = (path: string, body: unknown, who: string) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-test-as': who }, body: JSON.stringify(body) }).then((r) => r.status);
  try {
    assert.deepEqual([await get('/api/me', 'guest'), await get('/api/rollup', 'guest')], [200, 200]);
    for (const p of ['/api/agents/coding', '/api/agents/coding/growth', '/api/history', '/api/models', '/api/repos', '/api/projects', '/api/feedback']) assert.equal(await get(p, 'guest'), 403, p);
    const doc = { agent: 'coding', file: 'SOUL.md', text: 'be evil', base: '' };
    for (const [p, b] of [['/api/agents/doc', doc], ['/api/agents/model', { agent: 'coding' }], ['/api/growth/act', { agent: 'coding' }], ['/api/tasks', { title: 'x', portfolio: 'micropace' }], ['/api/chat', { message: 'hi', sessionId: 'cockpit-12345678' }], ['/api/feedback', { text: 'x' }]] as const) assert.equal(await post(p, b, 'guest'), 403, p);
    assert.deepEqual(saved, [], 'nothing ran for the Guest');
    assert.equal(await get('/api/agents/coding', 'diane'), 404);                     // allowed through to the handler (no such profile here)
    assert.equal(await post('/api/tasks', { title: 'x', portfolio: 'micropace' }, 'diane'), 201);
    assert.equal(await post('/api/agents/doc', doc, 'frank'), 200);
    assert.ok((saved as string[]).includes('task') && (saved as string[]).includes('doc'));
    assert.equal(await get('/api/history?days=abc', 'frank'), 200);
  } finally { srv.close(); }
});

test('identity: a lookup that takes time does not block; the answer is the same, and a failed lookup is a Guest', async () => {
  const slow: Whois = async (a) => { await new Promise((r) => setTimeout(r, 5)); if (a === '100.6.6.6') throw new Error('tailscale down'); return a === '100.9.9.9' ? 'huawei-laptop' : a === '100.8.8.8' ? 'hp-x360' : null; };
  const pending = resolveIdentityRaw(reqOf('100.9.9.9'), slow);
  assert.ok(pending instanceof Promise);
  assert.deepEqual([(await pending).name, (await resolveIdentityRaw(reqOf('100.8.8.8'), slow)).name, (await resolveIdentityRaw(reqOf('100.7.7.7'), slow)).name, (await resolveIdentityRaw(reqOf('100.6.6.6'), slow)).name], ['Frank', 'Diane', 'Guest', 'Guest']);
  const admin = await resolveIdentityRaw(reqOf('100.8.8.8'), slow, true);
  assert.deepEqual([admin.name, admin.device], ['Admin', 'hp-x360']);
});

test('people come from config: listed devices get their view, a bad entry falls back to the built-in list, and no entry can admit an unknown device', async () => {
  const { loadPeople } = await import('../src/config.ts');
  const { buildPeople, DEFAULT_PEOPLE } = await import('../src/identity.ts');
  const list = loadPeople([{ name: 'Zoe', devices: ['Zoe-iPad'], addresses: ['100.5.5.5'], hide: ['investments', 'family'] }]);
  assert.deepEqual(list, [{ name: 'Zoe', devices: ['zoe-ipad'], addresses: ['100.5.5.5'], hide: ['investments', 'family'] }]);
  const people = buildPeople(list);
  const byName: Whois = (a) => (a === '100.8.8.8' ? 'hp-x360' : a === '100.4.4.4' ? 'zoe-ipad' : null);
  const who = (addr: string) => resolveIdentityRaw(reqOf(addr), byName, false, people) as Person;
  assert.deepEqual([who('100.5.5.5').name, who('100.5.5.5').hide], ['Zoe', ['investments', 'family']]);   // known address, no lookup
  assert.equal(who('100.4.4.4').name, 'Zoe');                                                              // by device name
  assert.equal(who('100.8.8.8').name, 'Frank');                                                            // Diane is not in this list: an ordinary tailnet device
  assert.equal(who('100.7.7.7').name, 'Guest');                                                            // unknown to tailscale: always a Guest
  assert.deepEqual(loadPeople(undefined), [...DEFAULT_PEOPLE]);
  const quiet = console.error; console.error = () => {};
  try {
    assert.deepEqual(loadPeople([{ name: 'Zoe', devices: ['zoe-ipad'], hide: ['investmnts'] }]), [...DEFAULT_PEOPLE]);   // a typo must not un-hide a portfolio
    assert.deepEqual(loadPeople([{ name: 'Zoe', devices: [] }]), [...DEFAULT_PEOPLE]);
  } finally { console.error = quiet; }
});

test('chat streams send keep-alive comments while a long local answer is prepared, so a proxy never sees an idle connection', async () => {
  const { streamPrivate } = await import('../src/chat.ts');
  const chunks: string[] = [];
  const handlers: Record<string, () => void> = {};
  const fake = { writableEnded: false, writeHead() {}, write(c: string) { chunks.push(c); return true; }, end() { fake.writableEnded = true; }, on(e: string, f: () => void) { handlers[e] = f; } };
  const res = fake as unknown as import('node:http').ServerResponse;
  await streamPrivate(res, async () => { await new Promise((r) => setTimeout(r, 120)); return { answer: 'ok', masked: 0 }; }, 'q', 20);
  const text = chunks.join('');
  assert.ok((text.match(/: keepalive/g) ?? []).length >= 3, 'several keep-alives during a 120 ms wait at 20 ms');
  assert.match(text, /"t":"text"[\s\S]*"t":"done"/);
});

test('chat: a share-ok: message from a limited viewer still reaches Atlas (the note for Atlas is added after the privacy check, so the tag is not buried)', async () => {
  const sent: string[] = [];
  const hermes = createServer((q, s) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { sent.push(JSON.parse(b).messages[0].content); s.writeHead(200, { 'content-type': 'text/event-stream' }); s.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); }); });
  await new Promise<void>((r) => hermes.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'who-')); writeFileSync(join(dir, 'index.html'), 'x');
  let asked = 0;
  const deps = { publicDir: dir, guard: { allowedHosts: [] }, chat: { apiUrl: `http://127.0.0.1:${(hermes.address() as AddressInfo).port}`, apiKey: 'k' }, privacyAsk: async () => { asked++; return { answer: 'x', masked: 0 }; },
    identify: () => ({ name: 'Diane', hide: ['investments'], device: 'hp-x360' }), invalidate: () => {} } as unknown as AppDeps;
  const srv = createServer((q, s) => void createApp(deps)(q, s));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const chat = (message: string) => fetch(base + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ message, sessionId: 'cockpit-abcdef12' }) }).then((r) => r.text());
  try {
    await chat('Share-OK: set up the account for me@example.org, code 482913');
    assert.equal(asked, 0); assert.equal(sent.length, 1);
    assert.match(sent[0], /^\[Cockpit context: the person writing is Diane\./); assert.match(sent[0], /Share-OK: set up the account/);
    await chat('my email is me@example.org');                                   // no tag: private, handled locally, never forwarded
    assert.equal(asked, 1); assert.equal(sent.length, 1);
  } finally { srv.closeAllConnections(); srv.close(); hermes.close(); }
});

test('Diane may change an agent\'s model and prompt; each change and each refused write lands in the audit log; lines she cannot see are never overwritten; only the owner reads the log', async () => {
  const { fileAudit } = await import('../src/audit.ts');
  const { statSync } = await import('node:fs');
  const { cards, errors, atlas, usage, lanes, agents } = await collect([demoSource]);
  const rollup = buildRollup(cards, errors, atlas, { usage, lanes, agents });
  const agent = rollup.agents[0];
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  writeFileSync(join(dir, 'index.html'), '<html>x</html>');
  writeFileSync(join(dir, 'm.json'), JSON.stringify({ choices: [{ provider: 'p', model: 'm1', label: 'M1', billing: 'x', private: false }], lanes: [] }));
  const logPath = join(dir, 'audit.jsonl');
  const souls: Record<string, string> = { writer: 'Be brief.\nKeep it short.\n', coding: 'Be brief.\nTracks the Investments portfolio weekly\n' };
  const saves: string[] = [];
  const people: Record<string, unknown> = { guest: { name: 'Guest', hide: ['investments'], device: null, owns: [], system: false, guest: true }, diane: { name: 'Diane', hide: ['investments'], device: 'hp-x360' }, frank: { name: 'Frank', hide: [], device: null } };
  const deps = {
    publicDir: dir, guard: { allowedHosts: [] }, chat: { apiUrl: 'http://127.0.0.1:1', apiKey: 'k' },
    tasks: { run: async () => '{}', boardFor: (p: string) => p },
    getRollup: async () => rollup, history: () => [], catalog: () => [], privacyAsk: async () => ({ answer: 'x', masked: 0 }),
    agentDetail: (id: string) => (id in souls ? { prompt: { text: souls[id] }, memory: { memory: { text: '' }, user: { text: '' } } } : null),
    saveAgentDoc: (id: string, file: string, text: string) => { saves.push(`${id}/${file}`); return {}; },
    growthRun: () => ({ code: 0, output: '{}' }), agentsRun: () => ({ code: 0, output: 'ok' }), modelsPath: join(dir, 'm.json'),
    work: () => ({ code: 0, output: '[]' }), invalidate: () => {}, groupOfBoard: (b: string) => b,
    audit: fileAudit(logPath),
    identify: (req: { headers: Record<string, string> }) => people[req.headers['x-test-as']],
  } as unknown as AppDeps;
  const srv: Server = createServer((q, r) => void createApp(deps)(q, r));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const get = (path: string, who: string) => fetch(base + path, { headers: { 'x-test-as': who } });
  const post = (path: string, body: unknown, who: string) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-test-as': who }, body: JSON.stringify(body) });
  try {
    const m = await post('/api/agents/model', { agent: agent.id, provider: 'p', model: 'm1' }, 'diane');
    assert.equal(m.status, 200);
    const ok = await post('/api/agents/doc', { agent: 'writer', file: 'soul', text: 'Be brief.\nAnswer in Spanish.\n', base: 'x' }, 'diane');
    assert.equal(ok.status, 200);
    const hidden = await post('/api/agents/doc', { agent: 'coding', file: 'soul', text: 'Be brief.\n', base: 'x' }, 'diane');
    assert.equal(hidden.status, 403);                                                       // her view lacks the Investments line: saving would delete it
    assert.deepEqual(saves, ['writer/soul'], 'the refused edit never reached the file');
    assert.equal((await post('/api/agents/model', { agent: agent.id, provider: 'p', model: 'm1' }, 'guest')).status, 403);
    assert.equal((await post('/api/agents/doc', { agent: 'coding', file: 'soul', text: 'password: hunter22secret\nBe brief.\n', base: 'x' }, 'frank')).status, 200);   // the owner is not limited by hidden lines

    assert.equal((await get('/api/audit', 'diane')).status, 403);
    assert.equal((await get('/api/audit', 'guest')).status, 403);
    const { entries } = await (await get('/api/audit', 'frank')).json() as { entries: Array<{ who: string; device: string | null; action: string; target: string; ok: boolean; detail: Record<string, string | number | boolean> }> };
    assert.deepEqual(entries.map((e) => [e.who, e.action, e.target, e.ok]), [
      ['Diane', 'agents.model', agent.id, true],
      ['Diane', 'agents.doc', 'writer/soul', true],
      ['Diane', 'agents.doc', 'coding/soul', false],
      ['Guest', 'denied', '/api/agents/model', false],
      ['Frank', 'agents.doc', 'coding/soul', true],
    ]);
    assert.deepEqual([entries[0].device, entries[0].detail.from, entries[0].detail.to], ['hp-x360', `${agent.provider ?? '?'}/${agent.model ?? '?'}`, 'p/m1']);
    assert.equal(entries[1].detail.diff, '- Keep it short.\n+ Answer in Spanish.');
    assert.match(String(entries[2].detail.reason), /cannot see/);
    assert.doesNotMatch(readFileSync(logPath, 'utf8'), /hunter22secret/, 'a secret typed into a prompt is masked before it is logged');
    assert.equal(statSync(logPath).mode & 0o777, 0o600);
  } finally { srv.close(); }
});

test('audit: lineDiff names removed and added lines, and the log tolerates a half-written line', async () => {
  const { lineDiff, fileAudit } = await import('../src/audit.ts');
  assert.deepEqual(lineDiff('a\nb\nc\n', 'a\nc\nd\n'), { removed: 1, added: 1, text: '- b\n+ d' });
  assert.equal(lineDiff('same\n', 'same\n').text, '');
  assert.match(lineDiff('x', 'y'.repeat(10_000), 100).text, /… \(cut\)$/);
  const dir = mkdtempSync(join(tmpdir(), 'audit2-'));
  const path = join(dir, 'a.jsonl');
  writeFileSync(path, '{"at":"t","who":"Frank","device":null,"action":"a","target":"b","ok":true}\n{"at":"t2","who":"Fr');
  assert.equal(fileAudit(path).read().length, 1);
  assert.deepEqual(fileAudit(join(dir, 'none.jsonl')).read(), []);
});

test('version: the page can tell prod from dev from demo; restart pending when the files moved on after the process started', async () => {
  const { versionSource } = await import('../src/version.ts');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'ver-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); writeFileSync(join(dir, 'a.txt'), '1'); git('add', '.'); git('commit', '-q', '-m', 'one');
  const v = versionSource(dir, 'dev');
  const first = await v();
  assert.deepEqual([first.env, first.branch, first.dirty, first.restartPending], ['dev', 'main', false, false]);
  assert.match(first.headSha ?? '', /^[0-9a-f]{7,}$/);
  writeFileSync(join(dir, 'a.txt'), '2'); git('commit', '-q', '-am', 'two');
  await new Promise((r) => setTimeout(r, 5100));                      // the answer is cached for 5 s
  const later = await v();
  assert.equal(later.restartPending, true);                              // HEAD moved, the process still has the old code
  assert.notEqual(later.headSha, later.loadedSha);
  assert.equal((await versionSource(dir, 'prod')()).env, 'prod');
  assert.equal((await versionSource(join(dir, 'not-a-repo'), 'demo')()).headSha, null);   // no git: unknown, not an error
});
