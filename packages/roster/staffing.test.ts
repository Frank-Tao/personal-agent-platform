import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog, loadCatalogCached, searchCatalog, tokens } from './catalog.ts';
import { type StaffingAgent, evaluateStaffing } from './staffing.ts';

async function catalogDir() {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-'));
  const persona = (division: string, file: string, name: string, description: string, vibe = '') => {
    mkdirSync(join(dir, division), { recursive: true });
    writeFileSync(join(dir, division, file), `---\nname: ${name}\ndescription: ${description}\nemoji: 🧩\nvibe: ${vibe}\n---\n# ${name}\nBody.\n`);
  };
  writeFileSync(join(dir, 'divisions.json'), JSON.stringify({ divisions: { engineering: {}, specialized: {}, marketing: {} } }));
  persona('engineering', 'engineering-mobile-app-builder.md', 'Mobile App Builder', 'Native iOS and Android application developer');
  persona('specialized', 'data-privacy-officer.md', 'Data Privacy Officer', 'GDPR and privacy compliance reviews for products that store personal data');
  persona('marketing', 'marketing-seo-specialist.md', 'SEO Specialist', 'Search engine optimization strategist');
  mkdirSync(join(dir, 'specialized'), { recursive: true });
  writeFileSync(join(dir, 'specialized', 'playbook.md'), '# A playbook without frontmatter\n'); // not a persona
  return dir;
}

const agent = (a: Partial<StaffingAgent> & Pick<StaffingAgent, 'id' | 'name' | 'role'>): StaffingAgent => ({
  profile: a.id, state: 'active', portfolios: ['ai-thrival'], allPortfolios: false, ...a,
});
const TEAM = [
  agent({ id: 'atlas', profile: 'default', name: 'Atlas', role: 'Chief of staff routing every request', allPortfolios: true, portfolios: [] }),
  agent({ id: 'aso', name: 'App Store Optimizer', role: 'App Store optimization: keywords, titles, screenshots, ratings', personaName: 'App Store Optimizer', division: 'marketing', personaSlug: 'marketing/aso' }),
  agent({ id: 'qa', name: 'Reality Checker', role: 'Independent reviewer demanding evidence', state: 'proposed', portfolios: ['ai-thrival', 'micropace'] }),
  agent({ id: 'diane', name: 'diane', role: 'a bot', state: 'unlisted', portfolios: [] }),
];

test('catalog loads personas only, with size, and ignores playbooks without frontmatter', async () => {
  const cat = loadCatalog(await catalogDir());
  assert.deepEqual(cat.map((e) => e.slug).sort(), ['engineering/engineering-mobile-app-builder', 'marketing/marketing-seo-specialist', 'specialized/data-privacy-officer']);
  assert.ok(cat.every((e) => e.bytes > 40 && e.emoji === '🧩'));
  assert.deepEqual(loadCatalog('/definitely/not/here'), []);
});

test('catalog cache reuses the parsed list until the folder changes', async () => {
  const dir = await catalogDir();
  const a = loadCatalogCached(dir);
  assert.equal(loadCatalogCached(dir), a); // same array instance
});

test('tokens: stopwords and filler dropped, plurals stemmed, jargon expanded', () => {
  assert.deepEqual(tokens('Add the new listings in ui').sort(), ['design', 'listing', 'ui']);
  const t = tokens('Build the login screen in SwiftUI');
  assert.ok(t.includes('ios') && t.includes('mobile') && t.includes('login') && !t.includes('in') && !t.includes('the'));
});

test('catalog search ranks name matches first and honours the division filter', async () => {
  const cat = loadCatalog(await catalogDir());
  assert.equal(searchCatalog(cat, 'privacy officer')[0].e.slug, 'specialized/data-privacy-officer');
  assert.deepEqual(searchCatalog(cat, 'privacy', { division: 'marketing' }), []);
});

test('covered: an agent on the portfolio matches the task, and no candidates are suggested', async () => {
  const r = evaluateStaffing({ title: 'Write the App Store listing and keywords', portfolio: 'ai-thrival' }, TEAM, loadCatalog(await catalogDir()));
  assert.equal(r.verdict, 'covered');
  assert.equal(r.best[0].id, 'aso');
  assert.deepEqual(r.candidates, []);
});

test('gap: the team exists but does not match; catalog specialists with 2+ matched words are offered', async () => {
  const cat = loadCatalog(await catalogDir());
  const r = evaluateStaffing({ title: 'GDPR privacy review of the data we store', portfolio: 'ai-thrival' }, TEAM, cat);
  assert.equal(r.verdict, 'gap');
  assert.equal(r.candidates[0].slug, 'specialized/data-privacy-officer');
  assert.ok(r.candidates[0].matched.length >= 2);
  const ios = evaluateStaffing({ title: 'Build the login screen in SwiftUI', portfolio: 'ai-thrival' }, TEAM, cat);
  assert.equal(ios.candidates[0].slug, 'engineering/engineering-mobile-app-builder'); // SwiftUI → iOS → mobile
  assert.deepEqual(evaluateStaffing({ title: 'Plan the family holiday', portfolio: 'ai-thrival' }, TEAM, cat).candidates, []); // nothing close: say so
});

test('one ambiguous shared word is not coverage ("store" in App Store vs data we store)', async () => {
  const r = evaluateStaffing({ title: 'Review how we store customer data', portfolio: 'ai-thrival' }, TEAM, []);
  assert.equal(r.verdict, 'gap');
  assert.deepEqual(r.best[0]?.matched, ['store']); // still shown as the nearest agent, just not treated as covering
});

test('Atlas and agents outside the roster never count as coverage; unlinked portfolios have no team', async () => {
  const cat = loadCatalog(await catalogDir());
  const r = evaluateStaffing({ title: 'Chief of staff routing every request', portfolio: 'family' }, TEAM, cat);
  assert.equal(r.verdict, 'no-team'); // Atlas matches the words but is only the router; diane is not in the roster
  assert.deepEqual(r.best, []);
  assert.match(r.note, /Nobody is linked/);
});

test('a proposed agent can cover a task but the note says it does not exist yet; already-added personas are not re-suggested', async () => {
  const cat = loadCatalog(await catalogDir());
  const r = evaluateStaffing({ title: 'Independent review: evidence that the reviewer demands', portfolio: 'micropace' }, TEAM, cat);
  assert.equal(r.verdict, 'covered');
  assert.equal(r.best[0].state, 'proposed');
  assert.match(r.note, /has not been created yet/);
  const taken = [...TEAM, agent({ id: 'privacy', name: 'Privacy', role: 'privacy', personaSlug: 'specialized/data-privacy-officer', portfolios: ['x'] })];
  const g = evaluateStaffing({ title: 'GDPR privacy review of the data we store', portfolio: 'ai-thrival' }, taken, cat);
  assert.ok(!g.candidates.some((c) => c.slug === 'specialized/data-privacy-officer'));
});
