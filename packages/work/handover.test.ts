import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Decision } from './decisions.ts';
import { DEFAULT_BUDGET, LOCAL_BUDGET, briefBudget, buildBrief } from './handover.ts';

const d = (n: number, over: Partial<Decision> = {}): Decision => ({ ref: `micropace/notice-v1/D${n}`, portfolio: 'micropace', scope: 'notice-v1', n, date: `2026-11-${String(10 + n).padStart(2, '0')}`, title: `Decision number ${n} about the thing`, status: 'active', kind: 'decision', by: 'Frank', source: null, supersedes: null, why: `Reason ${n}`, notes: '', ...over });
const project = { id: 'notice-v1', portfolio: 'micropace', status: 'active', priority: 2, outcome: 'Ship the notice calendar', done_when: ['It runs on a phone', 'Reviewed'], repo: 'notice-v1', team: ['pm', 'coding'] };

test('brief: charter, decisions in force, open questions, proposals and replaced ones are each labelled so a model cannot mistake a draft for a decision', () => {
  const { text, omitted } = buildBrief({ project, today: '2026-11-15', results: [{ title: 'Day-0 gate', status: 'done', assignee: 'coding', completed: '2026-11-14T03:00:00Z', summary: 'Gate passed on the simulator.' }], decisions: [
    d(3), d(2, { status: 'superseded' }), d(4, { status: 'proposed', title: 'Drop the iPad layout' }), d(5, { kind: 'question', title: 'Which region first?' }), d(6, { scope: '_portfolio', ref: 'micropace/_portfolio/D6', title: 'Greenfield until a first user' }),
  ] });
  assert.equal(omitted, 0);
  assert.match(text, /^PROJECT BRIEF · notice-v1 \(micropace\) · 2026-11-15\nOutcome: Ship the notice calendar\nDone when:\n- It runs on a phone/);
  assert.match(text, /State: active · priority 2 · repo notice-v1 · team pm, coding/);
  assert.match(text, /Decisions in force \(newest first; follow these\):\n- D6 · 2026-11-16 · Frank · \[whole portfolio\] — Greenfield until a first user. Why: Reason 6\s+\(micropace\/_portfolio\/D6\)\n- D3 /);
  assert.match(text, /Open questions[^\n]*\n- D5 [^\n]*Which region first\?/);
  assert.match(text, /Proposed, NOT confirmed[^\n]*\n- D4 [^\n]*Drop the iPad layout/);
  assert.match(text, /Recent results:\n- \[done 2026-11-14 · coding\] Day-0 gate — Gate passed on the simulator\./);
  assert.match(text, /Replaced or reverted \(do not follow\):\n- D2 /);
  assert.ok(text.indexOf('Decisions in force') < text.indexOf('Proposed, NOT confirmed'));
  assert.match(text, /npm run work -- decision add notice-v1/);
});

test('brief: fits the budget, keeps the charter and the newest decisions, and says how much was left out', () => {
  const many = Array.from({ length: 60 }, (_, i) => d(i + 1, { why: 'a'.repeat(200) }));
  const { text, omitted } = buildBrief({ project, today: '2026-11-15', results: [], decisions: many, budget: 3000 });
  assert.ok(text.length <= 3000, `length ${text.length}`);
  assert.ok(omitted > 30);
  assert.match(text, /Outcome: Ship the notice calendar/);
  assert.match(text, /D60 /, 'newest kept');
  assert.doesNotMatch(text, /D1 · 2026-11-11/, 'oldest dropped first');
  assert.match(text, new RegExp(`\\(${omitted} more items left out to fit`));
});

test('brief budget: a local model gets less, a known context window sets it, and it stays within 2000..12000 characters', () => {
  assert.equal(briefBudget(), DEFAULT_BUDGET);
  assert.equal(briefBudget({ private: true }), LOCAL_BUDGET);
  assert.equal(briefBudget({ context: 200_000 }), 12_000);
  assert.equal(briefBudget({ context: 32_000 }), 2560);
  assert.equal(briefBudget({ context: 4_000 }), 2000);
});
