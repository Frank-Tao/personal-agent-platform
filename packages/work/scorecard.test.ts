import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildScorecard, readStaffing, recordStaffing, scorecardLines, trustOf } from './scorecard.ts';

const NOW = new Date('2026-11-21T12:00:00Z'), T = NOW.getTime() / 1000, DAY = 86_400;

function board(dir: string, name: string) {
  mkdirSync(join(dir, name), { recursive: true });
  const db = new DatabaseSync(join(dir, name, 'kanban.db'));
  db.exec(`CREATE TABLE tasks (id TEXT, title TEXT, body TEXT, assignee TEXT, status TEXT, created_at INTEGER, completed_at INTEGER);
           CREATE TABLE task_runs (task_id TEXT, started_at INTEGER, ended_at INTEGER);
           CREATE TABLE task_events (task_id TEXT, kind TEXT, payload TEXT)`);
  let n = 0;
  const add = (o: { assignee: string; status?: string; daysAgo?: number; runs?: number; events?: string[]; body?: string; title?: string }) => {
    const id = `t_${name.slice(0, 2)}${String(++n).padStart(4, '0')}`;
    const done = (o.status ?? 'done') === 'done';
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?)').run(id, o.title ?? `task ${n}`, o.body ?? '', o.assignee, o.status ?? 'done', T - (o.daysAgo ?? 2) * DAY - 3600, done ? T - (o.daysAgo ?? 2) * DAY : null);
    for (let i = 0; i < (o.runs ?? 1); i++) db.prepare('INSERT INTO task_runs VALUES (?,?,?)').run(id, T - (o.daysAgo ?? 2) * DAY - 1800, T - (o.daysAgo ?? 2) * DAY - 600);
    for (const k of o.events ?? []) db.prepare('INSERT INTO task_events VALUES (?,?,?)').run(id, k, k === 'blocked' ? '{"reason":"needs a decision"}' : null);
    return id;
  };
  return { add, close: () => db.close() };
}

test('trust is earned from outcomes, by an open rule', () => {
  const w = (done: number, fp: number, you = 0, failures = 0) => ({ done, firstPass: fp, retries: 0, neededYou: you, failures, medianMinutes: null });
  assert.equal(trustOf(w(4, 4)).trust, 'new');
  assert.equal(trustOf(w(10, 9, 1)).trust, 'trusted');
  assert.equal(trustOf(w(10, 7, 1)).trust, 'steady');
  assert.equal(trustOf(w(10, 5)).trust, 'watch');
  assert.equal(trustOf(w(10, 9, 0, 3)).trust, 'watch');
});

test('scorecard: first-time passes, needing you, the window before, and whose choice of owner worked, with its reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'score-')), data = mkdtempSync(join(tmpdir(), 'score-data-'));
  const b = board(dir, 'micropace-labs');
  for (let i = 0; i < 5; i++) b.add({ assignee: 'coding', body: `[work:notice-v1:build${i}]\n` });                 // clean
  b.add({ assignee: 'coding', runs: 2 });                                                                         // a retry
  b.add({ assignee: 'coding', events: ['blocked', 'unblocked'] });                                                // needed a person
  b.add({ assignee: 'coding', daysAgo: 40, runs: 3 });                                                            // the window before
  b.add({ assignee: 'qa', status: 'running', daysAgo: 1 });
  const atlasPick = b.add({ assignee: 'qa', events: ['changes_requested'] });
  b.add({ assignee: 'pm', body: '[plan-for:notice-v1]\nplan it' });
  b.close();
  recordStaffing(data, { at: NOW.toISOString(), board: 'micropace-labs', task: atlasPick, agent: 'qa', by: 'atlas', why: 'qa owns verification on micropace' });
  const plans = new Map([['notice-v1/build0', { owner: 'coding', why: 'Swift change with tests' }], ['notice-v1/build1', { owner: 'coding', why: null }]]);
  const s = buildScorecard({ boardsDir: dir, plans, staffing: readStaffing(data), now: NOW, days: 28 });
  const coding = s.agents.find((a) => a.agent === 'coding')!;
  assert.deepEqual([coding.now.done, coding.now.firstPass, coding.now.retries, coding.now.neededYou], [7, 5, 1, 1]);
  assert.deepEqual([coding.before.done, coding.before.firstPass], [1, 0]);
  assert.equal(coding.trust, 'steady');                                   // 71% first time
  const qa = s.agents.find((a) => a.agent === 'qa')!;
  assert.deepEqual([qa.now.done, qa.open, qa.trust], [1, 1, 'new']);
  const by = Object.fromEntries(s.deciders.map((d) => [d.by, d]));
  assert.deepEqual([by.pm.picks, by.pm.good, by.pm.withReason], [2, 2, 1]);       // only tasks whose plan entry pm wrote
  assert.deepEqual([by.atlas.picks, by.atlas.good], [1, 0]);
  assert.equal(by.atlas.recent[0].why, 'qa owns verification on micropace');
  assert.equal(by.rule.picks, 1);
  assert.deepEqual([by.unrecorded.picks, by.unrecorded.good], [5, 3]);   // no plan entry and no staffing record
  const lines = scorecardLines(s);
  assert.match(lines[0], /^coding · 7 done · 71% first time \(↑ from 0%\) · needed you 1 · steady$/);
  assert.match(lines.at(-1)!, /^Owner choices that worked first time: .*pm 2\/2 good.*atlas 0\/1 good/);
});
