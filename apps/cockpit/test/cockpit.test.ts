import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { bucketFor, parseLimits, usageSource } from '../src/sources/usage.ts';
import { lanesSource, laneStatus, parseClaudeUsage, type Exec } from '../src/sources/lanes.ts';
import { withSharedLimits } from '../src/rollup.ts';
import { parseModelsConf, parseOpencodeAuth, parseOpencodeStats } from '../src/sources/lanes.ts';
import { agentsSource, finalizeAgents, modelOf } from '../src/sources/agents.ts';
import { teamOf } from '../src/sources/hermesKanban.ts';
import { GROUPS } from '../src/types.ts';
import { hermesKanbanSource, statusFor, type Runner } from '../src/sources/hermesKanban.ts';
import { atlasNeeds, atlasSource, groupForJob } from '../src/sources/atlas.ts';
import { loadLayout } from '../src/config.ts';
import { fileCardsSource } from '../src/sources/fileCards.ts';
import { buildRollup, collect } from '../src/rollup.ts';
import { buildBrief } from '../src/brief.ts';
import { Store } from '../src/store.ts';
import { demoSource } from '../src/sources/demo.ts';

const demoUsage = async () => (await demoSource()).usage!;

/** Fake `hermes` CLI: maps the joined argv to canned JSON; anything else exits non-zero. */
function fakeHermes(routes: Record<string, unknown>): Runner {
  return async (args) => {
    const key = args.join(' ');
    if (!(key in routes)) throw new Error(`exit 1: ${key}`);
    return JSON.stringify(routes[key]);
  };
}

const BOARDS = 'kanban boards list --json';
const tasksOf = (slug: string) => `kanban --board ${slug} list --json`;

test('kanban adapter maps a board to a card with review/blocked/failing needs-you', async () => {
  const src = hermesKanbanSource({
    run: fakeHermes({
      [BOARDS]: [
        { slug: 'default', name: 'Default', total: 0 },
        { slug: 'micropace', name: 'MicroPace Labs', total: 5 },
      ],
      [tasksOf('micropace')]: [
        { id: 't1', title: 'Deploy v1', status: 'review' },
        { id: 't2', title: 'Needs API key', status: 'blocked', assignee: 'coding' },
        { id: 't6', title: 'Unowned idea', status: 'blocked', body: 'details' },
        { id: 't3', title: 'Build', status: 'running', last_failure_error: 'timeout' },
        { id: 't4', title: 'Spec', status: 'todo' },
        { id: 't5', title: 'Pick product', status: 'done' },
      ],
    }),
  });
  const { cards, errors } = await src();
  assert.deepEqual(errors, []);
  assert.deepEqual(cards.map((c) => c.id), ['micropace']); // empty default board skipped
  const c = cards[0];
  assert.equal(c.source, 'hermes');
  assert.equal(c.status, 'alert'); // a failing task outranks review/blocked
  assert.deepEqual(c.unassigned!.map((t) => t.id).sort(), ['t4', 't6']); // handed to the staffing check, not reported as a blocker
  assert.deepEqual(c.tasks, { open: 1, inProgress: 2, blocked: 2, done: 1 });
  assert.deepEqual(c.needsYou.map((n) => n.kind).sort(), ['alert', 'approval', 'blocker']);
  assert.ok(c.needsYou.some((n) => n.title === 'Review: Deploy v1'));
});

test('hermes unavailable degrades to an error, not a throw', async () => {
  const { cards, errors } = await hermesKanbanSource({ run: fakeHermes({}) })();
  assert.equal(cards.length, 0);
  assert.match(errors[0], /cannot list kanban boards/);
});

test('one failing board does not hide the others', async () => {
  const { cards, errors } = await hermesKanbanSource({
    run: fakeHermes({
      [BOARDS]: [{ slug: 'a', name: 'A' }, { slug: 'b', name: 'B' }, { slug: 'old', archived: true }],
      [tasksOf('a')]: [],
    }),
  })();
  assert.deepEqual(cards.map((c) => c.id), ['a']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /board "B"/);
});

test('boards land in the section configured for them, Work otherwise', async () => {
  const { cards } = await hermesKanbanSource({
    groups: { family: 'family' },
    run: fakeHermes({
      [BOARDS]: [{ slug: 'family', name: 'Family' }, { slug: 'side', name: 'Side project' }],
      [tasksOf('family')]: [],
      [tasksOf('side')]: [],
    }),
  })();
  assert.deepEqual(cards.map((c) => [c.id, c.group]), [['family', 'family'], ['side', 'micropace']]);
});

/** A throwaway Hermes home with a gateway state file and cron jobs for two profiles. */
async function fakeHermesHome(gateway: object) {
  const home = await mkdtemp(join(tmpdir(), 'cockpit-hermes-'));
  await writeFile(join(home, 'gateway_state.json'), JSON.stringify(gateway));
  await mkdir(join(home, 'cron'));
  await writeFile(join(home, 'cron', 'jobs.json'), JSON.stringify({ jobs: [
    { name: 'Weekly AI Analysis (KnowledgeBase)', enabled: true, last_status: 'ok', next_run_at: '2026-11-07T09:00:00Z', schedule_display: 'Sat 09:00' },
    { name: 'AIP-C01 resource collector', enabled: true, last_status: 'error', last_error: 'secret detail' },
    { name: 'Nightly memory consolidation', enabled: true, last_status: 'error' },
    { name: 'Old research job', enabled: false, last_status: 'ok' },
  ] }));
  await mkdir(join(home, 'profiles', 'coding', 'cron'), { recursive: true });
  await writeFile(join(home, 'profiles', 'coding', 'cron', 'jobs.json'), JSON.stringify({ jobs: [{ name: 'PR sweep', enabled: true, last_status: 'ok' }] }));
  return home;
}

