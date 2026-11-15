import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type AppDeps } from '../src/app.ts';
import { getSession, listSessions, stateDbs } from '../src/sources/sessions.ts';

function hermes() {
  const home = mkdtempSync(join(tmpdir(), 'hermes-'));
  const make = (path: string, profile: string, sessions: Array<{ id: string; source: string; model: string; title: string; at: number; msgs: Array<[string, string, string?]> }>) => {
    mkdirSync(join(path, '..'), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, started_at REAL, ended_at REAL, message_count INTEGER, tool_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, actual_cost_usd REAL, estimated_cost_usd REAL, hidden INTEGER DEFAULT 0, profile_name TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, tool_calls TEXT, timestamp REAL, reasoning TEXT);
      CREATE VIRTUAL TABLE messages_fts USING fts5(content);`);
    for (const s of sessions) {
      db.prepare('INSERT INTO sessions (id, source, model, title, started_at, message_count, tool_call_count, input_tokens, output_tokens, estimated_cost_usd, profile_name) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(s.id, s.source, s.model, s.title, s.at, s.msgs.length, 1, 100, 50, 0.01, profile);
      s.msgs.forEach(([role, content, extra], i) => {
        const r = db.prepare('INSERT INTO messages (session_id, role, content, tool_name, tool_calls, timestamp, reasoning) VALUES (?,?,?,?,?,?,?)').run(s.id, role, content, role === 'tool' ? 'terminal' : null, role === 'assistant' && extra ? extra : null, s.at + i, 'PRIVATE CHAIN OF THOUGHT');
        db.prepare('INSERT INTO messages_fts (rowid, content) VALUES (?, ?)').run(Number(r.lastInsertRowid), content);
      });
    }
    db.close();
  };
  make(join(home, 'state.db'), 'default', [
    { id: 'cockpit-aaaa1111', source: 'api_server', model: 'gpt-6.1-terra', title: 'Plan the notice calendar', at: 1794000000, msgs: [['user', 'Should we use SwiftUI for the player?'], ['assistant', 'Yes: SwiftUI is faster to ship. api_key = sk-abcdefghijklmnopqrstuvwx', JSON.stringify([{ function: { name: 'terminal' } }])], ['tool', '{"output": "' + 'x'.repeat(2000) + '"}']] },
    { id: 'cron-bbbb2222', source: 'cron', model: 'hy3-free', title: 'Morning brief', at: 1794100000, msgs: [['user', 'brief please'], ['assistant', 'All quiet.']] },
  ]);
  make(join(home, 'profiles', 'coding', 'state.db'), 'coding', [{ id: 'task-cccc3333', source: 'cli', model: 'gpt-6.1-terra', title: 'Fix the login bug', at: 1794050000, msgs: [['user', 'Fix login'], ['assistant', 'Fixed; SwiftUI view updated.']] }]);
  make(join(home, 'profiles', 'personal', 'state.db'), 'personal', [{ id: 'priv-dddd4444', source: 'cli', model: 'qwen', title: 'Tax question', at: 1794060000, msgs: [['user', 'my tax return'], ['assistant', 'private answer']] }]);
  make(join(home, 'profiles', 'diane', 'state.db'), 'diane', [{ id: 'dian-eeee5555', source: 'telegram', model: 'gpt', title: 'Diane chat', at: 1794070000, msgs: [['user', 'hi from Diane']] }]);
  return home;
}

test('conversations: sessions from every profile, newest first, filters and full-text search; the Privacy agent and Diane are never opened', () => {
  const home = hermes();
  assert.deepEqual(stateDbs(home).map((d) => d.profile).sort(), ['atlas', 'coding']);
  const all = listSessions(home);
  assert.deepEqual(all.sessions.map((s) => s.id), ['cron-bbbb2222', 'task-cccc3333', 'cockpit-aaaa1111']);
  assert.equal(all.total, 3);
  assert.deepEqual(all.sessions[1], { ...all.sessions[1], profile: 'coding', model: 'gpt-6.1-terra', title: 'Fix the login bug', messages: 2, tokens: 150, costUsd: 0.01 });
  assert.deepEqual(all.sources, ['api_server', 'cli', 'cron']);
  assert.deepEqual(listSessions(home, { profile: 'coding' }).sessions.map((s) => s.id), ['task-cccc3333']);
  assert.deepEqual(listSessions(home, { source: 'cron' }).sessions.map((s) => s.id), ['cron-bbbb2222']);
  const hits = listSessions(home, { q: 'SwiftUI' });
  assert.deepEqual(hits.sessions.map((s) => s.id).sort(), ['cockpit-aaaa1111', 'task-cccc3333']);
  assert.match(hits.sessions.find((s) => s.id === 'task-cccc3333')!.snippet ?? '', /\[SwiftUI\]/);
  assert.equal(listSessions(home, { q: '"; DROP TABLE sessions; --' }).total, 0, 'search text is never read as syntax');
  assert.equal(listSessions(home, { q: 'tax return' }).total, 0, 'the Privacy agent is not searched');
  assert.equal(listSessions(home, { exclude: [] }).total, 5, 'unless you remove it from the list');
  assert.equal(getSession(home, 'priv-dddd4444'), null);
});

test('conversations: a transcript is masked, reasoning is never shown, tool output is cut short and long ones are paged', () => {
  const home = hermes();
  const g = getSession(home, 'cockpit-aaaa1111')!;
  assert.deepEqual([g.session.title, g.total, g.messages.map((m) => m.role)], ['Plan the notice calendar', 3, ['user', 'assistant', 'tool']]);
  assert.doesNotMatch(JSON.stringify(g), /sk-abcdefghijklmnopqrstuvwx|PRIVATE CHAIN OF THOUGHT/);
  assert.match(g.messages[1].text, /\[MASKED/);
  assert.deepEqual(g.messages[1].calls, ['terminal']);
  assert.equal(g.messages[2].text.length, 600);
  assert.equal(g.messages[2].tool, 'terminal');
  assert.deepEqual(getSession(home, 'cockpit-aaaa1111', { offset: 2, limit: 1 })!.messages.map((m) => m.role), ['tool']);
  assert.equal(getSession(home, 'nope-nope-nope'), null);
});

test('conversations API: only the owner, with the id checked', async () => {
  const home = hermes();
  const dir = mkdtempSync(join(tmpdir(), 'pub-')); writeFileSync(join(dir, 'index.html'), '<html>x</html>');
  const people: Record<string, unknown> = { frank: { name: 'Frank', hide: [], device: null }, diane: { name: 'Diane', hide: ['investments'], device: 'hp-x360' } };
  const deps = {
    publicDir: dir, guard: { allowedHosts: [] }, chat: { apiUrl: 'http://127.0.0.1:1', apiKey: 'k' }, tasks: { run: async () => '{}', boardFor: (p: string) => p },
    getRollup: async () => ({}), history: () => [], agentDetail: () => null, catalog: () => [], privacyAsk: async () => ({ answer: 'x', masked: 0 }), growthRun: () => ({ code: 0, output: '{}' }),
    agentsRun: () => ({ code: 0, output: '' }), modelsPath: join(dir, 'm.json'), work: () => ({ code: 0, output: '[]' }), invalidate: () => {}, groupOfBoard: (b: string) => b,
    sessions: { list: (o: object) => listSessions(home, o), get: (id: string, o: object) => getSession(home, id, o) },
    identify: (req: { headers: Record<string, string> }) => people[req.headers['x-test-as']],
  } as unknown as AppDeps;
  const srv: Server = createServer((q, r) => void createApp(deps)(q, r));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const get = async (p: string, who: string) => { const r = await fetch(base + p, { headers: { 'x-test-as': who } }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
  try {
    assert.equal((await get('/api/sessions', 'diane')).status, 403);
    assert.equal((await get('/api/session?id=cockpit-aaaa1111', 'diane')).status, 403);
    const list = await get('/api/sessions?q=swiftui&limit=5', 'frank');
    assert.deepEqual([list.status, list.body.sessions.length], [200, 2]);
    const one = await get('/api/session?id=cockpit-aaaa1111', 'frank');
    assert.deepEqual([one.status, one.body.messages.length], [200, 3]);
    assert.equal((await get('/api/session?id=nope-nope-nope', 'frank')).status, 404);
    assert.equal((await get('/api/session?id=../../etc/passwd', 'frank')).status, 400);
  } finally { srv.close(); }
});
