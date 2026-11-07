import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type AppDeps } from '../src/app.ts';
import { checkWrite, readJson, BodyError } from '../src/security.ts';
import { loadHermesApiKey, sseFrames, validateChat } from '../src/chat.ts';
import { assignTask, createTask, TaskError } from '../src/tasks.ts';
import { agentDetail, maskSensitive, saveAgentDoc, DocError } from '../src/sources/agentDetail.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { buildRollup, staffingFor } from '../src/rollup.ts';
import { demoSource } from '../src/sources/demo.ts';
import { collect } from '../src/rollup.ts';
import { loadCatalog } from '../../../packages/roster/catalog.ts';

const GUARD = { allowedHosts: ['mini.example.ts.net'] };
const req = (o: any) => ({ method: 'POST', headers: { host: '127.0.0.1:3200', origin: 'http://127.0.0.1:3200', 'content-type': 'application/json' }, ...o, headers: { host: '127.0.0.1:3200', origin: 'http://127.0.0.1:3200', 'content-type': 'application/json', ...(o.headers ?? {}) } });

test('write guard: same-origin JSON on an allowed host passes; the web-page attacks do not', () => {
  assert.deepEqual(checkWrite(req({}), GUARD), { ok: true });
  assert.equal((checkWrite(req({ headers: { origin: 'https://evil.example' } }), GUARD) as any).status, 403); // another site's page
  assert.equal((checkWrite(req({ headers: { origin: undefined } }), GUARD) as any).status, 403); // no Origin at all
  assert.equal((checkWrite(req({ headers: { host: 'evil.example', origin: 'http://evil.example' } }), GUARD) as any).status, 403); // DNS rebinding
  assert.equal((checkWrite(req({ headers: { 'content-type': 'text/plain' } }), GUARD) as any).status, 415); // "simple" cross-site POST
  assert.equal((checkWrite(req({ method: 'GET' }), GUARD) as any).status, 405);
  const tailnet = req({ headers: { host: 'mini.example.ts.net', origin: 'https://mini.example.ts.net' } });
  assert.deepEqual(checkWrite(tailnet, GUARD), { ok: true });
});

test('write guard: a configured token is required and compared strictly', () => {
  const g = { ...GUARD, token: 's3cret' };
  assert.equal((checkWrite(req({}), g) as any).status, 401);
  assert.equal((checkWrite(req({ headers: { 'x-cockpit-token': 'wrong!' } }), g) as any).status, 401);
  assert.deepEqual(checkWrite(req({ headers: { 'x-cockpit-token': 's3cret' } }), g), { ok: true });
});

test('JSON bodies are size-capped and must be objects', async () => {
  const stream = (s: string) => (async function* () { yield Buffer.from(s); })();
  assert.deepEqual(await readJson(stream('{"a":1}')), { a: 1 });
  await assert.rejects(() => readJson(stream('x'.repeat(40_000))), (e: any) => e instanceof BodyError && e.status === 413);
  await assert.rejects(() => readJson(stream('[1]')), (e: any) => e.status === 400);
  await assert.rejects(() => readJson(stream('nope')), (e: any) => e.status === 400);
});

test('chat input validation and API-key loading (the key is read from one line, never echoed)', async () => {
  assert.equal(validateChat({ message: '  hi ', sessionId: 'cockpit-abc12345' }).ok, true);
  assert.equal(validateChat({ message: '', sessionId: 'cockpit-abc12345' }).ok, false);
  assert.equal(validateChat({ message: 'x', sessionId: 'telegram-1' }).ok, false);
  assert.equal(validateChat({ message: 'x'.repeat(9000), sessionId: 'cockpit-abc12345' }).ok, false);
  const home = await mkdtemp(join(tmpdir(), 'hh-'));
  writeFileSync(join(home, '.env'), 'OTHER=1\nAPI_SERVER_KEY="k-123"\nTOKEN=zzz\n');
  assert.equal(loadHermesApiKey({}, home), 'k-123');
  assert.equal(loadHermesApiKey({ HERMES_API_KEY: 'explicit' }, home), 'explicit');
  assert.equal(loadHermesApiKey({}, '/nope'), undefined);
});

test('SSE frames: events, multi-chunk splits and keepalive comments', async () => {
  const chunks = [': keepalive\n\ndata: {"a":1}\n\nevent: hermes.tool.pro', 'gress\ndata: {"label":"x"}\n\ndata: [DONE]\n\n'];
  const out: any[] = [];
  for await (const f of sseFrames((async function* () { for (const c of chunks) yield new TextEncoder().encode(c); })())) out.push(f);
  assert.deepEqual(out, [{ event: 'message', data: '{"a":1}' }, { event: 'hermes.tool.progress', data: '{"label":"x"}' }, { event: 'message', data: '[DONE]' }]);
});