const RULES = [{ match: 'KnowledgeBase|resource collector|research', group: 'research' as const }];

test('atlas reads gateway, platforms, jobs per profile and running workers', async () => {
  const now = new Date('2026-10-31T10:00:00Z');
  const home = await fakeHermesHome({
    pid: process.pid, gateway_state: 'running', updated_at: '2026-10-31T09:59:30Z', active_agents: 2,
    platforms: { telegram: { state: 'connected' }, discord: { state: 'retrying' } }, served_profiles: ['default', 'coding'],
  });
  const { cards, errors, atlas } = await atlasSource({
    home, now: () => now, layout: { cron: RULES, lanes: ['claude', 'gemini'] },
    hasCommand: async (n) => n === 'claude',
    run: fakeHermes({ [BOARDS]: [{ slug: 'a', counts: { running: 2 } }, { slug: 'b', counts: { running: 1, done: 4 } }] }),
  })();
  assert.deepEqual(errors, []);
  assert.equal(atlas!.gateway.state, 'running');
  assert.equal(atlas!.gateway.ageSeconds, 30);
  assert.equal(atlas!.workersRunning, 3);
  assert.equal(atlas!.status, 'warn'); // healthy gateway, but failing jobs
  assert.deepEqual(atlas!.lanes, [{ name: 'claude', available: true }, { name: 'gemini', available: false }]);
  assert.equal(atlas!.jobs.length, 5);
  assert.ok(atlas!.jobs.some((j) => j.profile === 'coding' && j.name === 'PR sweep'));
  // Only enabled jobs matching a rule become section cards; the paused one stays in the job list.
  assert.deepEqual(cards.map((c) => [c.name, c.group, c.status]).sort(), [
    ['AIP-C01 resource collector', 'research', 'alert'],
    ['Weekly AI Analysis (KnowledgeBase)', 'research', 'ok'],
  ]);
  assert.ok(atlas!.jobs.some((j) => j.name === 'Old research job' && !j.enabled));
  assert.ok(!JSON.stringify({ cards, atlas }).includes('secret detail')); // job error text never leaves Hermes
  // Unsectioned failing job surfaces via Atlas; sectioned one via its card.
  assert.deepEqual(atlasNeeds(atlas!).map((n) => n.title), ['Job failed: Nightly memory consolidation']);
});

test('atlas flags a dead or stale gateway and a disconnected Telegram', async () => {
  const now = new Date('2026-10-31T10:00:00Z');
  const home = await fakeHermesHome({
    pid: 999_999_999, gateway_state: 'running', updated_at: '2026-10-31T09:00:00Z',
    platforms: { telegram: { state: 'disconnected' } },
  });
  const { atlas } = await atlasSource({
    home, now: () => now, layout: { cron: [], lanes: [] }, run: fakeHermes({ [BOARDS]: [] }),
  })();
  assert.equal(atlas!.gateway.state, 'dead');
  assert.equal(atlas!.status, 'alert');
  const titles = atlasNeeds(atlas!).map((n) => n.title);
  assert.ok(titles.includes('Atlas gateway is dead'));
  assert.ok(titles.includes('Telegram is disconnected'));
});

test('atlas without a Hermes home degrades to an error', async () => {
  const { atlas, errors } = await atlasSource({
    home: '/definitely/not/here', layout: { cron: [], lanes: [] }, run: fakeHermes({}),
  })();
  assert.equal(atlas!.gateway.state, 'unknown');
  assert.equal(atlas!.status, 'alert');
  assert.equal(errors.length, 2);
});

