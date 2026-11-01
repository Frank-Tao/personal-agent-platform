import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { main } from './cli.ts';
import { aboutConfidence, aboutState, settle, type AboutEntry, type Lesson } from '../packages/growth/model.ts';
import { buildPacket } from '../packages/growth/packet.ts';

const NOW = new Date('2026-11-04T10:00:00'); // a Wednesday (ISO week 2026-W45)

async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'growth-'));
  const home = join(dir, 'hermes');
  const reg = join(dir, 'agents.json');
  const agent = (id: string) => ({ id, profile: id, name: id, role: `${id} role`, managed: false, lanes: [], portfolios: ['micropace'] });
  writeFileSync(reg, JSON.stringify({ catalog: { repo: 'r', commit: 'c', dir: join(dir, 'cat') }, agents: [agent('coding'), agent('pm')] }));
  const env = { GROWTH_ROOT: join(dir, 'growth'), AGENTS_REGISTRY: reg, HERMES_HOME: home } as NodeJS.ProcessEnv;
  const out: string[] = [];
  const cli = (...a: string[]) => { out.length = 0; const code = main(a, env, (s) => out.push(s), () => '', NOW); return code; };
  const text = () => out.join('\n');
  const json = () => JSON.parse(out.find((l) => l.startsWith('[') || l.startsWith('{')) ?? 'null');
  return { dir, home, env, cli, text, json, root: join(dir, 'growth') };
}

test('About You: an observation starts tentative, grows with confirmation, a statement from Frank starts strong, corrections supersede, private text is refused', async () => {
  const w = await world();
  assert.equal(w.cli('about', 'add', 'coding', '--text', 'Prefers small commits with a test per change'), 0);
  assert.equal(existsSync(w.root), false); // dry run writes nothing
  w.cli('about', 'add', 'coding', '--text', 'Prefers small commits with a test per change', '--apply');
  w.cli('about', 'list', 'coding', '--json');
  let e = w.json()[0];
  assert.deepEqual([e.state, e.confidence, e.source], ['tentative', 0.4, 'observed']);
  w.cli('about', 'add', 'coding', '--text', 'Prefers small commits with a test per change', '--apply'); // seen again
  w.cli('about', 'observe', e.id, 'support', '--apply');
  w.cli('about', 'list', 'coding', '--json'); e = w.json()[0];
  assert.deepEqual([e.state, e.confidence, e.support], ['active', 0.7, 2]);
  w.cli('about', 'add', '*', '--text', 'Never deploy on Fridays', '--kind', 'constraint', '--source', 'user-said', '--apply');
  w.cli('about', 'list', 'coding', '--json');
  assert.ok(w.json().some((x: any) => x.text === 'Never deploy on Fridays' && x.state === 'active' && x.confidence === 0.9)); // shared entries reach every agent
  const wrong = w.json().find((x: any) => x.text.startsWith('Prefers'));
  w.cli('about', 'correct', wrong.id, '--text', 'Prefers one commit per task, tests included', '--apply');
  w.cli('about', 'list', 'coding', '--json');
  const rows = w.json();
  assert.equal(rows.find((x: any) => x.id === wrong.id).state, 'superseded');
  assert.equal(rows.find((x: any) => x.text.startsWith('Prefers one commit')).source, 'correction');
  const fresh = rows.find((x: any) => x.text.startsWith('Prefers one commit'));
  w.cli('about', 'retract', fresh.id, '--apply');
  w.cli('about', 'list', 'coding', '--json');
  assert.equal(w.json().find((x: any) => x.id === fresh.id).state, 'retracted');
  assert.equal(w.cli('about', 'add', 'coding', '--text', 'My TFN is 123 456 789', '--apply'), 1);
  assert.match(w.text(), /looks private/);
  assert.equal(w.cli('about', 'add', 'coding', '--text', 'Asked about his bank statement balance', '--apply'), 1);
  assert.equal(w.cli('about', 'add', 'ghost', '--text', 'x', '--apply'), 1);
});

test('observed evidence fades without support; Frank\'s own statements do not', () => {
  const e = (source: 'observed' | 'user-said'): AboutEntry => ({ id: 'a', text: 't', kind: 'preference', scope: '*', source, ref: '', observed: '2026-01-01', support: 2, oppose: 0, retracted: false, superseded_by: null, updated: '2026-01-01' });
  assert.equal(aboutConfidence(e('observed'), '2026-01-01'), 0.7);
  assert.equal(aboutConfidence(e('observed'), '2026-05-01'), 0.5); // 4 months: -0.20
  assert.equal(aboutState(e('observed'), '2026-09-01'), 'tentative');
  assert.equal(aboutConfidence(e('user-said'), '2026-09-01'), 0.95);
});