/** A fake Hermes API server that records what it received and streams a reply. */
async function fakeHermes(handler: (req: any, body: any, res: any) => void) {
  const seen: any = {};
  const srv = createServer((rq, rs) => {
    let b = '';
    rq.on('data', (c) => (b += c));
    rq.on('end', () => { seen.headers = rq.headers; seen.url = rq.url; seen.body = b ? JSON.parse(b) : null; handler(rq, seen.body, rs); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, seen, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
}

async function cockpit(over: Partial<AppDeps> = {}) {
  const calls: string[][] = [];
  const { cards, errors, atlas, usage, lanes, agents } = await collect([demoSource]);
  const rollup = buildRollup(cards, errors, atlas, { usage, lanes, agents });
  const dir = await mkdtemp(join(tmpdir(), 'pub-'));
  writeFileSync(join(dir, 'index.html'), '<html>cockpit</html>');
  const deps: AppDeps = {
    publicDir: dir, guard: GUARD, chat: { apiUrl: 'http://127.0.0.1:1', apiKey: 'key' },
    tasks: { run: async (a) => { calls.push(a); return JSON.stringify({ id: 't_abc123', status: a.includes('--initial-status') ? 'blocked' : 'ready' }); }, boardFor: (p) => ({ 'ai-thrival': 'ai-thrival', micropace: 'micropace-labs' } as any)[p] },
    growthRun: () => ({ code: 0, output: '{"agent":"coding","about":[],"lessons":[]}' }), privacyAsk: async () => ({ answer: 'Spending was steady; about 12% went to rent.', masked: 2 }), agentsRun: () => ({ code: 0, output: '[]' }), modelsPath: join(process.cwd(), 'config', 'models.json'), work: () => ({ code: 0, output: '[]' }), getRollup: async () => rollup, history: () => [], agentDetail: () => null, catalog: () => [], invalidate: () => {}, ...over,
  };
  const srv: Server = createServer((q, s) => void createApp(deps)(q, s));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
  return { base, post, calls, close: () => { srv.closeAllConnections(); srv.close(); } };
}

test('POST /api/chat streams Atlas’ reply as simple events, sends the key and session upstream, and never leaks the key', async () => {
  const hermes = await fakeHermes((_q, _b, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: any, fin: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: fin }] })}\n\n`;
    res.write(chunk({ reasoning_content: 'thinking' }));
    res.write(`event: hermes.tool.progress\ndata: ${JSON.stringify({ label: 'kanban_list' })}\n\n`);
    res.write(chunk({ content: 'Hello ' })); res.write(chunk({ content: 'Frank' })); res.write(chunk({}, 'stop'));
    res.end('data: [DONE]\n\n');
  });
  const c = await cockpit({ chat: { apiUrl: hermes.url, apiKey: 'super-secret-key' } });
  const r = await c.post('/api/chat', { message: 'How is everything?', sessionId: 'cockpit-abcdef12' });
  const text = await r.text();
  assert.equal(r.status, 200);
  const events = text.trim().split('\n\n').map((l) => JSON.parse(l.slice(6)));
  assert.deepEqual(events.map((e) => e.t), ['think', 'tool', 'text', 'text', 'done']);
  assert.equal(events.filter((e) => e.t === 'text').map((e) => e.v).join(''), 'Hello Frank');
  assert.equal(hermes.seen.headers.authorization, 'Bearer super-secret-key');
  assert.equal(hermes.seen.headers['x-hermes-session-id'], 'cockpit-abcdef12');
  assert.deepEqual(hermes.seen.body.messages, [{ role: 'user', content: 'How is everything?' }]); // history lives in the Hermes session
  assert.ok(!text.includes('super-secret-key'));
  c.close(); hermes.srv.close();
});

test('chat errors are reported to the browser: no key, wrong key, Hermes down', async () => {
  const ev = async (c: any) => { const r = await c.post('/api/chat', { message: 'hi', sessionId: 'cockpit-abcdef12' }); return JSON.parse((await r.text()).trim().slice(6)); };
  let c = await cockpit({ chat: { apiUrl: 'http://127.0.0.1:1', apiKey: undefined } });
  assert.match((await ev(c)).v, /no Hermes API key/); c.close();
  const hermes = await fakeHermes((_q, _b, res) => { res.writeHead(401); res.end(); });
  c = await cockpit({ chat: { apiUrl: hermes.url, apiKey: 'bad' } });
  assert.match((await ev(c)).v, /rejected the API key/); c.close(); hermes.srv.close();
  c = await cockpit({ chat: { apiUrl: 'http://127.0.0.1:1', apiKey: 'k' } });
  assert.match((await ev(c)).v, /Could not reach Hermes/); c.close();
});

test('API writes refuse cross-origin and wrong-host requests; reads refuse unknown hosts', async () => {
  const c = await cockpit();
  assert.equal((await c.post('/api/tasks', { portfolio: 'ai-thrival', title: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(c.base + '/api/tasks', { method: 'POST', headers: { origin: c.base, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  // fetch() will not let a script set Host, so use a raw request to play the DNS-rebinding page.
  const rebound = await new Promise<number>((resolve) => {
    const u = new URL(c.base);
    const rq = httpRequest({ host: u.hostname, port: u.port, path: '/api/rollup', headers: { host: 'evil.example' } }, (rs) => { rs.resume(); resolve(rs.statusCode!); });
    rq.end();
  });
  assert.equal(rebound, 403);
  assert.equal((await fetch(c.base + '/api/rollup')).status, 200);
  assert.equal((await fetch(c.base + '/healthz')).status, 200);
  c.close();
});

test('POST /api/tasks: unassigned → created blocked with a staffing check; assigned → ready; bad input is refused', async () => {
  const c = await cockpit();
  let r = await c.post('/api/tasks', { portfolio: 'ai-thrival', title: '--looks like a flag', body: 'details' });
  const made: any = await r.json();
  assert.equal(r.status, 201);
  assert.deepEqual([made.task.id, made.task.status, made.task.board, made.task.assignee], ['t_abc123', 'blocked', 'ai-thrival', null]);
  assert.ok(made.staffing && ['covered', 'gap', 'no-team'].includes(made.staffing.verdict));
  const args = c.calls.at(-1)!;
  assert.deepEqual(args.slice(0, 5), ['kanban', '--board', 'ai-thrival', 'create', '--json']);
  assert.ok(args.includes('--initial-status') && args.at(-2) === '--' && args.at(-1) === '--looks like a flag'); // the title cannot become a flag

  r = await c.post('/api/tasks', { portfolio: 'micropace', title: 'Fix parser', assignee: 'coding' });
  const owned: any = await r.json();
  assert.equal(owned.staffing, null);
  assert.ok(c.calls.at(-1)!.includes('--assignee') && !c.calls.at(-1)!.includes('--initial-status'));

  assert.equal((await c.post('/api/tasks', { portfolio: 'ai-thrival', title: 'x', assignee: 'qa' })).status, 400); // proposed agent: no profile yet
  assert.equal((await c.post('/api/tasks', { portfolio: 'family', title: 'x' })).status, 400); // no board mapped
  assert.equal((await c.post('/api/tasks', { portfolio: 'ai-thrival', title: '' })).status, 400);
  assert.equal((await c.post('/api/tasks', { portfolio: 'ai-thrival', title: 'x'.repeat(300) })).status, 400);
  c.close();
});

test('assign releases a parked (blocked) task; finished tasks cannot be reassigned', async () => {
  const calls: string[][] = [];
  const deps = (status: string) => ({
    run: async (a: string[]) => { calls.push(a); return a[3] === 'show' || a.includes('show') ? JSON.stringify({ task: { status } }) : ''; },
    boardFor: () => 'ai-thrival', assignable: () => ['coding'],
  });
  const r = await assignTask(deps('blocked'), { portfolio: 'ai-thrival', id: 't_abc123', assignee: 'coding' });
  assert.deepEqual([r.status, calls.map((c) => c[3])], ['ready', ['show', 'assign', 'unblock']]);
  calls.length = 0;
  await assert.rejects(() => assignTask(deps('done'), { portfolio: 'ai-thrival', id: 't_abc123', assignee: 'coding' }), (e: any) => e instanceof TaskError && e.status === 409);
  await assert.rejects(() => assignTask(deps('ready'), { portfolio: 'ai-thrival', id: 'not-an-id', assignee: 'coding' }), (e: any) => e.status === 400);
  await assert.rejects(() => createTask({ ...deps('x'), run: async () => { throw new Error('boom'); } }, { portfolio: 'ai-thrival', title: 't' }), (e: any) => e.status === 502);
});

test('unassigned tasks become staffing items in the rollup and Needs-you, with task actions', async () => {
  const { cards, errors, atlas, usage, lanes, agents } = await collect([demoSource]);
  const board = cards.find((c) => c.id === 'ai-thrival')!;
  board.unassigned = [{ id: 't_1', title: 'Write the App Store listing and keywords', body: '', status: 'blocked' }, { id: 't_2', title: 'GDPR privacy review of the data we store', body: '', status: 'blocked' }];
  const dir = await mkdtemp(join(tmpdir(), 'cat-'));
  mkdirSync(join(dir, 'specialized'), { recursive: true });
  writeFileSync(join(dir, 'divisions.json'), JSON.stringify({ divisions: { specialized: {} } }));
  writeFileSync(join(dir, 'specialized', 'data-privacy-officer.md'), '---\nname: Data Privacy Officer\ndescription: GDPR privacy compliance reviews of stored personal data\n---\nbody');
  const catalog = loadCatalog(dir);
  const items = staffingFor(cards, agents!, catalog);
  assert.deepEqual(items.map((i) => [i.taskId, i.result.verdict]), [['t_1', 'covered'], ['t_2', 'gap']]);
  const r = buildRollup(cards, errors, atlas, { usage, lanes, agents, catalog });
  const need = r.needsYou.filter((n) => n.kind === 'staffing');
  assert.equal(need.length, 2);
  assert.ok(need.find((n) => n.task?.id === 't_2')!.title.includes('consider Data Privacy Officer'));
  assert.equal(need.find((n) => n.task?.id === 't_1')!.severity, 'info');
  assert.ok(!r.needsYou.some((n) => n.kind === 'blocker' && /GDPR/.test(n.title))); // not double-reported as a plain blocker
});

/** A Hermes profile folder with a persona block, skills (with usage + manifest), and memory containing sensitive text. */
async function profile() {
  const home = await mkdtemp(join(tmpdir(), 'agent-detail-'));
  const dir = join(home, 'profiles', 'content');
  const skill = (cat: string, name: string, desc: string) => { mkdirSync(join(dir, 'skills', cat, name), { recursive: true }); writeFileSync(join(dir, 'skills', cat, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nbody`); };
  skill('writing', 'blog-post', 'Write blog posts'); skill('writing', 'my-learned-skill', 'Written by the agent'); skill('misc', 'old-one', 'Archived'); skill('misc', 'hub-one', 'From the hub'); skill('misc', 'by-hand', 'Placed by hand');
  mkdirSync(join(dir, 'skills', '.hub'), { recursive: true }); writeFileSync(join(dir, 'skills', '.hub', 'lock.json'), JSON.stringify({ installed: { 'hub-one': { source: 'clawhub' } } }));
  mkdirSync(join(dir, 'skills', 'agent-lanes'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'agent-lanes', 'SKILL.md'), '---\nname: agent-lanes\ndescription: lanes\n---\n');
  writeFileSync(join(dir, 'skills', '.bundled_manifest'), 'blog-post:abc\nold-one:def\n');
  writeFileSync(join(dir, 'skills', '.usage.json'), JSON.stringify({ 'blog-post': { use_count: 7, last_used_at: '2026-10-30T00:00:00Z', patch_count: 1 }, 'my-learned-skill': { use_count: 2, created_at: '2026-10-20T00:00:00Z', created_by: 'agent' }, 'old-one': { state: 'archived' }, 'by-hand': { state: 'stale' } }));
  mkdirSync(join(dir, 'memories'), { recursive: true });
  writeFileSync(join(dir, 'memories', 'MEMORY.md'), 'Frank prefers short posts. Contact frank@example.com acct 123456789012 key sk-abcdefghijklmnopqrstuvwx\n');
  writeFileSync(join(dir, 'memories', 'USER.md'), 'Likes Melbourne.\n');
  writeFileSync(join(dir, 'config.yaml'), 'memory:\n  memory_char_limit: 3000\n  user_char_limit: 1000\n');
  writeFileSync(join(dir, 'SOUL.md'), 'Old text.\n<!-- agent-roster:begin -->\n# Content\nBe clear. password: hunter2hunter2\n<!-- agent-roster:end -->\n');
  const registryPath = join(home, 'agents.json');
  writeFileSync(registryPath, JSON.stringify({ catalog: { dir: '/nope' }, agents: [{ id: 'content', profile: 'content', name: 'Content', role: 'writer', persona: { slug: 'marketing/x', sha256: 'abc', name: 'C', division: 'marketing', commit: '' }, portfolios: ['ai-thrival'] }] }));
  return { home, registryPath };
}