/** A Hermes home with a minimal sessions ledger. Titles/prompts are deliberately absent from the query. */
async function fakeLedger(rows: Array<{ ageDays: number; source: string; model?: string; tok: number; cost?: number; profile?: string }>) {
  const home = await mkdtemp(join(tmpdir(), 'cockpit-usage-'));
  const db = new DatabaseSync(join(home, 'state.db'));
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, started_at REAL NOT NULL,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, billing_mode TEXT, actual_cost_usd REAL,
    estimated_cost_usd REAL, profile_name TEXT, last_activity_at REAL, title TEXT)`);
  const ins = db.prepare('INSERT INTO sessions (id, source, model, started_at, input_tokens, output_tokens, billing_mode, estimated_cost_usd, profile_name, title) VALUES (?,?,?,?,?,?,?,?,?,?)');
  rows.forEach((r, i) => ins.run(`s${i}`, r.source, r.model ?? 'gpt-6-luna', Date.now() / 1000 - r.ageDays * 86_400 - 60, r.tok, 0, 'subscription_included', r.cost ?? 0, r.profile ?? 'default', 'SECRET TITLE'));
  db.close();
  return home;
}

test('usage buckets sessions by channel and rolls up today / week / 30 days', async () => {
  const home = await fakeLedger([
    { ageDays: 0, source: 'telegram', tok: 1000 },
    { ageDays: 0, source: 'cron', tok: 4000, cost: 0.5 },
    { ageDays: 2, source: 'cron', tok: 2000 },
    { ageDays: 10, source: 'cli', tok: 500, model: 'qwen3.8:27b' },
    { ageDays: 25, source: 'telegram', tok: 9000 }, // inside 30 days, outside the 14-day chart
  ]);
  const { usage, errors } = await usageSource({ home, run: fakeHermes({}) })();
  assert.deepEqual(errors, []);
  assert.equal(usage!.days.length, 14);
  assert.deepEqual([usage!.today.tokens, usage!.today.sessions], [5000, 2]);
  assert.equal(usage!.today.costUsd, 0.5);
  assert.equal(usage!.week.tokens, 7000);
  assert.equal(usage!.month.tokens, 16_500);
  const last = usage!.days.at(-1)!;
  assert.deepEqual([last.chat, last.jobs, last.other], [1000, 4000, 0]);
  assert.equal(usage!.days.reduce((n, d) => n + d.other, 0), 500);
  assert.equal(usage!.byModel[0].model, 'gpt-6-luna');
  assert.equal(usage!.recent[0].source === 'telegram' || usage!.recent[0].source === 'cron', true);
  assert.ok(!JSON.stringify(usage).includes('SECRET TITLE')); // conversation titles are never read
});

test('usage degrades to an error when the ledger is missing, and keeps provider limits', async () => {
  const limitsJson = JSON.stringify({ provider: 'openai-codex', plan: 'Plus', windows: [{ label: 'Weekly', used_percent: 100, resets_at: '2026-11-04T07:01:19+00:00' }] });
  const { usage, errors } = await usageSource({ home: '/definitely/not/here', run: fakeHermes({ 'usage --json': JSON.parse(limitsJson) }) })();
  assert.match(errors[0], /cannot read Hermes sessions/);
  assert.equal(usage!.today.tokens, 0);
  assert.equal(usage!.limits[0].windows[0].usedPercent, 100);
  assert.deepEqual(parseLimits('[]'), []);
  assert.equal(bucketFor('whatsapp'), 'chat');
  assert.equal(bucketFor('cron'), 'jobs');
  assert.equal(bucketFor('oneshot'), 'other');
});

test('a provider limit at 100% turns Atlas red with a reason and a Needs-you item; 90% only warns', async () => {
  const home = await fakeHermesHome({
    pid: process.pid, gateway_state: 'running', updated_at: new Date().toISOString(),
    platforms: { telegram: { state: 'connected' }, 'diane:telegram': { state: 'retrying' }, discord: { state: 'retrying' } },
  });
  const atlasRes = await atlasSource({
    home, layout: { cron: [], lanes: [], channels: ['telegram', 'diane:telegram'] }, run: fakeHermes({ [BOARDS]: [] }),
  })();
  assert.deepEqual(atlasRes.atlas!.platforms.map((p) => p.name), ['telegram', 'diane:telegram']); // discord hidden
  const lim = (pct: number) => [{ provider: 'openai-codex', plan: 'Plus', windows: [{ label: 'Weekly', usedPercent: pct, resetsAt: '2026-11-04T07:00:00Z' }] }];
  const base = await demoUsage();
  const usage = (pct: number) => ({ ...base, limits: lim(pct) });

  const red = buildRollup([], [], atlasRes.atlas, { usage: usage(100), channels: ['telegram', 'diane:telegram'] });
  assert.equal(red.atlas!.status, 'alert');
  assert.ok(red.atlas!.reasons.some((r) => /Codex weekly limit 100% used — resets 2026-11-04/.test(r.text)));
  assert.ok(red.needsYou.some((n) => n.portfolioId === 'atlas' && /Codex weekly limit/.test(n.title)));

  const amber = buildRollup([], [], atlasRes.atlas, { usage: usage(90), channels: ['telegram', 'diane:telegram'] });
  assert.equal(amber.atlas!.status, 'warn');
  assert.ok(!amber.needsYou.some((n) => /limit/.test(n.title)));
  assert.ok(amber.atlas!.reasons.some((r) => /Diane Telegram is retrying/.test(r.text)));
  assert.ok(!amber.atlas!.reasons.some((r) => /discord/i.test(r.text)));
});

test('a restarting gateway only warns, and a configured channel the gateway omits shows as not running', async () => {
  const home = await fakeHermesHome({
    pid: process.pid, gateway_state: 'starting', updated_at: new Date().toISOString(),
    platforms: { telegram: { state: 'connected' } },
  });
  const { atlas } = await atlasSource({
    home, layout: { cron: [], lanes: [], channels: ['telegram', 'coding:telegram'] }, run: fakeHermes({ [BOARDS]: [] }),
  })();
  assert.deepEqual(atlas!.platforms.map((p) => [p.name, p.state]), [['telegram', 'connected'], ['coding:telegram', 'not running']]);
  assert.equal(atlas!.status, 'warn');
  const texts = atlas!.reasons.map((r) => r.text);
  assert.ok(texts.includes('Atlas gateway is starting'));
  assert.ok(texts.includes('Coding Telegram is not running'));
  assert.ok(atlas!.reasons.every((r) => r.severity === 'warn')); // no alert while it restarts
});

test('earnings roll up from manual cards; absent means not connected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-earn-'));
  await writeFile(join(dir, 'a.json'), JSON.stringify({ id: 'a', name: 'A', updatedAt: new Date().toISOString(), earnings: { monthCents: 12_300 } }));
  await writeFile(join(dir, 'b.json'), JSON.stringify({ id: 'b', name: 'B', updatedAt: new Date().toISOString() }));
  const { cards } = await fileCardsSource(dir, 'manual')();
  assert.deepEqual(buildRollup(cards, []).earned, { monthCents: 12_300, sources: 1 });
  assert.deepEqual(buildRollup([], []).earned, { monthCents: 0, sources: 0 });
});

/** Add another profile's own ledger next to the default one, as Hermes lays them out. */
async function addProfileLedger(home: string, profile: string, rows: Array<{ ageDays: number; source: string; tok: number }>) {
  const dir = join(home, 'profiles', profile);
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'state.db'));
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, started_at REAL NOT NULL,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, billing_mode TEXT, actual_cost_usd REAL,
    estimated_cost_usd REAL, profile_name TEXT, last_activity_at REAL, title TEXT)`);
  const ins = db.prepare('INSERT INTO sessions (id, source, model, started_at, input_tokens, output_tokens) VALUES (?,?,?,?,?,0)');
  rows.forEach((r, i) => ins.run(`p${i}`, r.source, 'gpt-6-luna', Date.now() / 1000 - r.ageDays * 86_400 - 60, r.tok));
  db.close();
}

