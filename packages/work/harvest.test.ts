import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHandoff } from './harvest.ts';

test('hand-off: bullets under Decisions: and Open questions: become items, with the reason split off', () => {
  const h = parseHandoff(`Built the player view and ran the simulator.

Decisions:
- Use SwiftUI for the player view — faster to ship, no UIKit bridge
- Keep the iPad layout out of v1 because there are no iPad users yet
2. Store durations as seconds (why: matches the API)

Open questions:
- Which store region do we launch in first?

Verified: xcodebuild test passed.`);
  assert.deepEqual(h.decisions, [
    { title: 'Use SwiftUI for the player view', why: 'faster to ship, no UIKit bridge' },
    { title: 'Keep the iPad layout out of v1', why: 'there are no iPad users yet' },
    { title: 'Store durations as seconds', why: 'matches the API' },
  ]);
  assert.deepEqual(h.questions, [{ title: 'Which store region do we launch in first?', why: '' }]);
});

test('hand-off: markdown headings, bold labels and inline forms are all read; none/n/a and short lines are ignored; other sections end it', () => {
  const md = parseHandoff('## Summary\nDid the thing.\n\n**Decisions:**\n* Drop the legacy login screen\n* n/a\n* ok\n\n### Verification\n- Used the simulator — fine');
  assert.deepEqual(md.decisions.map((d) => d.title), ['Drop the legacy login screen']);
  assert.deepEqual(parseHandoff('Decisions: ship behind a flag — we can turn it off fast').decisions, [{ title: 'ship behind a flag', why: 'we can turn it off fast' }]);
  assert.deepEqual(parseHandoff('Decisions: none').decisions, []);
  assert.deepEqual(parseHandoff('Nothing structured here. We decided nothing.'), { decisions: [], questions: [] });
  assert.equal(parseHandoff('Decisions:\n' + Array.from({ length: 12 }, (_, i) => `- Decision number ${i} about something`).join('\n')).decisions.length, 6, 'capped');
});