test('lessons: a scope is required; wins promote (once → local, two tasks → reused); two losses that outnumber wins retire it; nothing is promoted by repetition', async () => {
  const w = await world();
  assert.equal(w.cli('lesson', 'add', 'coding', '--title', 'Run the build before claiming done', '--lesson', 'Run the project build command first', '--apply'), 1); // no --when
  assert.equal(w.cli('lesson', 'add', 'coding', '--title', 'Run the build before claiming done', '--lesson', 'Run the project build command and quote its output', '--when', 'finishing any code task', '--not-when', 'docs-only changes', '--evidence', 'task t_1: said done, build failed', '--apply'), 0);
  const id = readdirSync(join(w.root, 'coding', 'experience'))[0].replace('.md', '');
  assert.equal(id, 'l-20261104-run-the-build-before-claiming-do'); // the title slug is capped at 32 characters
  w.cli('lesson', 'apply', id, '--task', 't_a', '--outcome', 'win', '--apply');
  assert.match(w.text(), /→ local \(was tentative\)/);
  w.cli('lesson', 'apply', id, '--task', 't_a', '--outcome', 'win', '--apply'); // same task again: not a second project
  w.cli('lesson', 'list', 'coding', '--json');
  assert.equal(w.json()[0].status, 'local');
  w.cli('lesson', 'apply', id, '--task', 't_b', '--outcome', 'win', '--apply');
  assert.match(w.text(), /→ reused/);
  const lo = (n: number) => w.cli('lesson', 'apply', id, '--task', `t_l${n}`, '--outcome', 'loss', '--apply');
  lo(1); lo(2); lo(3);
  w.cli('lesson', 'list', 'coding', '--json');
  assert.equal(w.json()[0].status, 'reused'); // 3 losses do not outnumber 3 wins: still in use
  lo(4);
  w.cli('lesson', 'list', 'coding', '--json');
  assert.equal(w.json()[0].status, 'retired'); // 4 losses > 3 wins
  assert.match(readFileSync(join(w.root, 'coding', 'experience', id + '.md'), 'utf8'), /retired_reason: lost 4 of 7 applications/);
});

test('settle(): retirement needs losses ≥ 2 and more losses than wins', () => {
  const l = (outcomes: Array<'win' | 'loss'>): Lesson => ({ id: 'l', agent: 'a', title: 't', lesson: 'x', when: 'y', not_when: '', evidence: [], status: 'tentative', applied: outcomes.map((o, i) => ({ task: `t${i}`, outcome: o, at: '' })), created: '', updated: '', retired_reason: null, supersedes: null });
  assert.equal(settle(l(['win', 'loss', 'loss'])).status, 'retired');
  assert.equal(settle(l(['win', 'win', 'loss', 'loss'])).status, 'reused');
  assert.equal(settle(l(['loss'])).status, 'tentative');
  assert.equal(settle(l([])).status, 'tentative');
});

test('packet: constraints always come first and are never cut; relevant lessons are ranked in; unrelated ones stay out; budget is respected; use is logged without task text', async () => {
  const w = await world();
  w.cli('about', 'add', '*', '--text', 'Never deploy on Fridays', '--kind', 'constraint', '--source', 'user-said', '--apply');
  w.cli('about', 'add', 'coding', '--text', 'Wants a short summary at the top of every report', '--source', 'user-said', '--apply');
  w.cli('lesson', 'add', 'coding', '--title', 'Check the build output before reporting', '--lesson', 'Quote the build output in the report', '--when', 'finishing a code task and reporting a build result', '--apply');
  w.cli('lesson', 'add', 'coding', '--title', 'Quote App Store review notes exactly', '--lesson', 'Copy the review note text verbatim', '--when', 'replying to App Store review', '--apply');
  w.cli('packet', 'coding', '--task', 'Finish the code task and report the build result');
  const t = w.text();
  assert.match(t, /Never deploy on Fridays/);
  assert.match(t, /Check the build output before reporting/);
  assert.ok(!/App Store review notes/.test(t));
  assert.ok(t.indexOf('Never deploy') < t.indexOf('Check the build output')); // constraints first
  const log = readFileSync(join(w.root, 'log.jsonl'), 'utf8');
  assert.match(log, /"kind":"packet"/);
  assert.ok(!/build result/.test(log)); // ids only, never the task text
  w.cli('packet', 'pm', '--task', 'Plan the weekly review');
  assert.match(w.text(), /Never deploy on Fridays/); // shared constraint reaches pm; coding's lessons do not
  assert.ok(!/Check the build/.test(w.text()));
  // a constraint set that does not fit the budget is an error, not a silent cut
  assert.throws(() => buildPacket({ agent: 'a', task: 'x', today: '2026-11-04', budget: 60, lessons: [], about: [{ id: 'a1', text: 'x'.repeat(200), kind: 'constraint', scope: '*', source: 'user-said', ref: '', observed: '2026-11-04', support: 0, oppose: 0, retracted: false, superseded_by: null, updated: '2026-11-04' }] }), /exceed the budget/);
  const empty = await world();
  empty.cli('packet', 'coding', '--task', 'anything');
  assert.match(empty.text(), /Nothing recorded yet/);
});