test('agent detail: prompt, skills (bundled / platform / learned, archived hidden, usage) and memory, with sensitive text masked', async () => {
  const { home, registryPath } = await profile();
  const d = agentDetail({ home, registryPath, id: 'content' })!;
  assert.deepEqual([d.profile, d.prompt.roster.installed, d.prompt.roster.drift], ['content', true, 'catalog-missing']);
  assert.ok(!d.prompt.text.includes('hunter2hunter2') && d.prompt.text.includes('[MASKED]'));
  assert.deepEqual([d.skills.total, d.skills.bundled, d.skills.platform, d.skills.agent, d.skills.hub, d.skills.added, d.skills.archived], [5, 1, 1, 1, 1, 1, 1]);
  assert.equal(d.skills.items.find((x) => x.name === 'by-hand')!.stale, true);
  assert.equal(d.skills.items[0].name, 'blog-post'); // most used first
  assert.deepEqual([d.skills.items[0].uses, d.skills.items[0].patches], [7, 1]);
  assert.ok(!d.skills.items.some((s) => s.name === 'old-one'));
  assert.deepEqual(d.skills.byCategory.map((c) => c.category).sort(), ['(top level)', 'misc', 'writing']);
  assert.deepEqual([d.memory.memory.limit, d.memory.user.limit, d.memory.user.text.trim()], [3000, 1000, 'Likes Melbourne.']);
  assert.ok(!/frank@example\.com|123456789012|sk-abcdefghijklmnop/.test(d.memory.memory.text));
  assert.equal(agentDetail({ home, registryPath, id: 'ghost' }), null);
  assert.equal(agentDetail({ home, registryPath, id: '../../etc' }), null);
  assert.match(maskSensitive('Bearer abcdefghijklmnopqrstuvwxyz0123 and AKIAABCDEFGHIJKLMNOP'), /^\[MASKED:secret\] and \[MASKED:secret\]$/);
});

