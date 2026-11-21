import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestTeam } from './team.ts';

const agents = ['pm', 'qa', 'coding', 'content', 'research', 'growth'].map((id) => ({ id, state: 'active', portfolios: ['ai-thrival', 'micropace'] }));

test('team: default is pm + qa; coding only for code delivery', () => {
  assert.deepEqual(suggestTeam({ portfolio: 'ai-thrival', outcome: 'Plan a study schedule', done_when: ['schedule agreed'], agents }).team, ['pm', 'qa']);
  assert.ok(suggestTeam({ portfolio: 'micropace', outcome: 'Fix the app crash', done_when: ['tests green'], agents }).team.includes('coding'));
  assert.ok(suggestTeam({ portfolio: 'micropace', outcome: 'Tidy', done_when: ['x'], test_cmd: 'pnpm test', agents }).team.includes('coding'));
});
test('team: an online course gets the content agent (which absorbed the course designer), not coding', () => {
  const t = suggestTeam({ portfolio: 'ai-thrival', outcome: 'Publish the Udemy course on prompt writing', done_when: ['8 lessons with exercises written'], agents }).team;
  assert.deepEqual(t, ['pm', 'qa', 'content']);
});
test('team: marketing words add growth; missing or inactive agents are never added', () => {
  const t = suggestTeam({ portfolio: 'micropace', outcome: 'Launch the beta and run an ad campaign', done_when: ['100 users'], agents }).team;
  assert.ok(t.includes('growth'));
  const none = suggestTeam({ portfolio: 'micropace', outcome: 'Launch the beta and run an ad campaign', done_when: ['x'], agents: agents.map((a) => a.id === 'growth' ? { ...a, state: 'proposed' } : a) }).team;
  assert.ok(!none.includes('growth'));
  assert.ok(!suggestTeam({ portfolio: 'family', outcome: 'Fix the app', done_when: ['x'], agents }).team.includes('coding'));
});

test('team: social media and App Store work go to growth (it absorbed marketer and aso)', () => {
  const t = suggestTeam({ portfolio: 'ai-thrival', outcome: 'Improve the App Store keywords and plan LinkedIn posts for the launch', done_when: ['listing updated'], agents }).team;
  assert.ok(t.includes('growth') && !t.includes('aso'));
});