test('usage reads every profile ledger and splits each day by channel and by agent', async () => {
  const home = await fakeLedger([{ ageDays: 0, source: 'telegram', tok: 1000 }, { ageDays: 0, source: 'cron', tok: 500 }]);
  await addProfileLedger(home, 'diane', [{ ageDays: 0, source: 'cron', tok: 7000 }, { ageDays: 0, source: 'api_server', tok: 300 }]);
  await addProfileLedger(home, 'coding', [{ ageDays: 3, source: 'telegram', tok: 40 }]);
  const { usage, errors } = await usageSource({ home, run: fakeHermes({}) })();
  assert.deepEqual(errors, []);
  const today = usage!.days.at(-1)!;
  assert.deepEqual(today.byProfile, { default: 1500, diane: 7300 });
  assert.deepEqual(today.bySource, { telegram: 1000, cron: 7500, api_server: 300 });
  assert.equal(usage!.today.tokens, 8800); // Atlas alone would have said 1500
  assert.equal(usage!.today.sessions, 4);
  const diane = usage!.channels.find((c) => c.profile === 'diane' && c.source === 'cron')!;
  assert.deepEqual([diane.sessions, diane.tokens], [1, 7000]);
  assert.ok(usage!.recent.some((r) => r.profile === 'diane'));
});

test('a broken profile ledger is reported but does not hide the others', async () => {
  const home = await fakeLedger([{ ageDays: 0, source: 'telegram', tok: 10 }]);
  await mkdir(join(home, 'profiles', 'bad'), { recursive: true });
  await writeFile(join(home, 'profiles', 'bad', 'state.db'), 'not a database');
  const { usage, errors } = await usageSource({ home, run: fakeHermes({}) })();
  assert.equal(usage!.today.tokens, 10);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /profile bad/);
});

const CLAUDE_USAGE = `You are currently using your subscription to power your Claude Code usage

Current session: 52% used · resets Oct 31 at 11:29pm (Australia/Melbourne)
Current week (all models): 50% used · resets Nov 1 at 4:59am (Australia/Melbourne)

What's contributing to your usage?`;

test('claude /usage output is parsed into session and weekly limits', () => {
  assert.deepEqual(parseClaudeUsage(CLAUDE_USAGE), [
    { label: 'Session', usedPercent: 52, resets: 'Oct 31 at 11:29pm (Australia/Melbourne)' },
    { label: 'Week (all models)', usedPercent: 50, resets: 'Nov 1 at 4:59am (Australia/Melbourne)' },
  ]);
  assert.deepEqual(parseClaudeUsage('nothing useful'), []);
});