test('GET /api/agents/:id serves the detail, 404s unknown agents', async () => {
  const { home, registryPath } = await profile();
  const c = await cockpit({ agentDetail: (id) => agentDetail({ home, registryPath, id }) });
  assert.equal(((await (await fetch(c.base + '/api/agents/content')).json()) as any).skills.total, 5);
  assert.equal((await fetch(c.base + '/api/agents/ghost')).status, 404);
  c.close();
});

test('projects API: reads through the work CLI, maps actions to fixed arguments, refuses everything else', async () => {
  const seen: string[][] = [];
  const t = await cockpit({ work: (argv: string[]) => { seen.push(argv); return argv[0] === 'projects' ? { code: 0, output: '[{"id":"p1"}]' } : argv.includes('bad-plan') ? { code: 1, output: 'error: nope' } : { code: 0, output: 'ok' }; } } as any);
  try {
    const list = await fetch(t.base + '/api/projects');
    assert.deepEqual(await list.json(), [{ id: 'p1' }]);
    const ok = await t.post('/api/projects/act', { project: 'p1', action: 'priority', priority: 1 });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen.find((a) => a[0] === 'project'), ['project', 'set', 'p1', '--priority', '1', '--apply']);
    seen.length = 0;
    assert.equal((await t.post('/api/projects/act', { project: 'p1', action: 'approve', comment: 'Keep it\nsimple' })).status, 200);
    assert.deepEqual(seen.find((a) => a[1] === 'approve'), ['project', 'approve', 'p1', '--note', 'Keep it simple', '--apply']);
    assert.deepEqual(seen.find((a) => a[0] === 'projects'), ['projects', '--id', 'p1']); // only the changed project is re-read
    assert.deepEqual(seen.find((a) => a[0] === 'advance'), ['advance', '--project', 'p1', '--apply']); // approval starts the automation, nothing else
    for (const bad of [{ project: 'P 1;rm', action: 'pause' }, { project: 'p1', action: 'priority', priority: 9 }, { project: 'p1', action: 'shell' }, { project: 'p1', action: 'plan', op: 'move', key: 'Bad Key' }]) {
      assert.equal((await t.post('/api/projects/act', bad)).status, 400, JSON.stringify(bad));
    }
    const refused = await t.post('/api/projects/act', { project: 'bad-plan', action: 'pause' });
    assert.equal(refused.status, 422);
    const noOrigin = await fetch(t.base + '/api/projects/act', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
    assert.equal(noOrigin.status, 403);
  } finally { t.close(); }
});

