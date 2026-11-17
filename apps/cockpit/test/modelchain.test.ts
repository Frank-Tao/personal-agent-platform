import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type AppDeps } from '../src/app.ts';
import { requestedChain, setAgentModel } from '../src/agentsApi.ts';
import { WorkError } from '../src/work.ts';
import { agentsSource, fallbacksOf } from '../src/sources/agents.ts';
import { fileAudit } from '../src/audit.ts';
import { chainProblem, loadRegistry, modelChain } from '../../../packages/roster/roster.ts';

const CATALOG = { choices: [
  { provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', billing: 'plan', private: false, lane: 'claude' },
  { provider: 'openai-codex', model: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', billing: 'plan', private: false, lane: 'codex' },
  { provider: 'opencode-zen', model: 'glm-5.3-flash', label: 'GLM', billing: 'free', private: false, lane: 'opencode-zen', base_url: 'https://opencode.ai/zen/v1' },
  { provider: 'custom:local-ai', model: 'qwen3.8:27b', label: 'Local', billing: 'local', private: true, lane: 'ollama' },
  { provider: 'custom:local-ai', model: 'gemma3:12b', label: 'Local small', billing: 'local', private: true, lane: 'ollama' },
], lanes: [] };

test('Hermes\' live fallback chain is read from a profile config: entries in order, base_url ignored, empty and missing mean none', () => {
  const yaml = `model:\n  default: claude-sonnet-5-5\n  provider: anthropic\nfallback_providers:\n  - provider: opencode-zen\n    model: glm-5.3-flash\n    base_url: https://opencode.ai/zen/v1\n  - model: "gpt-6.1-terra"\n    provider: 'openai-codex'\ntoolsets:\n  - hermes-cli\n`;
  assert.deepEqual(fallbacksOf(yaml), [{ model: 'glm-5.3-flash', provider: 'opencode-zen' }, { model: 'gpt-6.1-terra', provider: 'openai-codex' }]);
  assert.deepEqual(fallbacksOf('fallback_providers: []\ntoolsets:\n  - x\n'), []);
  assert.deepEqual(fallbacksOf('model:\n  default: x\n'), []);
});

test('roster chain: first choice then fallbacks; a chain needs 1 to 3 different models; the roster file keeps the order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-')); const path = join(dir, 'agents.json');
  writeFileSync(path, JSON.stringify({ agents: [{ id: 'pm', model: 'claude-sonnet-5-5', provider: 'anthropic', fallbacks: [{ model: 'gpt-6.1-terra', provider: 'openai-codex' }, { model: 'glm-5.3-flash', provider: 'opencode-zen', base_url: 'https://opencode.ai/zen/v1' }, { model: 'a-fourth', provider: 'x' }, { model: '' }], portfolios: [] }] }));
  const pm = loadRegistry(path).agents[0];
  assert.deepEqual(modelChain(pm).map((m) => m.model), ['claude-sonnet-5-5', 'gpt-6.1-terra', 'glm-5.3-flash'], 'at most three');
  assert.equal(pm.fallbacks?.[1].base_url, 'https://opencode.ai/zen/v1');
  assert.deepEqual(modelChain({}), []);
  const m = (provider: string, model: string) => ({ provider, model });
  assert.equal(chainProblem([m('a', '1'), m('a', '2'), m('b', '3')]), null);
  assert.match(chainProblem([]) ?? '', /at least a first model/);
  assert.match(chainProblem([m('a', '1'), m('a', '2'), m('b', '3'), m('c', '4')]) ?? '', /at most 3/);
  assert.match(chainProblem([m('a', '1'), m('b', '2'), m('a', '1')]) ?? '', /twice/);
  assert.match(chainProblem([m('a', ''), m('b', '2')]) ?? '', /provider and a model/);
  assert.equal(chainProblem([m('a', '1'), m('b', '2')], (x) => (x.provider === 'b' ? 'not b' : null)), 'not b');
});

