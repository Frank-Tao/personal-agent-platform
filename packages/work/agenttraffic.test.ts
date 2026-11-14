import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { agentTraffic } from './agenttraffic.ts';

// A session that starts inside a task run is charged to that task's board and project; anything else is "other".
test('tokens split by portfolio and project; sessions outside a run are other', () => {
  const home = mkdtempSync(join(tmpdir(), 'traffic-'));
  const now = 1_000_000;
  mkdirSync(join(home, 'kanban', 'boards', 'b1'), { recursive: true });
  const k = new DatabaseSync(join(home, 'kanban', 'boards', 'b1', 'kanban.db'));
  k.exec(`CREATE TABLE tasks (id TEXT, title TEXT, tenant TEXT); CREATE TABLE task_runs (task_id TEXT, profile TEXT, started_at INT, ended_at INT);
    INSERT INTO tasks VALUES ('t1','x','proj-a'); INSERT INTO task_runs VALUES ('t1','qa', ${now - 1000}, ${now - 900});`);
  k.close();
  mkdirSync(join(home, 'profiles', 'qa'), { recursive: true });
  const s = new DatabaseSync(join(home, 'profiles', 'qa', 'state.db'));
  s.exec(`CREATE TABLE sessions (started_at REAL, input_tokens INT, output_tokens INT);
    INSERT INTO sessions VALUES (${now - 990}, 100, 50); INSERT INTO sessions VALUES (${now - 500}, 30, 20);`);
  s.close();
  const t = agentTraffic(home, (b) => (b === 'b1' ? 'micropace' : undefined), 7, now).get('qa')!;
  assert.deepEqual([t.tokens, t.other, t.sessions], [200, 50, 2]);
  assert.deepEqual(t.byPortfolio, { micropace: { tokens: 150, projects: { 'proj-a': 150 } } });
});