test('projects API: linking a repo and test command maps to fixed arguments; shell-looking input is refused', async () => {
  const seen: string[][] = [];
  const t = await cockpit({ work: (argv: string[]) => { seen.push(argv); return { code: 0, output: argv[0] === 'repos' ? '[{"portfolio":"micropace","id":"datahub","path":"DataHub","exists":true}]' : '[]' }; } } as any);
  try {
    assert.equal((await t.post('/api/projects/act', { project: 'p1', action: 'repo', repo: 'datahub', test_cmd: 'npm test' })).status, 200);
    assert.deepEqual(seen.find((a) => a[0] === 'project'), ['project', 'set', 'p1', '--repo', 'datahub', '--test-cmd', 'npm test', '--apply']);
    assert.equal((await t.post('/api/projects/act', { project: 'p1', action: 'repo', repo: '$(rm -rf ~)' })).status, 400);
    assert.equal((await t.post('/api/projects/act', { project: 'p1', action: 'repo' })).status, 400);
    assert.deepEqual(await (await fetch(t.base + '/api/repos')).json(), [{ portfolio: 'micropace', id: 'datahub', path: 'DataHub', exists: true }]);
  } finally { t.close(); }
});

test('new project: the form becomes one fixed propose command; approving hands planning to pm as a task', async () => {
  const seen: string[][] = [];
  const t = await cockpit({ work: (argv: string[]) => { seen.push(argv); return argv[0] === 'projects' ? { code: 0, output: '[{"id":"my-app","portfolio":"micropace"}]' } : { code: 0, output: 'ok' }; } } as any);
  try {
    const r = await t.post('/api/projects/propose', { portfolio: 'micropace', outcome: 'Ship the Notice to Calendar app', done_when: ['Gate passes', 'Live on HTTPS'], repo: 'datahub', priority: 2, deploy_targets: 'app.example.com' });
    assert.equal(r.status, 201);
    const argv = seen.find((a) => a[1] === 'propose')!;
    assert.deepEqual(argv.slice(0, 5), ['project', 'propose', 'micropace', '--id', 'ship-notice-calendar-app']);
    assert.ok(argv.includes('--apply') && argv.includes('--repo') && !argv.includes('--team'));
    for (const bad of [{ portfolio: 'micropace', outcome: '', done_when: ['x'] }, { portfolio: 'micropace', outcome: 'x', done_when: [] }, { portfolio: 'Bad Portfolio', outcome: 'x', done_when: ['y'] }, { portfolio: 'micropace', outcome: 'x', done_when: ['y'], deploy_targets: 'a b;rm' }]) {
      assert.equal((await t.post('/api/projects/propose', bad)).status, 400, JSON.stringify(bad));
    }
    const ap = await t.post('/api/projects/act', { project: 'my-app', action: 'approve' });
    assert.equal(ap.status, 200);
    const body = await ap.json();
    assert.ok(body.planning.id || body.planning.skipped); // pm is a demo agent here; either a task id or an explanation
  } finally { t.close(); }
});