test('lanes: real login + limits per CLI, run ledger, and codex shares the ChatGPT plan limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-lanes-'));
  const ledger = join(dir, 'lanes.jsonl');
  const now = new Date('2026-10-31T10:00:00Z');
  await writeFile(ledger, [
    { lane: 'codex', status: 1, endedAt: '2026-10-31T09:00:00Z', note: "ERROR: You've hit your usage limit" },
    { lane: 'claude', status: 0, endedAt: '2026-10-30T09:00:00Z' },
    { lane: 'claude', status: 0, endedAt: '2026-10-31T08:00:00Z' },
    { lane: 'mystery', status: 1, endedAt: '2026-08-01T00:00:00Z', note: 'too old, outside 7 days' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n');
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'claude' && args[0] === 'auth') return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', email: 'me@example.com' });
    if (cmd === 'claude') return CLAUDE_USAGE;
    if (cmd === 'codex') return 'Logged in using ChatGPT\n';
    throw new Error('unexpected ' + cmd);
  };
  const src = lanesSource({
    lanes: ['claude', 'codex', 'mystery', 'ollama', 'ghost'], ledgerPath: ledger, exec, now: () => now,
    hasCommand: async (n) => n !== 'ghost',
    fetch: (async (u: any) => new Response(JSON.stringify(String(u).endsWith('/api/ps') ? { models: [{ name: 'qwen3.8:27b' }] } : { models: [{}, {}] }))) as typeof fetch,
  });
  const { lanes } = await src();
  const by = Object.fromEntries(lanes!.map((l) => [l.name, l]));
  assert.deepEqual([by.claude.login, by.claude.plan, by.claude.status], ['ok', 'pro', 'ok']);
  assert.equal(by.claude.limits.length, 2);
  assert.deepEqual([by.claude.runs.total, by.claude.runs.failed, by.claude.runs.lastAt], [2, 0, '2026-10-31T08:00:00.000Z']);
  assert.equal(by.codex.login, 'ok');
  assert.equal(by.codex.status, 'alert'); // last real run failed
  assert.match(by.codex.runs.lastNote!, /usage limit/);
  assert.equal(by.mystery.login, 'unknown');
  assert.equal(by.mystery.runs.total, 0); // the August failure is outside the 7-day window
  assert.equal(by.mystery.status, 'unknown');
  assert.match(by.ollama.detail, /2 models installed/);
  assert.deepEqual(by.ollama.modelsNow, ['qwen3.8:27b']); // the model in memory right now
  assert.deepEqual([by.ghost.installed, by.ghost.status], [false, 'alert']);
  assert.ok(!JSON.stringify(lanes).includes('me@example.com')); // account email is never surfaced
  const before = calls.length;
  await src(); // second refresh inside 5 minutes hits the cache, not the CLIs
  assert.equal(calls.length, before);

  const shared = withSharedLimits(lanes!, {
    ...(await demoUsage()), limits: [{ provider: 'openai-codex', plan: 'Plus', windows: [{ label: 'Weekly', usedPercent: 100, resetsAt: '2026-11-04T07:00:00Z' }] }],
  });
  const codex = shared.find((l) => l.name === 'codex')!;
  assert.deepEqual([codex.plan, codex.limits[0].usedPercent], ['Plus', 100]);
  assert.match(codex.limitsSource!, /same account as the codex CLI/);
  assert.equal(shared.find((l) => l.name === 'claude')!.limits.length, 2); // claude keeps its own limits
});

const OC_AUTH = '\u001b[0m\n┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  OpenRouter \u001b[90mapi\n│\n└  1 credentials\n';
const OC_STATS = `┌──────────┐
│                      MODEL USAGE                       │
├────────────────────────────────────────────────────────┤
│ openrouter/x-ai/grok-4.5                               │
│  Messages                                            2 │
│  Cost                                          $0.0157 │
├────────────────────────────────────────────────────────┤
│ openrouter/~deepseek/deepseek-v4-flash-latest          │
│  Messages                                            3 │
│  Cost                                          $0.0100 │
├────────────────────────────────────────────────────────┤
│ opencode/big-pickle                                    │
│  Messages                                            1 │
│  Cost                                          $0.0000 │
└────────────────────────────────────────────────────────┘`;

test('opencode auth/stats/models.conf parsers', () => {
  assert.deepEqual(parseOpencodeAuth(OC_AUTH), [{ name: 'OpenRouter', type: 'api' }]);
  const st = parseOpencodeStats(OC_STATS);
  assert.deepEqual(st.openrouter, { costUsd: 0.0257, messages: 5 }); // two models of one provider add up
  assert.deepEqual(st.opencode, { costUsd: 0, messages: 1 });
  assert.deepEqual(parseOpencodeStats('nothing'), {});
  assert.deepEqual(parseModelsConf('# c\nLANE_MODEL_OPENAI=openai/gpt-5.5\nLANE_MODEL_CLAUDE=\n'), { LANE_MODEL_OPENAI: 'openai/gpt-5.5', LANE_MODEL_CLAUDE: '' });
});