test('agents in Cockpit show the chain Hermes will try (live), or the roster\'s for an agent without a profile', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hh-'));
  mkdirSync(join(home, 'profiles', 'pm'), { recursive: true });
  writeFileSync(join(home, 'profiles', 'pm', 'config.yaml'), 'model:\n  default: claude-sonnet-5-5\n  provider: anthropic\nfallback_providers:\n  - provider: opencode-zen\n    model: glm-5.3-flash\n    base_url: https://opencode.ai/zen/v1\n  - provider: openai-codex\n    model: gpt-6.1-terra\n');
  mkdirSync(join(home, 'profiles', 'stray'), { recursive: true });
  writeFileSync(join(home, 'profiles', 'stray', 'config.yaml'), 'model:\n  default: qwen3.8:27b\n  provider: custom:local-ai\nfallback_providers: []\n');
  const reg = join(home, 'agents.json');
  writeFileSync(reg, JSON.stringify({ agents: [
    { id: 'pm', profile: 'pm', name: 'PM', role: 'r', managed: true, portfolios: ['micropace'], model: 'claude-sonnet-5-5', provider: 'anthropic', fallbacks: [{ model: 'stale-in-roster', provider: 'x' }] },
    { id: 'new', profile: 'new', name: 'New', role: 'r', managed: true, portfolios: [], model: 'gpt-6.1-terra', provider: 'openai-codex', fallbacks: [{ model: 'glm-5.3-flash', provider: 'opencode-zen' }] },
  ] }));
  const res = await agentsSource({ home, registryPath: reg, portfolios: ['micropace'] })();
  const by = Object.fromEntries((res.agents ?? []).map((a) => [a.id, a]));
  assert.deepEqual(by.pm.chain?.map((c) => c.model), ['claude-sonnet-5-5', 'glm-5.3-flash', 'gpt-6.1-terra'], 'live: what Hermes will do, not a stale roster entry');
  assert.deepEqual(by.new.chain?.map((c) => `${c.provider}/${c.model}`), ['openai-codex/gpt-6.1-terra', 'opencode-zen/glm-5.3-flash'], 'no profile yet: the roster\'s');
  assert.deepEqual(by.stray.chain?.map((c) => c.model), ['qwen3.8:27b']);
});

test('model API: an ordered list of up to three catalog models, none twice; a single model keeps the fallbacks; the Privacy agent only gets local ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mapi-')); const cat = join(dir, 'models.json'); writeFileSync(cat, JSON.stringify(CATALOG));
  const seen: string[][] = [];
  const run = (argv: string[]) => { seen.push(argv); return { code: 0, output: 'ok' }; };
  const m = (provider: string, model: string) => ({ provider, model });
  setAgentModel(run, cat, { agent: 'pm', models: [m('openai-codex', 'gpt-6.1-terra'), m('anthropic', 'claude-sonnet-5-5'), m('opencode-zen', 'glm-5.3-flash')] });
  const argv = seen[0];
  assert.deepEqual([argv[0], argv[1], argv[2]], ['set', 'pm', '--chain']);
  assert.deepEqual(JSON.parse(argv[3]), [m('openai-codex', 'gpt-6.1-terra'), m('anthropic', 'claude-sonnet-5-5'), { ...m('opencode-zen', 'glm-5.3-flash'), base_url: 'https://opencode.ai/zen/v1' }]);
  assert.deepEqual(argv.slice(4), ['--add-lanes', 'codex,claude,opencode-zen', '--apply'], 'the lanes of every choice, in order');
  setAgentModel(run, cat, { agent: 'pm', provider: 'anthropic', model: 'claude-sonnet-5-5' });
  assert.deepEqual(seen[1], ['set', 'pm', '--model', 'claude-sonnet-5-5', '--provider', 'anthropic', '--add-lanes', 'claude', '--apply']);

  const refused = (body: Record<string, unknown>, text: RegExp, status = 400) => assert.throws(() => setAgentModel(run, cat, body), (e: unknown) => e instanceof WorkError && text.test(e.message) && (e as WorkError).status === status);
  const before = seen.length;
  refused({ agent: 'pm', models: [m('anthropic', 'claude-sonnet-5-5'), m('anthropic', 'claude-sonnet-5-5')] }, /twice/, 422);
  refused({ agent: 'pm', models: [m('anthropic', 'claude-sonnet-5-5'), m('openai-codex', 'gpt-6.1-terra'), m('opencode-zen', 'glm-5.3-flash'), m('custom:local-ai', 'gemma3:12b')] }, /at most 3/, 422);
  refused({ agent: 'pm', models: [] }, /at least a first model/, 422);
  refused({ agent: 'pm', models: [m('anthropic', 'not-in-the-catalog')] }, /not in config\/models\.json/);
  refused({ agent: 'pm', models: [m('anthropic', 'claude-sonnet-5-5'), m('openai', 'made-up')] }, /made-up is not in config/);
  refused({ agent: '../x', models: [m('anthropic', 'claude-sonnet-5-5')] }, /bad agent id/);
  refused({ agent: 'personal', models: [m('custom:local-ai', 'qwen3.8:27b'), m('anthropic', 'claude-sonnet-5-5')] }, /only use models that run on this Mac/, 422);
  refused({ agent: 'personal', models: [m('anthropic', 'claude-sonnet-5-5')] }, /run on this Mac/, 422);
  assert.equal(seen.length, before, 'nothing reached the agents command');
  setAgentModel(run, cat, { agent: 'personal', models: [m('custom:local-ai', 'qwen3.8:27b'), m('custom:local-ai', 'gemma3:12b')] });
  assert.equal(seen.length, before + 1);
  assert.deepEqual(requestedChain({ provider: 'a', model: 'b' }), [m('a', 'b')]);
});