test('new-repo proposals create the repo first, then link it; the Edit action maps to fixed commands and is refused for bad input', async () => {
  const seen: string[][] = [];
  const t = await cockpit({ work: (argv: string[]) => { seen.push(argv); return { code: 0, output: '[]' }; } } as any);
  try {
    const made = await t.post('/api/projects/propose', { portfolio: 'micropace', outcome: 'Notes to text', done_when: ['OCR works'], test_cmd: 'npm test', new_repo: { id: 'photo-notes' } });
    assert.equal(made.status, 201);
    const order = seen.map((a) => a.slice(0, 2).join(' ')).filter((x) => /^(repo create|project propose)/.test(x));
    assert.deepEqual(order, ['repo create', 'project propose']);
    assert.ok(seen.find((a) => a[1] === 'propose')!.includes('photo-notes'));
    assert.equal((await t.post('/api/projects/propose', { portfolio: 'micropace', outcome: 'x', done_when: ['y'], new_repo: { id: 'Bad Name' } })).status, 400);
    seen.length = 0;
    const ed = await t.post('/api/projects/act', { project: 'p1', action: 'edit', outcome: 'Sharper', done_when: ['a', 'b'], priority: 2, repo: 'datahub', test_cmd: 'npm test' });
    assert.equal(ed.status, 200);
    assert.deepEqual(seen.filter((a) => a[0] === 'project').map((a) => a.slice(0, 3).join(' ')), ['project edit p1', 'project set p1']);
    assert.equal((await t.post('/api/projects/act', { project: 'p1', action: 'edit' })).status, 400);
    assert.equal((await t.post('/api/projects/act', { project: 'p1', action: 'edit', priority: 7 })).status, 400);
    assert.equal((await t.post('/api/projects/act', { project: 'p1', action: 'edit', repo: '$(x)' })).status, 400);
  } finally { t.close(); }
});

test('model switching: only catalog models, only local models for Personal Privacy, one fixed agents command', async () => {
  const seen: string[][] = [];
  const t = await cockpit({ agentsRun: (argv: string[]) => { seen.push(argv); return { code: 0, output: argv[0] === 'models' ? '[{"provider":"openai-codex","status":"rate-limited","note":"weekly limit"}]' : 'ok' }; } } as any);
  try {
    const catalog = await (await fetch(t.base + '/api/models')).json();
    assert.ok(catalog.lanes.some((l: any) => l.id === 'claude'));
    const list = catalog.models;
    assert.equal(list.find((m: any) => m.model === 'gpt-6-luna').status, 'rate-limited');
    assert.equal(list.find((m: any) => m.model === 'claude-sonnet-5-5').status, 'ok');
    assert.equal((await t.post('/api/agents/model', { agent: 'pm', provider: 'anthropic', model: 'claude-sonnet-5-5' })).status, 200);
    assert.deepEqual(seen.find((a) => a[0] === 'set'), ['set', 'pm', '--model', 'claude-sonnet-5-5', '--provider', 'anthropic', '--add-lane', 'claude', '--apply']);
    assert.equal((await t.post('/api/agents/model', { agent: 'pm', provider: 'anthropic', model: 'made-up' })).status, 400);
    assert.equal((await t.post('/api/agents/model', { agent: 'pm; rm', provider: 'anthropic', model: 'claude-sonnet-5-5' })).status, 400);
    assert.equal((await t.post('/api/agents/model', { agent: 'personal', provider: 'anthropic', model: 'claude-sonnet-5-5' })).status, 422); // cloud model refused for the privacy agent
    assert.equal((await t.post('/api/agents/model', { agent: 'personal', provider: 'custom:local-ai', model: 'coding' })).status, 200);
  } finally { t.close(); }
});

test('chat: a private message is answered locally and never forwarded to Atlas; an ordinary one still goes to Atlas', async () => {
  let upstreamCalls = 0;
  const t = await cockpit({ chat: { apiUrl: 'http://127.0.0.1:1', apiKey: 'key', fetch: (async () => { upstreamCalls++; throw new Error('should not be called for a private message'); }) as any }, privacyAsk: async (text: string) => { assert.match(text, /TFN/); return { answer: 'Your refund looks normal.', masked: 1 }; } } as any);
  try {
    const priv = await t.post('/api/chat', { message: 'My TFN is 123 456 789, is my refund normal?', sessionId: 'cockpit-test-abcdef12' });
    const body = await priv.text();
    assert.match(body, /Personal Privacy/);
    assert.match(body, /Your refund looks normal\./);
    assert.match(body, /not sent to a cloud model/);
    assert.ok(!body.includes('123 456 789'));
    assert.equal(upstreamCalls, 0);
    await (await t.post('/api/chat', { message: 'What is the status of the Changes project?', sessionId: 'cockpit-test-abcdef12' })).text();
    assert.equal(upstreamCalls, 1); // ordinary messages still reach Atlas
  } finally { t.close(); }
});

