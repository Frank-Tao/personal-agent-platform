import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boardStamps, showCache } from './showcache.ts';

function board(): { home: string; db: DatabaseSync } {
  const home = mkdtempSync(join(tmpdir(), 'showcache-'));
  const dir = join(home, 'kanban', 'boards', 'b');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'kanban.db'));
  db.exec(`CREATE TABLE tasks (id TEXT, status TEXT);
    CREATE TABLE task_events (id INTEGER PRIMARY KEY, task_id TEXT, kind TEXT);
    CREATE TABLE task_runs (id INTEGER PRIMARY KEY, task_id TEXT);
    CREATE TABLE task_comments (id INTEGER PRIMARY KEY, task_id TEXT);
    CREATE TABLE task_links (parent_id TEXT, child_id TEXT);
    INSERT INTO tasks VALUES ('t_a', 'blocked'), ('t_b', 'done');
    INSERT INTO task_events (task_id, kind) VALUES ('t_a', 'created'), ('t_a', 'blocked');`);
  return { home, db };
}

test('show cache: an answer is kept while nothing happens to the task, and dropped when an event, run, comment, link or status changes', () => {
  const { home, db } = board();
  const file = join(home, 'cache.json');
  const first = showCache(file, home);
  assert.equal(first.get('b', 't_a'), undefined);
  first.set('b', 't_a', '{"v":1}');
  first.flush();
  assert.equal(showCache(file, home).get('b', 't_a'), '{"v":1}');           // a later command reads it from disk
  assert.equal(showCache(file, home).get('b', 't_b'), undefined);           // another task has its own entry
  const changes = [
    `INSERT INTO task_events (task_id, kind) VALUES ('t_a', 'unblocked')`,
    `INSERT INTO task_runs (task_id) VALUES ('t_a')`,
    `INSERT INTO task_comments (task_id) VALUES ('t_a')`,
    `INSERT INTO task_links VALUES ('t_a', 't_b')`,
    `UPDATE tasks SET status = 'ready' WHERE id = 't_a'`,
  ];
  for (const sql of changes) {
    db.exec(sql);
    const c = showCache(file, home);
    assert.equal(c.get('b', 't_a'), undefined, sql);
    c.set('b', 't_a', '{"v":1}');
    c.flush();
    assert.equal(showCache(file, home).get('b', 't_a'), '{"v":1}');
  }
  db.close();
});

test('show cache: with no readable board database nothing is kept (Hermes is asked every time), and old entries age out', () => {
  const home = mkdtempSync(join(tmpdir(), 'showcache-'));
  const file = join(home, 'cache.json');
  assert.equal(boardStamps(home, 'nope'), null);
  const c = showCache(file, home);
  c.set('nope', 't_a', '{}');
  c.flush();
  assert.equal(existsSync(file), false);
  const { home: h2, db } = board();
  const f2 = join(h2, 'cache.json');
  const old = showCache(f2, h2, Date.parse('2026-01-01'));
  old.set('b', 't_a', '{"old":true}'); old.set('b', 't_b', '{"old":true}');
  old.flush();
  const later = showCache(f2, h2, Date.parse('2026-03-01'));
  assert.equal(later.get('b', 't_a'), '{"old":true}');                       // used again: kept
  later.set('b', 't_a', '{"new":true}');
  later.flush();
  assert.equal(showCache(f2, h2, Date.parse('2026-03-01')).get('b', 't_b'), undefined);   // not used for two months: gone
  db.close();
});
