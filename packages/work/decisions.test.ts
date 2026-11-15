import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionError, addDecision, findDecision, ledgerPath, parseLedger, readDecisions, serializeLedger, setStatus } from './decisions.ts';

const kb = () => { const d = mkdtempSync(join(tmpdir(), 'kb-')); mkdirSync(join(d, 'micropace')); mkdirSync(join(d, 'family')); return d; };
const base = { portfolio: 'micropace', project: 'notice-v1', date: '2026-11-15' };

test('ledger: an entry is written as readable markdown and read back unchanged; ids count up per project', () => {
  const d = kb();
  const a = addDecision(d, { ...base, title: 'Use SwiftUI for the player view', why: 'Faster to ship; no UIKit bridge needed.', by: 'Frank', source: 'manual' });
  const b = addDecision(d, { ...base, title: 'Ship to TestFlight first', by: 'pm', source: 'task t_ab12cd34', date: '2026-11-16' });
  assert.deepEqual([a.decision.ref, b.decision.ref], ['micropace/notice-v1/D1', 'micropace/notice-v1/D2']);
  const text = readFileSync(ledgerPath(d, 'micropace', 'notice-v1'), 'utf8');
  assert.match(text, /^# Decisions — notice-v1/);
  assert.match(text, /## D1 · 2026-11-15 · Use SwiftUI for the player view\n- status: active\n- by: Frank\n- source: manual\n- why: Faster to ship/);
  const back = readDecisions(d, { project: 'notice-v1' });
  assert.deepEqual(back.map((x) => x.ref), ['micropace/notice-v1/D2', 'micropace/notice-v1/D1'], 'newest first');
  const parsed = parseLedger(text, 'micropace', 'notice-v1');
  assert.equal(serializeLedger(parsed.preface, parsed.entries), text, 'round trip');
});

test('ledger: the same decision from the same source is not added twice; a different source is', () => {
  const d = kb();
  const one = addDecision(d, { ...base, title: 'Charter approved: ship the notice calendar', source: 'approval', by: 'Frank' });
  const again = addDecision(d, { ...base, title: 'Charter approved:  ship the Notice calendar!', source: 'approval', by: 'Frank' });
  assert.equal(again.duplicate, true);
  assert.equal(again.decision.ref, one.decision.ref);
  assert.equal(addDecision(d, { ...base, title: 'Charter approved: ship the notice calendar', source: 'manual', by: 'Frank' }).duplicate, false);
  assert.equal(readDecisions(d, { project: 'notice-v1' }).length, 2);
});

test('ledger: superseding marks the old entry; proposals are confirmed or rejected once; only a proposal can be rejected', () => {
  const d = kb();
  addDecision(d, { ...base, title: 'Use UIKit for the player view', by: 'coding' });
  const s = addDecision(d, { ...base, title: 'Use SwiftUI for the player view', by: 'Frank', supersedes: 'D1' });
  assert.equal(s.decision.supersedes, 'D1');
  assert.equal(findDecision(d, 'micropace/notice-v1/D1')?.status, 'superseded');
  assert.throws(() => addDecision(d, { ...base, title: 'Something that replaces a ghost', supersedes: 'D9' }), (e: unknown) => e instanceof DecisionError && e.status === 404);

  const p = addDecision(d, { ...base, title: 'Drop the iPad layout for v1', status: 'proposed', by: 'pm', source: 'harvest t_ab12cd34' });
  assert.equal(p.decision.status, 'proposed');
  assert.equal(setStatus(d, p.decision.ref, 'active', 'Frank').status, 'active');
  assert.throws(() => setStatus(d, p.decision.ref, 'rejected', 'Frank'), (e: unknown) => e instanceof DecisionError && e.status === 409);
  const q = addDecision(d, { ...base, title: 'Move the review to Friday', status: 'proposed', by: 'pm' });
  const rej = setStatus(d, q.decision.ref, 'rejected', 'Frank', 'not now');
  assert.equal(rej.status, 'rejected');
  assert.match(rej.notes, /rejected by Frank: not now/);
  assert.deepEqual(readDecisions(d, { status: ['proposed'] }).map((x) => x.ref), []);
});

test('ledger: portfolio-level decisions, legacy one-liners, questions, and filters by portfolio and status', () => {
  const d = kb();
  addDecision(d, { portfolio: 'micropace', title: 'MicroPace stays greenfield until a first user exists', by: 'Frank', date: '2026-11-10' });
  addDecision(d, { portfolio: 'family', project: 'orbit', title: 'Family Orbit uses on-device storage only', by: 'Frank', date: '2026-11-11' });
  addDecision(d, { ...base, title: 'Which store region do we launch in first?', kind: 'question', by: 'pm' });
  writeFileSync(join(d, 'micropace', 'decisions.md'), '# MicroPace — decisions\n\n<!-- YYYY-MM-DD — decision — why -->\n2026-11-01 — Name the app Notice — short and clear\n- 2026-11-02 — Preview host is preview.example.com\n');
  const all = readDecisions(d, { includeLegacy: true });
  assert.equal(all.length, 5);
  const legacy = all.filter((x) => x.legacy);
  assert.deepEqual(legacy.map((x) => [x.title, x.why]), [['Preview host is preview.example.com', ''], ['Name the app Notice', 'short and clear']]);
  assert.deepEqual(readDecisions(d, { portfolio: 'family' }).map((x) => x.ref), ['family/orbit/D1']);
  assert.deepEqual(readDecisions(d, { kind: 'question' }).map((x) => x.title), ['Which store region do we launch in first?']);
  assert.equal(readDecisions(d, { portfolio: 'micropace', project: '_portfolio' }).length, 1);
});

test('ledger: hand edits are tolerated (unknown status, extra lines, odd spacing); private text and bad input are refused', () => {
  const d = kb();
  mkdirSync(join(d, 'micropace', 'decisions'));
  writeFileSync(ledgerPath(d, 'micropace', 'notice-v1'), '# Decisions — notice-v1\n\nmy own intro\n\n## D4 · 2026-11-01 · Keep it simple\n- status: maybe\n- by: Frank\n- why: less to maintain\nan extra line typed by hand\n\n## not an entry\n');
  const [e] = readDecisions(d, { project: 'notice-v1' });
  assert.deepEqual([e.n, e.status], [4, 'active']);
  assert.match(e.notes, /an extra line typed by hand/);
  const next = addDecision(d, { ...base, title: 'A later decision' });
  assert.equal(next.decision.n, 5);
  assert.match(readFileSync(ledgerPath(d, 'micropace', 'notice-v1'), 'utf8'), /my own intro/, 'the preface survives a rewrite');
  const refuse = (input: Partial<Parameters<typeof addDecision>[1]>, status: number) => assert.throws(() => addDecision(d, { ...base, title: 'A fine decision title', ...input }), (x: unknown) => x instanceof DecisionError && x.status === status);
  refuse({ title: 'My tax file number is 123 456 782' }, 422);
  refuse({ title: 'hi' }, 400);
  refuse({ project: '../etc' }, 400);
  refuse({ source: 'trust me' }, 400);
  refuse({ date: 'yesterday' }, 400);
});