test('growth API: reads through the growth CLI; the few edits map to fixed commands and bad ids are refused', async () => {
  const seen: string[][] = [];
  const t = await cockpit({ growthRun: (argv: string[]) => { seen.push(argv); return { code: 0, output: argv[0] === 'show' ? '{"agent":"coding","about":[],"lessons":[]}' : 'ok' }; } } as any);
  try {
    assert.equal((await (await fetch(t.base + '/api/agents/coding/growth')).json()).agent, 'coding');
    assert.deepEqual(seen.at(-1), ['show', 'coding']);
    assert.equal((await t.post('/api/growth/act', { agent: 'coding', action: 'about-correct', id: 'a-1b2c3d', text: 'Prefers one commit per task' })).status, 200);
    assert.deepEqual(seen.find((a) => a[1] === 'correct'), ['about', 'correct', 'a-1b2c3d', '--text', 'Prefers one commit per task', '--apply']);
    assert.equal((await t.post('/api/growth/act', { agent: '*', action: 'about-add', text: 'Never deploy on Fridays', kind: 'constraint' })).status, 200);
    assert.deepEqual(seen.find((a) => a[1] === 'add'), ['about', 'add', '*', '--text', 'Never deploy on Fridays', '--kind', 'constraint', '--source', 'user-said', '--ref', 'cockpit', '--apply']);
    assert.equal((await t.post('/api/growth/act', { agent: 'coding', action: 'lesson-retire', id: 'l-20261104-run-the-build', reason: 'obsolete' })).status, 200);
    for (const bad of [{ agent: 'coding', action: 'about-retract', id: 'a-zzzz' }, { agent: 'coding', action: 'lesson-retire', id: '../../x' }, { agent: 'cod ing', action: 'about-add', text: 'x' }, { agent: 'coding', action: 'rm' }, { agent: 'coding', action: 'about-add', text: '' }]) {
      assert.equal((await t.post('/api/growth/act', bad)).status, 400, JSON.stringify(bad));
    }
  } finally { t.close(); }
});

test('open folder: only a folder the project lists can be opened; nothing from the request becomes a path', async () => {
  const opened: string[] = [];
  const t = await cockpit({
    work: (argv: string[]) => argv[0] === 'projects' ? { code: 0, output: JSON.stringify(argv[2] !== 'p1' ? [] : [{ id: 'p1', folders: [{ name: 'APA7Review', path: '/code/APA7Review' }, { name: 'docs', path: '/code/APA7Review/docs' }] }]) } : { code: 0, output: '' },
    openPath: (p: string) => { opened.push(p); },
  });
  try {
    assert.equal((await t.post('/api/projects/open', { project: 'p1', folder: 'docs' })).status, 200);
    assert.deepEqual(opened, ['/code/APA7Review/docs']);
    for (const bad of [{ project: 'p1', folder: '../etc' }, { project: 'p1', folder: '/etc' }, { project: 'p1', folder: 'ios' }, { project: 'nope', folder: 'docs' }]) assert.equal((await t.post('/api/projects/open', bad)).status, 404, JSON.stringify(bad));
    assert.deepEqual(opened, ['/code/APA7Review/docs']);
  } finally { t.close(); }
});

test('edit agent text files: fixed files only, backup kept, stale or masked or oversized text refused, memory capped by Hermes limit', async () => {
  const { home, registryPath } = await profile();
  const d0 = agentDetail({ home, registryPath, id: 'content' })!;
  const base = { home, registryPath, id: 'content', now: () => new Date('2026-11-07T10:20:30Z') };
  // a clean file (USER.md has nothing sensitive): saved, the old one kept next to it
  const d1 = saveAgentDoc({ ...base, file: 'user', text: 'Likes Melbourne and short posts.', base: d0.memory.user.sha });
  assert.equal(d1.memory.user.text.trim(), 'Likes Melbourne and short posts.');
  assert.equal(readFileSync(join(home, 'profiles', 'content', 'memories', 'USER.md'), 'utf8'), 'Likes Melbourne and short posts.\n');
  assert.ok(readdirSync(join(home, 'profiles', 'content', 'memories')).some((f) => f === 'USER.md.bak-20261107T102030'));
  // stale base: someone else changed it meanwhile
  assert.throws(() => saveAgentDoc({ ...base, file: 'user', text: 'x', base: d0.memory.user.sha }), (e: unknown) => e instanceof DocError && e.status === 409 && /changed since/.test(e.message));
  // masked placeholder: refused so real values are not overwritten
  assert.throws(() => saveAgentDoc({ ...base, file: 'memory', text: 'key [MASKED:secret]', base: d0.memory.memory.sha }), (e: unknown) => e instanceof DocError && /masked/.test(e.message));
  // Hermes caps memory (3000 here), user (1000)
  assert.throws(() => saveAgentDoc({ ...base, file: 'user', text: 'a'.repeat(1001), base: d1.memory.user.sha }), (e: unknown) => e instanceof DocError && e.status === 413);
  // only the three fixed files; unknown agent
  assert.throws(() => saveAgentDoc({ ...base, file: '../../etc/passwd', text: 'x', base: null }), /unknown file/);
  assert.throws(() => saveAgentDoc({ ...base, id: 'ghost', file: 'soul', text: 'x', base: null }), /no such agent/);
  // SOUL.md can be edited too (no cap)
  const d2 = saveAgentDoc({ ...base, file: 'soul', text: '# New identity\nBe brief.', base: d0.prompt.sha });
  assert.match(d2.prompt.text, /New identity/);
});