test('API lanes run through opencode: key present = ok with spend, absent = not set up (grey, not red)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-api-lanes-'));
  await writeFile(join(dir, 'models.conf'), 'LANE_MODEL_OPENROUTER=openrouter/~deepseek/deepseek-v4-flash-latest\nLANE_MODEL_OPENAI=openai/gpt-5.5\nLANE_MODEL_OPENCODE_ZEN=opencode/big-pickle\n');
  await writeFile(join(dir, 'lanes.jsonl'), JSON.stringify({ lane: 'openrouter', model: 'openrouter/~deepseek/deepseek-v4-flash-latest', status: 0, endedAt: new Date().toISOString() }) + '\n');
  const exec: Exec = async (cmd, args) => {
    assert.equal(cmd, 'opencode'); // every API lane goes through the one CLI
    const a = args.join(' ');
    if (a === 'auth list') return OC_AUTH;
    if (a === 'stats --days 30 --models') return OC_STATS;
    if (a === 'models openrouter') return 'openrouter/a\nopenrouter/b\nopenrouter/c\n';
    if (a === 'models opencode') return 'opencode/big-pickle\nopencode/glm-5.3-flash-free\n';
    if (a === 'models openai') throw new Error('Provider not found: openai');
    throw new Error('unexpected ' + a);
  };
  const { lanes } = await lanesSource({ lanes: ['opencode-zen', 'openrouter', 'openai'], ledgerPath: join(dir, 'lanes.jsonl'), modelsPath: join(dir, 'models.conf'), exec, hasCommand: async () => true })();
  const by = Object.fromEntries(lanes!.map((l) => [l.name, l]));
  assert.deepEqual([by.openrouter.kind, by.openrouter.login, by.openrouter.status, by.openrouter.model], ['api', 'ok', 'ok', 'openrouter/~deepseek/deepseek-v4-flash-latest']);
  assert.deepEqual(by.openrouter.spend, { costUsd: 0.0257, messages: 5 });
  assert.equal(by.openrouter.lastModel, 'openrouter/~deepseek/deepseek-v4-flash-latest');
  assert.deepEqual([by['opencode-zen'].login, by['opencode-zen'].plan, by['opencode-zen'].status], ['ok', 'free models', 'ok']); // free models need no key
  assert.deepEqual([by.openai.login, by.openai.status], ['none', 'unknown']);
  assert.match(by.openai.detail, /opencode auth login.*OpenAI/);
  assert.equal(by.openai.model, 'openai/gpt-5.5');
});

test('without the opencode CLI the API lanes are red, not silently green', async () => {
  const { lanes } = await lanesSource({ lanes: ['openrouter'], ledgerPath: '/nope', hasCommand: async () => false, exec: async () => '' })();
  assert.deepEqual([lanes![0].installed, lanes![0].status], [false, 'alert']);
  assert.match(lanes![0].detail, /opencode is not installed/);
});

test('laneStatus: login/limits/failed runs decide red, amber, grey, green', () => {
  const ok = { installed: true, login: 'ok' as const, limits: [], runs: { total: 3, failed: 0, lastAt: null, lastStatus: 'ok' as const, lastNote: null } };
  assert.equal(laneStatus(ok), 'ok');
  assert.equal(laneStatus({ ...ok, login: 'no' }), 'alert');
  assert.equal(laneStatus({ ...ok, limits: [{ label: 'Week', usedPercent: 90, resets: null }] }), 'warn');
  assert.equal(laneStatus({ ...ok, limits: [{ label: 'Week', usedPercent: 100, resets: null }] }), 'alert');
  assert.equal(laneStatus({ ...ok, runs: { ...ok.runs, failed: 1 } }), 'warn');
  assert.equal(laneStatus({ ...ok, login: 'unknown', runs: { ...ok.runs, total: 0 } }), 'unknown');
});

test('layout loader drops unknown groups and tolerates a missing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-layout-'));
  const path = join(dir, 'cockpit.json');
  await writeFile(path, JSON.stringify({ boards: { a: 'family', b: 'nope' }, cron: [{ match: 'x', group: 'bogus' }] }));
  const l = loadLayout(path);
  assert.deepEqual(l.boards, { a: 'family' });
  assert.deepEqual(l.cron, []);
  assert.deepEqual(loadLayout(join(dir, 'missing.json')).lanes, ['claude', 'codex', 'opencode-zen', 'openrouter', 'openai', 'ollama']);
  assert.equal(groupForJob('Weekly AI Analysis (KnowledgeBase)', RULES), 'research');
  assert.equal(groupForJob('Nightly memory consolidation', RULES), undefined);
});

test('statusFor thresholds', () => {
  assert.equal(statusFor({}, 0), 'ok');
  assert.equal(statusFor({ review: 1 }, 0), 'warn');
  assert.equal(statusFor({ blocked: 2 }, 0), 'warn');
  assert.equal(statusFor({}, 1), 'alert');
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
  assert.equal(cards[0].group, 'family'); // private summaries always land in Family
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
  assert.equal(r.portfolios.length, 7);
  assert.equal(r.spend.spentCents, 6400 + 2100 + 900);
  assert.equal(r.spend.budgetCents, 15000 + 8000 + 5000);
  assert.equal(r.needsYou[0].severity, 'alert');
  assert.equal(r.runs.length, 14);
});

test('collect survives a throwing source', async () => {
  const { cards, errors } = await collect([demoSource, async () => { throw new Error('boom'); }]);
  assert.equal(cards.length, 7);
  assert.match(errors[0], /boom/);
});