function kanban(home: string, board: string, profile: string, tasks: Array<{ id: string; completed: Date; runs: number; touched: boolean }>) {
  const dir = join(home, 'kanban', 'boards', board); mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'kanban.db'));
  db.exec('CREATE TABLE tasks (id TEXT, assignee TEXT, status TEXT, completed_at INT); CREATE TABLE task_runs (task_id TEXT, profile TEXT, started_at INT, ended_at INT); CREATE TABLE task_events (task_id TEXT, kind TEXT, payload TEXT)');
  for (const t of tasks) {
    const c = Math.floor(t.completed.getTime() / 1000);
    db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)').run(t.id, profile, 'done', c);
    for (let i = 0; i < t.runs; i++) db.prepare('INSERT INTO task_runs VALUES (?, ?, ?, ?)').run(t.id, profile, c - 600 * (t.runs - i), c - 600 * (t.runs - i) + 300);
    db.prepare('INSERT INTO task_events VALUES (?, ?, ?)').run(t.id, 'created', '{}');
    if (t.touched) db.prepare('INSERT INTO task_events VALUES (?, ?, ?)').run(t.id, 'unblocked', '{}');
  }
  db.close();
}

test('daily and weekly closes: numbers come from the boards, trends compare with last week, thin weeks are flagged, quiet agents say so, and re-running changes nothing', async () => {
  const w = await world();
  const d = (iso: string) => new Date(iso);
  kanban(w.home, 'micropace-labs', 'coding', [
    { id: 't1', completed: d('2026-10-28T12:00:00'), runs: 3, touched: true },   // last week
    { id: 't2', completed: d('2026-11-02T12:00:00'), runs: 1, touched: false }, // this week
    { id: 't3', completed: d('2026-11-03T12:00:00'), runs: 2, touched: false },
    { id: 't4', completed: d('2026-11-04T09:00:00'), runs: 1, touched: false },
  ]);
  w.cli('lesson', 'add', 'coding', '--title', 'Old unverified idea', '--lesson', 'Try it', '--when', 'sometimes', '--apply');
  assert.equal(w.cli('daily', '--date', '2026-11-04', '--apply'), 0);
  const day = readFileSync(join(w.root, 'coding', 'daily', '2026-11-04.md'), 'utf8');
  assert.match(day, /Finished tasks: \*\*1\*\* \(100% without anyone stepping in\)/);
  assert.match(readFileSync(join(w.root, 'pm', 'daily', '2026-11-04.md'), 'utf8'), /No activity recorded\./);
  w.cli('weekly', '--apply');
  const week = readFileSync(join(w.root, 'coding', 'weekly', '2026-W45.md'), 'utf8');
  assert.match(week, /^# 2026-W45 — coding/);
  assert.match(week, /\| Finished tasks \| 3 \| 1 \|/);
  assert.match(week, /Ran without anyone stepping in \| 100% \| 0% \| ↑ better/);
  assert.match(week, /Extra attempts per task \| 0\.3 \| 2 \| ↑ better/);
  assert.match(week, /Fewer than 5 finished tasks this week/);
  assert.match(week, /No lessons were given to this agent last week/);
  w.cli('weekly', '--apply');
  assert.match(w.text(), /unchanged/); // repeated triggers with no new facts do not rewrite
  w.cli('close');
  assert.match(w.text(), /weekly close runs on Sundays/);
});

test('show --json is what Cockpit reads: about, lessons with wins/losses, 8 weeks and 14 days of numbers, report names', async () => {
  const w = await world();
  w.cli('about', 'add', 'coding', '--text', 'Wants a short summary first', '--source', 'user-said', '--apply');
  w.cli('lesson', 'add', 'coding', '--title', 'Quote build output', '--lesson', 'Quote it', '--when', 'finishing code tasks', '--apply');
  w.cli('show', 'coding');
  const s = w.json();
  assert.equal(s.about.length, 1);
  assert.equal(s.lessons[0].wins, 0);
  assert.equal(s.metrics.weeks.length, 8);
  assert.equal(s.metrics.days.length, 14);
  assert.deepEqual(s.reports, { daily: [], weekly: [] });
});