test('config/cockpit.json links the Utility Portal; the sidebar renders it as one new-tab item', async () => {
  const { loadLayout } = await import('../src/config.ts');
  const layout = loadLayout(join(import.meta.dirname, '../../../config/cockpit.json'));
  assert.deepEqual(layout.links, [{ name: 'Utility Portal', url: 'http://{host}:8888' }]);
  const html = readFileSync(join(import.meta.dirname, '../public/index.html'), 'utf8');
  assert.match(html, /r\.ui\.links[\s\S]{0,200}target="_blank" rel="noopener"/);
});

test('POST /api/feedback is guarded, appends to the store, refuses private text and dedupes', async () => {
  const { addFeedback } = await import('../../../packages/work/feedback.ts');
  const dir = await mkdtemp(join(tmpdir(), 'fbapp-'));
  const t = await cockpit({ addFeedback: (i) => addFeedback(i, { dir }) });
  try {
    const bad = await fetch(t.base + '/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"text":"hello there"}' });
    assert.equal(bad.status, 403);
    const ok = await t.post('/api/feedback', { text: 'Blocked tasks are hidden', page: '#/p/x', source: 'telegram' });
    assert.equal(ok.status, 201);
    const j = await ok.json(); assert.match(j.id, /^fb-\d{8}-[0-9a-f]{6}$/);
    const rec = JSON.parse(readFileSync(join(dir, 'feedback.jsonl'), 'utf8').trim());
    assert.deepEqual([rec.id, rec.text, rec.source, rec.page, rec.status], [j.id, 'Blocked tasks are hidden', 'cockpit', '#/p/x', 'open']); // source is stamped by the server
    assert.ok(rec.time);
    assert.equal((await t.post('/api/feedback', { text: 'Blocked tasks are hidden', page: '#/p/x' })).status, 200); // duplicate
    assert.equal((await t.post('/api/feedback', { text: 'ab' })).status, 400);
    assert.equal((await t.post('/api/feedback', { text: 'my tax file number is 123 456 782' })).status, 422);
    assert.equal(readFileSync(join(dir, 'feedback.jsonl'), 'utf8').trim().split('\n').length, 1);
  } finally { t.close(); }
  const t2 = await cockpit();
  try { assert.equal((await t2.post('/api/feedback', { text: 'no store wired' })).status, 501); } finally { t2.close(); }
});

test('GET /api/feedback lists proposals and POST /api/feedback/decide records approve, defer, reject (reason required, limited views refused)', async () => {
  const { addFeedback } = await import('../../../packages/work/feedback.ts');
  const { planDigest, applyDigest } = await import('../../../packages/work/digest.ts');
  const { decide, listProposals } = await import('../../../packages/work/decide.ts');
  const dir = await mkdtemp(join(tmpdir(), 'fbdecide-'));
  const o = { dir, now: () => new Date('2026-11-07T00:00:00Z') };
  addFeedback({ text: 'Blocked tasks list is hidden on mobile', by: 'Frank' }, o);
  addFeedback({ text: 'Blocked tasks list hidden on mobile screens', by: 'Diane' }, o);
  addFeedback({ text: 'Urgent: the sidebar needs a feedback item', by: 'Frank' }, o);
  addFeedback({ text: 'Charts overflow on the usage page', by: 'Frank' }, { ...o, now: () => new Date('2026-10-01T00:00:00Z') });
  applyDigest(planDigest(o), o);
  const pending = listProposals(o).length;
  assert.ok(pending >= 3);
  const wired = { feedbackProposals: () => listProposals(o), decideProposal: (i: any) => decide(i, o) };
  const t = await cockpit(wired);
  try {
    const got = await (await fetch(t.base + '/api/feedback')).json();
    assert.equal(got.proposals.length, pending);
    assert.ok(got.proposals[0].evidence.length >= 1);
    const [a, b, c] = got.proposals;
    assert.equal((await t.post('/api/feedback/decide', { id: b.id, action: 'defer' })).status, 400);       // reason needed
    assert.equal((await t.post('/api/feedback/decide', { id: b.id, action: 'reject', reason: '' })).status, 400);
    assert.equal((await t.post('/api/feedback/decide', { id: a.id, action: 'approve' })).status, 200);
    assert.equal((await t.post('/api/feedback/decide', { id: b.id, action: 'defer', reason: 'later' })).status, 200);
    assert.equal((await t.post('/api/feedback/decide', { id: c.id, action: 'reject', reason: 'not needed' })).status, 200);
    assert.equal((await t.post('/api/feedback/decide', { id: c.id, action: 'approve' })).status, 409);       // already decided
    assert.equal((await t.post('/api/feedback/decide', { id: 'fp-none', action: 'approve' })).status, 404);
    const after = (await (await fetch(t.base + '/api/feedback')).json()).proposals;
    assert.deepEqual(after.slice(-3).map((p: any) => p.status).sort(), ['approved', 'deferred', 'rejected']);
    assert.equal(after.filter((p: any) => p.status === 'pending').length, pending - 3);
  } finally { t.close(); }
  const limited = await cockpit({ ...wired, identify: () => ({ name: 'Zoe', hide: ['micropace'], device: null }) as any });
  try {
    assert.equal((await limited.post('/api/feedback/decide', { id: 'x', action: 'approve' })).status, 403);
    assert.deepEqual((await (await fetch(limited.base + '/api/feedback')).json()).proposals, []);
  } finally { limited.close(); }
});
