import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addFeedback, list } from './feedback.ts';
import { applyDigest, isoWeek, planDigest, readProposals, jaccard, tokens } from './digest.ts';
import { main } from '../../work/cli.ts';

const NOW = new Date('2026-11-09T20:30:00Z');
const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

async function sample() {
  const dir = await mkdtemp(join(tmpdir(), 'fb-digest-'));
  const add = (text: string, days: number, o: { by?: string; source?: 'cockpit' | 'telegram'; page?: string } = {}) =>
    addFeedback({ text, by: o.by ?? 'frank', source: o.source ?? 'cockpit', page: o.page }, { dir, now: () => at(days) }).item;
  // theme A: blocked tasks hidden (3 items, 2 sources, recent)
  add('Project page hides blocked tasks unless I scroll', 6, { page: '#/p/x' });
  add('blocked tasks are hidden on the project page', 3, { source: 'telegram' });
  add('Please show blocked tasks on the project page', 1, { page: '#/p/x' });
  // theme B: Atlas answers too long (2 items, older)
  add('Atlas replies are too long', 20, { source: 'telegram' });
  add('Atlas replies too long, shorten them', 12, { source: 'telegram' });
  // theme C: one fresh one-off (waits), one older one-off (proposed)
  add('Add a dark mode toggle', 1);
  add('Sidebar icons look blurry', 10);
  return dir;
}

test('similarity and week helpers', () => {
  assert.ok(jaccard(tokens('Atlas replies are too long'), tokens('Atlas replies too long, shorten them')) > 0);
  assert.equal(jaccard(new Set(), new Set(['a'])), 0);
  assert.equal(isoWeek(NOW), '2026-W46');
});

test('digest groups duplicates, ranks by count and recency, and keeps evidence quotes', async () => {
  const dir = await sample();
  const r = planDigest({ dir, now: () => NOW });
  const titles = r.ranked.map((p) => p.title);
  assert.equal(r.ranked.length, 3);
  assert.match(titles[0], /blocked tasks/i);
  assert.equal(r.ranked[0].count, 3);
  assert.deepEqual(r.ranked[0].sources, ['cockpit', 'telegram']);
  assert.equal(r.ranked[0].days, 3);
  assert.match(titles[1], /Atlas/);
  assert.equal(r.ranked[1].count, 2);
  assert.ok(r.ranked[0].score > r.ranked[1].score);
  assert.ok(titles.some((t) => /blurry/.test(t)));
  assert.ok(!titles.some((t) => /dark mode/.test(t)));
  assert.equal(r.waiting, 1);
  const ev = r.ranked[0].evidence;
  assert.equal(ev.length, 3);
  assert.equal(ev[0].quote, 'Please show blocked tasks on the project page');
  assert.ok(ev[0].id.startsWith('fb-'));
  assert.ok(Date.parse(ev[0].time) > Date.parse(ev[2].time));
});

test('apply writes proposals, marks items proposed, and a second run writes nothing', async () => {
  const dir = await sample();
  applyDigest(planDigest({ dir, now: () => NOW }), { dir });
  const props = readProposals(dir);
  assert.equal(props.length, 3);
  assert.ok(props.every((p) => p.status === 'pending' && /^fp-2026W46-[0-9a-f]{6}$/.test(p.id)));
  const items = list({ dir });
  assert.equal(items.filter((i) => i.status === 'proposed').length, 6);
  assert.equal(items.filter((i) => i.status === 'open').length, 1);
  const again = planDigest({ dir, now: () => NOW });
  assert.equal(again.proposals.length, 0);
  assert.equal(again.itemUpdates.length, 0);
  assert.equal(readFileSync(join(dir, 'feedback-proposals.jsonl'), 'utf8').trim().split('\n').length, 3);
});

test('new feedback joins a pending proposal instead of making a duplicate', async () => {
  const dir = await sample();
  applyDigest(planDigest({ dir, now: () => NOW }), { dir });
  addFeedback({ text: 'blocked tasks on the project page are still hidden', by: 'frank', source: 'cockpit' }, { dir, now: () => at(0) });
  const r = planDigest({ dir, now: () => NOW });
  assert.equal(r.created, 0);
  assert.equal(r.updated, 1);
  assert.equal(r.proposals[0].count, 4);
  applyDigest(r, { dir });
  assert.equal(readProposals(dir).length, 3);
});

test('at most 5 proposals are pending; extra groups stay open; old leftovers go stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-cap-'));
  const themes = ['alpha widget broken', 'bravo gadget missing', 'charlie panel slow', 'delta button wrong', 'echo layout cramped', 'foxtrot colour harsh', 'golf column narrow'];
  for (const t of themes) for (const d of [3, 2]) addFeedback({ text: `${t} ${d}`, by: `u${d}`, source: 'cli' }, { dir, now: () => at(d) });
  addFeedback({ text: 'ancient lonely note about nothing', by: 'frank', source: 'cli' }, { dir, now: () => at(90) });
  const r = planDigest({ dir, now: () => NOW });
  assert.equal(r.created, 5);
  assert.equal(r.atCap, true);
  assert.equal(r.staled, 1);
  applyDigest(r, { dir });
  const items = list({ dir });
  assert.equal(items.filter((i) => i.status === 'open').length, 4);
  assert.equal(items.filter((i) => i.status === 'stale').length, 1);
  assert.equal(planDigest({ dir, now: () => NOW }).created, 0);
});

test('work feedback digest: dry run prints quotes, --apply writes', async () => {
  const dir = await sample();
  const out: string[] = [];
  const env = { FEEDBACK_DIR: dir, WORK_NOW: NOW.toISOString() };
  assert.equal(main(['feedback', 'digest'], env, (s) => out.push(s)), 0);
  assert.match(out.join('\n'), /dry run/);
  assert.match(out.join('\n'), /"Please show blocked tasks on the project page"/);
  assert.equal(readProposals(dir).length, 0);
  assert.equal(main(['feedback', 'digest', '--apply'], env, (s) => out.push(s)), 0);
  assert.equal(readProposals(dir).length, 3);
});