test('brief lists needs-you and portfolios', async () => {
  const { cards, errors, atlas, usage } = await collect([demoSource]);
  const md = buildBrief(buildRollup(cards, errors, atlas, { usage }));
  assert.match(md, /Atlas brief/);
  assert.match(md, /\*\*Atlas\*\* — gateway running · 1 worker\(s\) running · 4 jobs, 1 failing/);
  assert.match(md, /Tokens: .* today · .* this week/);
  assert.match(md, /Codex weekly limit 100% used/);
  assert.match(md, /Earned this month:\*\* \$2,460/);
  assert.match(md, /Needs you \(/);
  assert.match(md, /\*\*Research\*\*\n.*AIP-C01/);
  assert.match(md, /\*\*Family\*\*/);
  assert.match(md, /\*\*MicroPace Labs\*\*/);
  assert.match(md, /Spend this month/);
});

test('store round-trips latest and daily history', async () => {
  const store = new Store(':memory:');
  assert.equal(store.latest(), undefined);
  const { cards, errors } = await collect([demoSource]);
  const r = buildRollup(cards, errors);
  store.save(r);
  assert.equal(store.latest()?.portfolios.length, 7);
  assert.equal(store.history(7).length, 1);
  store.close();
});

/* ---------- roster / agents ---------- */

async function fakeRoster() {
  const home = await mkdtemp(join(tmpdir(), 'cockpit-roster-'));
  await mkdir(join(home, 'profiles', 'coding'), { recursive: true });
  await mkdir(join(home, 'profiles', 'diane'), { recursive: true });
  await writeFile(join(home, 'config.yaml'), 'model:\n  default: gpt-6-luna\n  provider: openai-codex\nfallback_providers: []\n');
  await writeFile(join(home, 'profiles', 'coding', 'config.yaml'), 'model:\n  default: "claude-x"\n  provider: anthropic\nother:\n  default: nope\n');
  const registryPath = join(home, 'agents.json');
  await writeFile(registryPath, JSON.stringify({ agents: [
    { id: 'atlas', profile: 'default', name: 'Atlas', role: 'chief', managed: false, portfolios: ['*'] },
    { id: 'coding', profile: 'coding', name: 'Coding', role: 'engineer', managed: false, lanes: ['claude'], portfolios: ['micropace', 'ai-thrival'] },
    { id: 'content', profile: 'content', name: 'Content', role: 'writer', persona: { slug: 'marketing/x', name: 'Content Creator', emoji: '✍️', division: 'marketing', sha256: 'a', commit: 'b' }, portfolios: ['ai-thrival'] },
  ] }));
  return { home, registryPath };
}

test('model block of config.yaml is read without a YAML library', () => {
  assert.deepEqual(modelOf('model:\n  default: gpt-6-luna\n  provider: openai-codex\nx:\n  default: no\n'), { model: 'gpt-6-luna', provider: 'openai-codex' });
  assert.deepEqual(modelOf('nothing: here\n'), { model: null, provider: null });
});

test('agents: roster entries are checked against real Hermes profiles; unknown profiles are listed unlinked', async () => {
  const { home, registryPath } = await fakeRoster();
  const { agents } = await agentsSource({ home, registryPath, portfolios: GROUPS.map((g) => g.id) })();
  const by = Object.fromEntries(agents!.map((a) => [a.id, a]));
  assert.deepEqual([by.atlas.state, by.atlas.model, by.atlas.allPortfolios], ['active', 'gpt-6-luna', true]);
  assert.equal(by.atlas.portfolios.length, GROUPS.length); // '*' expands to every portfolio
  assert.deepEqual([by.coding.state, by.coding.model, by.coding.provider], ['active', 'claude-x', 'anthropic']);
  assert.deepEqual([by.content.state, by.content.emoji, by.content.model], ['proposed', '✍️', null]); // not created in Hermes yet
  assert.deepEqual([by.diane.state, by.diane.portfolios], ['unlisted', []]);
});

test('agents: usage per profile and task counts per portfolio come from the ledgers and kanban boards', async () => {
  const { home, registryPath } = await fakeRoster();
  const { agents } = await agentsSource({ home, registryPath, portfolios: GROUPS.map((g) => g.id) })();
  const usage = { ...(await demoUsage()), channels: [
    { profile: 'coding', source: 'telegram', sessions: 2, tokens: 500, lastAt: '2026-10-30T00:00:00.000Z' },
    { profile: 'coding', source: 'oneshot', sessions: 1, tokens: 100, lastAt: '2026-10-31T00:00:00.000Z' },
  ] };
  const card = (group: any, team: any) => ({ id: group, name: group, group, source: 'hermes', status: 'ok', headline: '', metrics: [], needsYou: [], updatedAt: '', team }) as any;
  const done = finalizeAgents(agents!, usage, [
    card('micropace', [{ assignee: 'coding', running: 1, ready: 2, review: 0, blocked: 1, done: 4 }, { assignee: 'qa', running: 9, ready: 0, review: 0, blocked: 0, done: 0 }]),
    card('ai-thrival', [{ assignee: 'coding', running: 0, ready: 1, review: 2, blocked: 0, done: 1 }]),
  ]);
  const coding = done.find((a) => a.id === 'coding')!;
  assert.deepEqual([coding.tokens7d, coding.sessions7d, coding.lastAt], [600, 3, '2026-10-31T00:00:00.000Z']);
  assert.deepEqual(coding.tasks, { running: 1, ready: 3, review: 2, blocked: 1, done: 5 }); // one agent, two portfolios, summed
  assert.deepEqual(Object.keys(coding.byPortfolio).sort(), ['ai-thrival', 'micropace']);
  assert.equal(coding.byPortfolio['ai-thrival'].review, 2);
  assert.equal(coding.status, 'warn'); // a blocked task needs a human
  assert.equal(done.find((a) => a.id === 'content')!.status, 'unknown'); // proposed
});

test('kanban teamOf counts tasks per assignee', () => {
  const t = teamOf([
    { id: '1', status: 'running', assignee: 'coding' }, { id: '2', status: 'todo', assignee: 'coding' }, { id: '3', status: 'review', assignee: 'qa' },
    { id: '4', status: 'done', assignee: 'coding' }, { id: '5', status: 'archived', assignee: 'qa' }, { id: '6', status: 'ready', assignee: null },
  ] as any);
  assert.deepEqual(t.map((x) => [x.assignee, x.running, x.ready, x.review, x.done]), [['coding', 1, 1, 0, 1], ['qa', 0, 0, 1, 0], ['unassigned', 0, 1, 0, 0]]);
});

test('work source: proposed charters, watchdog-paused projects and held outbox items become Needs-you; nothing else does', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { serializeProject, emptyCharter } = await import('../../../packages/work/model.ts');
  const { workSource } = await import('../src/sources/work.ts');
  const kb = await mkdtemp(join(tmpdir(), 'kb-'));
  const mk = async (id: string, status: 'proposed' | 'active' | 'paused', reason: string | null) => {
    await mkdir(join(kb, 'micropace', 'projects'), { recursive: true });
    const p = { id, portfolio: 'micropace', objective: null, key_results: [], status, owner: 'pm', tenant: id, timebox: '7d', created: '2026-11-01', approved: null, repo: null, plan_sha: null, paused_reason: reason, charter: emptyCharter({ outcome: `outcome of ${id}` } as never) };
    await writeFile(join(kb, 'micropace', 'projects', `${id}.md`), serializeProject(p, '\nbody\n'));
  };
  await mk('a-new', 'proposed', null);
  await mk('b-paused', 'paused', 'over-scope: 11 tasks');
  await mk('c-fine', 'active', null);
  await mkdir(join(kb, 'micropace', 'outbox', 'c-fine'), { recursive: true });
  await writeFile(join(kb, 'micropace', 'outbox', 'c-fine', 'x.json'), JSON.stringify({ id: 'x', kind: 'publish', target: 'blog', summary: 'post', reason: 'draft-only', status: 'held' }));
  await writeFile(join(kb, 'micropace', 'outbox', 'c-fine', 'y.json'), JSON.stringify({ id: 'y', kind: 'deploy', target: 'h', summary: 's', reason: '', status: 'done' }));
  const r = await workSource({ kb, portfolios: ['micropace', 'family'] })();
  const titles = (r.needs ?? []).map((n) => n.title);
  assert.equal(titles.length, 3);
  assert.ok(titles.some((t) => /Approve project charter: a-new/.test(t)));
  assert.ok(titles.some((t) => /paused by the watchdog: b-paused — over-scope/.test(t)));
  assert.ok(titles.some((t) => /Release publish to blog\? post/.test(t)));
});