test('the audit log records the whole chain, before and after', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maud-')); writeFileSync(join(dir, 'index.html'), '<html>x</html>');
  const cat = join(dir, 'models.json'); writeFileSync(cat, JSON.stringify(CATALOG));
  const log = join(dir, 'audit.jsonl');
  const rollup = { agents: [{ id: 'pm', model: 'claude-sonnet-5-5', provider: 'anthropic', chain: [{ model: 'claude-sonnet-5-5', provider: 'anthropic' }, { model: 'glm-5.3-flash', provider: 'opencode-zen' }] }], needsYou: [], portfolios: [], ui: { groups: [] } };
  const deps = { publicDir: dir, guard: { allowedHosts: [] }, chat: { apiUrl: 'http://127.0.0.1:1', apiKey: 'k' }, tasks: { run: async () => '{}', boardFor: (p: string) => p }, getRollup: async () => rollup, history: () => [], agentDetail: () => null, catalog: () => [], privacyAsk: async () => ({ answer: 'x', masked: 0 }), growthRun: () => ({ code: 0, output: '{}' }), agentsRun: () => ({ code: 0, output: 'ok' }), modelsPath: cat, work: () => ({ code: 0, output: '[]' }), invalidate: () => {}, groupOfBoard: (b: string) => b, audit: fileAudit(log), identify: () => ({ name: 'Diane', hide: ['investments'], device: 'hp-x360' }) } as unknown as AppDeps;
  const srv: Server = createServer((q, r) => void createApp(deps)(q, r));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const r = await fetch(base + '/api/agents/model', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ agent: 'pm', models: [{ provider: 'openai-codex', model: 'gpt-6.1-terra' }, { provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'opencode-zen', model: 'glm-5.3-flash' }] }) });
    assert.equal(r.status, 200);
    const e = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop()!);
    assert.deepEqual([e.who, e.action, e.target, e.ok], ['Diane', 'agents.model', 'pm', true]);
    assert.deepEqual([e.detail.from, e.detail.to], ['anthropic/claude-sonnet-5-5 › opencode-zen/glm-5.3-flash', 'openai-codex/gpt-6.1-terra › anthropic/claude-sonnet-5-5 › opencode-zen/glm-5.3-flash']);
  } finally { srv.close(); }
});