test('usage by portfolio and project: a session that starts inside a kanban run of the same profile belongs to that run\'s project; the rest is "no project"', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtemp, mkdir } = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'hh-'));
  const now = Math.floor(Date.now() / 1000);
  const sdb = (path: string, rows: Array<[string, number, number]>) => {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE sessions (id TEXT, source TEXT, model TEXT, billing_mode TEXT, started_at REAL, last_activity_at REAL, input_tokens INT, output_tokens INT, actual_cost_usd REAL, estimated_cost_usd REAL, title TEXT)');
    for (const [id, at, tok] of rows) db.prepare('INSERT INTO sessions (id, source, model, started_at, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, 0)').run(id, 'cron', 'm', at, tok);
    db.close();
  };
  sdb(join(home, 'state.db'), [['chat1', now - 5000, 1000]]); // Atlas chat, no run
  await mkdir(join(home, 'profiles', 'coding'), { recursive: true });
  sdb(join(home, 'profiles', 'coding', 'state.db'), [['w1', now - 3590, 4000], ['w2', now - 3000, 6000], ['w3', now - 100, 500]]);
  await mkdir(join(home, 'kanban', 'boards', 'micropace-labs'), { recursive: true });
  const kdb = new DatabaseSync(join(home, 'kanban', 'boards', 'micropace-labs', 'kanban.db'));
  kdb.exec('CREATE TABLE tasks (id TEXT, tenant TEXT); CREATE TABLE task_runs (id INTEGER PRIMARY KEY, task_id TEXT, profile TEXT, started_at INT, ended_at INT)');
  kdb.prepare('INSERT INTO tasks VALUES (?, ?)').run('t1', 'datahub-phase1');
  kdb.prepare('INSERT INTO task_runs (task_id, profile, started_at, ended_at) VALUES (?, ?, ?, ?)').run('t1', 'coding', now - 3600, now - 2900);
  kdb.close();
  const { usage } = await usageSource({ home, run: fakeHermes({}), boardsDir: join(home, 'kanban', 'boards'), boardGroups: { 'micropace-labs': 'micropace' } })();
  const proj = Object.fromEntries(usage!.byProject.map((x) => [x.id, x.tokens]));
  assert.deepEqual(proj, { 'datahub-phase1': 10_000, _none: 1_500 });
  const port = Object.fromEntries(usage!.byPortfolio.map((x) => [x.id, x.tokens]));
  assert.deepEqual(port, { micropace: 10_000, _none: 1_500 });
  assert.equal(usage!.byProject.at(-1)!.id, '_none'); // "no project" always last
  assert.equal(usage!.days.at(-1)!.byProject['datahub-phase1'] + 0 > 0 || usage!.days.some((d) => d.byProject['datahub-phase1'] > 0), true);
});
