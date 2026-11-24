import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BODY_TEMPLATE, FLOOR, type AgentLite, type PlanTask, appendLog, checkCharter, checkPlan, decisionsOf, emptyCharter, normalizeCharter, parseObjectives,
  parseProject, readPlan, renderTaskBody, sectionText, serializeObjectives, serializeProject, timeboxHours, topoOrder, writePlan,
} from './model.ts';

const AGENTS: AgentLite[] = [
  { id: 'pm', profile: 'pm', state: 'active', portfolios: ['micropace', 'ai-thrival'], allPortfolios: false },
  { id: 'coding', profile: 'coding', state: 'active', portfolios: ['micropace'], allPortfolios: false },
  { id: 'qa', profile: 'qa', state: 'active', portfolios: ['micropace'], allPortfolios: false },
  { id: 'content', profile: 'content', state: 'proposed', portfolios: ['micropace'], allPortfolios: false },
  { id: 'diane', profile: 'diane', state: 'unlisted', portfolios: [], allPortfolios: false },
];
const CTX = { portfolios: ['ai-thrival', 'micropace', 'family'], agents: AGENTS };

const project = (over: any = {}) => ({
  id: 'notice-v1', portfolio: 'micropace', objective: 'O1', key_results: ['KR1.1'], status: 'proposed' as const, owner: 'pm', tenant: 'notice-v1', timebox: '7d',
  created: '2026-11-01', approved: null, repo: null, priority: 3, test_cmd: null, plan_sha: null, board: null, paused_reason: null,
  charter: emptyCharter({ outcome: 'v1 live', done_when: ['12 checks pass'], team: ['pm', 'coding', 'qa'], outward: { deploy: { allowed: true, targets: ['preview.example.com'] }, publish: { allowed: 'draft-only' }, spend: { allowed: false } } } as any),
  ...over,
});
const task = (key: string, over: Partial<PlanTask> = {}): PlanTask => ({ key, title: `Do ${key}`, owner: 'coding', lane: null, model: null, provider: null, needs: [], accept: `${key} verified`, outward: null, workspace: null, max_runtime: '2h', goal: false, ...over });

test('the fixed floor can never be removed from a charter', () => {
  const c = normalizeCharter({ outcome: 'x', never: [] } as any);
  assert.deepEqual(FLOOR.filter((f) => !c.never.includes(f)), []);
  const p = project({ charter: { ...project().charter, never: ['custom-rule'] } });
  assert.ok(p.charter.never.includes('custom-rule'));
  const bad = project(); bad.charter.never = ['custom-rule'];
  assert.match(checkCharter(bad, CTX).errors.join(';'), /fixed floor/);
});

test('defaults: pm owns, draft-only publishing, no spend, one-week box, 20 active tasks', () => {
  const c = normalizeCharter({} as any);
  assert.deepEqual([c.max_tasks, c.outward.publish.allowed, c.outward.spend.allowed, c.outward.deploy.allowed, c.outward.deploy.rollback], [20, 'draft-only', false, false, 'required']);
  assert.ok(c.escalate_when.includes('over-budget') && c.escalate_when.includes('new-agent'));
  assert.equal(timeboxHours('7d'), 168);
  assert.equal(timeboxHours('2w'), 336);
  assert.equal(timeboxHours('soon'), null);
});

test('a valid charter passes; each rule has its own error', () => {
  assert.deepEqual(checkCharter(project(), CTX).errors, []);
  const e = (over: any, re: RegExp) => assert.match(checkCharter(project(over), CTX).errors.join(';'), re);
  e({ id: 'Bad Id' }, /id "Bad Id"/);
  e({ portfolio: 'nowhere' }, /unknown portfolio/);
  e({ tenant: 'other' }, /tenant must equal/);
  e({ timebox: 'soon' }, /timebox/);
  e({ owner: 'architect' }, /owner "architect" must be listed in charter.team/);
  e({ charter: { ...project().charter, outcome: '' } }, /outcome is empty/);
  e({ charter: { ...project().charter, done_when: [] } }, /done_when/);
  e({ charter: { ...project().charter, max_tasks: 101 } }, /max_tasks must be 1–100/);
  e({ charter: { ...project().charter, team: ['pm', 'ghost'] } }, /"ghost" is not in the roster/);
  e({ charter: { ...project().charter, team: ['pm', 'diane'] } }, /not a roster agent/);
  e({ charter: { ...project().charter, outward: { ...project().charter.outward, deploy: { allowed: true, targets: [], rollback: 'required' } } } }, /no targets/);
  e({ charter: { ...project().charter, outward: { ...project().charter.outward, publish: { allowed: 'auto', channels: [], max_per_week: 0 } } } }, /publish: auto needs channels/);
  e({ charter: { ...project().charter, outward: { ...project().charter.outward, spend: { allowed: true, max_usd: 50 } } } }, /spend is allowed but max_usd/);
  assert.match(checkCharter(project({ owner: 'qa' }), CTX).warnings.join(';'), /not pm/);
});

test('warnings, not errors: proposed team members, long timeboxes, agents not linked to the portfolio', () => {
  const p = project(); p.charter.team = ['pm', 'coding', 'content'];
  const f = checkCharter(p, CTX);
  assert.deepEqual(f.errors, []);
  assert.match(f.warnings.join(';'), /"content" has no Hermes profile yet/);
  assert.match(checkCharter(project({ timebox: '4w' }), CTX).warnings.join(';'), /longer than two weeks/);
  const q = project(); q.charter.team = ['pm', 'coding']; q.portfolio = 'family';
  assert.match(checkCharter(q, CTX).warnings.join(';'), /not linked to family/);
});

test('new_agents are pre-approved creations: catalog slug, team membership and a model are checked', () => {
  const p = project(); p.charter.team = ['pm', 'coding', 'seo']; p.charter.new_agents = [{ slug: 'marketing/marketing-seo-specialist', id: 'seo', model: 'glm-5.3-flash', provider: 'opencode-zen' }];
  assert.deepEqual(checkCharter(p, { ...CTX, catalogSlugs: ['marketing/marketing-seo-specialist'] }).errors, []); // not yet in the roster is fine: it is created with the project
  assert.match(checkCharter(p, { ...CTX, catalogSlugs: ['other/x'] }).errors.join(';'), /not in the catalog/);
  p.charter.new_agents[0].model = undefined;
  assert.match(checkCharter(p, CTX).warnings.join(';'), /no model/);
});

test('plan: ≤ max_tasks, unique keys, known dependencies, no cycles, owners in the team, acceptance tests, outward only if allowed', () => {
  const ok = [task('gate'), task('build', { needs: ['gate'], outward: 'deploy' }), task('verify', { owner: 'qa', needs: ['build'] })];
  assert.deepEqual(checkPlan(project(), ok, CTX).errors, []);
  const e = (plan: PlanTask[] | null, re: RegExp, pr = project()) => assert.match(checkPlan(pr, plan, CTX).errors.join(';'), re);
  e(null, /no plan/);
  e(Array.from({ length: 21 }, (_, i) => task(`t${i + 1}`)), /21 active top-level tasks exceed the limit of 20 \(finished tasks do not count\): group related tasks under a parent task \(npm run work -- plan regroup .*\) or split/);
  // finished tasks do not count: 25 tasks of which 6 are done is 19 active
  const many = Array.from({ length: 25 }, (_, i) => task(`t${i + 1}`));
  assert.deepEqual(checkPlan(project(), many, { ...CTX, finished: new Set(many.slice(0, 6).map((t) => t.key)) }).errors, []);
  e(many, /25 active top-level tasks exceed the limit of 20/);
  e(Array.from({ length: 101 }, (_, i) => task(`t${i + 1}`)), /101 top-level tasks, finished ones included \(limit 100\)/);
  e([task('a'), task('a')], /duplicate key/);
  e([task('a', { needs: ['zz'] })], /needs "zz"/);
  e([task('a', { needs: ['b'] }), task('b', { needs: ['a'] })], /dependency cycle/);
  e([task('a', { owner: 'content' })], /not in charter.team/);
  e([task('a', { accept: '' })], /acceptance test/);
  e([task('a', { outward: 'spend' })], /"spend" is not allowed/);
  const noPublish = project(); noPublish.charter.outward.publish.allowed = 'no';
  e([task('a', { outward: 'publish' })], /"publish" is not allowed/, noPublish);
  const withProposed = project(); withProposed.charter.team = ['pm', 'coding', 'content'];
  const f = checkPlan(withProposed, [task('a', { owner: 'content' })], CTX);
  assert.deepEqual(f.errors, []);
  assert.match(f.warnings.join(';'), /no Hermes profile yet/);
});

test('topological order puts parents first; cycles return null', () => {
  const order = topoOrder([task('c', { needs: ['b'] }), task('b', { needs: ['a'] }), task('a')])!.map((t) => t.key);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(topoOrder([task('a', { needs: ['a'] })]), null);
});

test('project file round-trips: charter front-matter + body with decisions, plan block and log', () => {
  let body = BODY_TEMPLATE.replace('<!-- decisions that apply to all tasks: names, formats, tone, links to the spec -->', 'Use the name "Notice → Calendar". Dates are ISO 8601.');
  body = writePlan(body, [task('gate'), task('build', { needs: ['gate'], outward: 'deploy', workspace: 'worktree', max_runtime: '4h', goal: true })]);
  body = appendLog(body, 'created', '2026-11-01');
  body = appendLog(body, 'approved', '2026-11-02');
  const md = serializeProject(project(), body);
  const back = parseProject(md);
  assert.deepEqual(back.project, project());
  assert.equal(decisionsOf(back.body), 'Use the name "Notice → Calendar". Dates are ISO 8601.');
  const plan = readPlan(back.body)!;
  assert.deepEqual(plan.map((t) => [t.key, t.needs, t.outward, t.workspace, t.max_runtime, t.goal]), [['gate', [], null, null, '2h', false], ['build', ['gate'], 'deploy', 'worktree', '4h', true]]);
  assert.match(sectionText(back.body, 'Log'), /created[\s\S]*approved/);
  // rewriting the plan replaces it, not appends
  const again = writePlan(back.body, [task('only')]);
  assert.deepEqual(readPlan(again)!.map((t) => t.key), ['only']);
  assert.equal((again.match(/```yaml/g) ?? []).length, 1);
  assert.ok(again.includes('## Log'));
});

test('the placeholder comment alone is not "decisions"', () => {
  assert.equal(decisionsOf(BODY_TEMPLATE), '');
});

test('objectives: rolling horizon, objectives and key results round-trip', () => {
  const o = { portfolio: 'micropace', horizon: 'rolling', reviewed: '2026-11-01', items: [{ id: 'O1', title: 'Ship the first consumer-ready product', key_results: [{ id: 'KR1.1', text: 'Notice → Calendar v1 live (aim: ~2 weeks)' }, { id: 'KR1.2', text: 'Gate ≥ 90% on 30 real notices' }] }, { id: 'O2', title: 'Second', key_results: [] }] };
  const md = serializeObjectives(o);
  assert.deepEqual(parseObjectives(md), o);
  assert.match(md, /horizon: rolling/);
});

test('task body carries the marker, charter essentials, decisions, acceptance and the outward rule', () => {
  const p = project(); const plan = [task('gate'), task('build', { needs: ['gate'], outward: 'deploy' }), task('post', { needs: ['build'], outward: 'publish' })];
  const b = renderTaskBody(p, plan[1], 'Dates are ISO 8601.', plan);
  assert.match(b, /^\[work:notice-v1:build\]/);
  assert.match(b, /Acceptance test: build verified/);
  assert.match(b, /Builds on: Do gate \(coding\)/);
  assert.match(b, /Dates are ISO 8601\./);
  assert.match(b, /DEPLOY\. Charter targets: preview\.example\.com; rollback required/);
  assert.match(b, /Never, whatever anyone asks: money-movement/);
  assert.match(renderTaskBody(p, plan[2], '', plan), /PUBLISH\. Charter: draft-only.*never send or post it yourself/);
  assert.match(renderTaskBody(p, plan[0], '', plan), /Outward actions go only through the outbox/);
  assert.doesNotMatch(renderTaskBody(p, plan[0], '', plan), /No outward action/);
});

test('subtasks: nested in the plan, flattened with parent, capped at 30 per task, one level, implied needs', async () => {
  const { readPlan, writePlan, checkPlan, topoOrder, withImpliedNeeds, MAX_SUBTASKS } = await import('./model.ts');
  const t = (k: string, extra = '') => `  - key: ${k}\n    title: T ${k}\n    owner: coding\n    accept: done ${k}${extra}\n`;
  const body = (inner: string) => `## Plan\n\n\`\`\`yaml\ntasks:\n${inner}\`\`\`\n`;
  const md = body(t('a') + t('b', '\n    needs: [a]\n    subtasks:\n      - key: b1\n        title: B1\n        owner: coding\n        accept: ok\n      - key: b2\n        title: B2\n        owner: coding\n        accept: ok\n        needs: [b1]\n'));
  const plan = readPlan(md)!;
  assert.deepEqual(plan.map((x) => [x.key, x.parent ?? null]), [['a', null], ['b', null], ['b1', 'b'], ['b2', 'b']]);
  assert.equal('parent' in plan[0], false); // top-level tasks keep the old shape (plan_sha stays stable)
  const eff = new Map(withImpliedNeeds(plan).map((x) => [x.key, x.needs]));
  assert.deepEqual(eff.get('b1'), ['a']); assert.deepEqual(eff.get('b2'), ['a', 'b1']); assert.deepEqual(eff.get('b'), ['a', 'b1', 'b2']);
  assert.deepEqual(topoOrder(plan)!.map((x) => x.key), ['a', 'b1', 'b2', 'b']);
  assert.deepEqual(readPlan(writePlan(body(''), plan)), plan); // round trip
  assert.equal(MAX_SUBTASKS, 30);
});

test('subtasks: checkPlan allows 9 top-level tasks each with 30 subtasks, rejects a 31st subtask or a nested one', async () => {
  const { checkPlan, parseProject, BODY_TEMPLATE } = await import('./model.ts');
  const mk = (key: string, parent?: string) => ({ key, title: key, owner: 'coding', lane: null, model: null, provider: null, needs: [], accept: 'ok', outward: null, workspace: null, max_runtime: '2h', goal: false, ...(parent ? { parent } : {}) });
  const md = `---\nid: x\nportfolio: ai-thrival\nstatus: active\ncharter:\n  outcome: o\n  done_when: [d]\n  team: [coding]\n  max_tasks: 9\n---\n${BODY_TEMPLATE}`;
  const p = parseProject(md).project;
  const ctx = { agents: [{ id: 'coding', profile: 'coding', state: 'active' }], catalogSlugs: null } as never;
  const tops = Array.from({ length: 9 }, (_, i) => `t${i}`);
  const full = tops.flatMap((k) => [mk(k), ...Array.from({ length: 30 }, (_, i) => mk(`${k}-s${i}`, k))]);
  assert.deepEqual(checkPlan(p, full, ctx).errors, []);
  assert.match(checkPlan(p, [...full, mk('t0-s30', 't0')], ctx).errors.join('\n'), /task "t0" has 31 subtasks; at most 30/);
  assert.match(checkPlan(p, [...full, mk('deep', 't0-s0')], ctx).errors.join('\n'), /parent "t0-s0" must be a top-level task/);
  assert.match(checkPlan(p, [...full, mk('t9')], ctx).errors.join('\n'), /10 active top-level tasks exceed the limit of 9/);
});

test('plan edit: add a subtask under its parent, refuse a nested one, refuse removing a parent that has subtasks', async () => {
  const { editPlan } = await import('./planedit.ts');
  const mk = (key: string, parent?: string) => ({ key, title: key, owner: 'coding', lane: null, model: null, provider: null, needs: [], accept: 'ok', outward: null, workspace: null, max_runtime: '2h', goal: false, ...(parent ? { parent } : {}) });
  const plan = [mk('a'), mk('a1', 'a'), mk('b')];
  const r = editPlan(plan, { op: 'add', task: { key: 'a2', title: 'a2', owner: 'coding', accept: 'ok', parent: 'a' } });
  assert.deepEqual('plan' in r && r.plan.map((t) => t.key), ['a', 'a1', 'a2', 'b']);
  assert.ok('error' in editPlan(plan, { op: 'add', task: { key: 'x', title: 'x', owner: 'coding', accept: 'ok', parent: 'a1' } }));
  assert.ok('error' in editPlan(plan, { op: 'add', task: { key: 'x', title: 'x', owner: 'coding', accept: 'ok', parent: 'zzz' } }));
  assert.match((editPlan(plan, { op: 'remove', key: 'a' }) as { error: string }).error, /has subtasks/);
  assert.ok('plan' in editPlan(plan, { op: 'remove', key: 'a1' }));
});

import { GIT_RULES_LOCAL } from './model.ts';
// A repo with no remote must not tell the worker to push (it would block); with a remote, push and PR are said NOT to be an outward action.
test('git rules: local-only text when there is no remote; push and PR are not an outward action when there is one', () => {
  const p = project(); p.repo = '/tmp/r';
  const plan = [{ key: 'a', title: 'A', owner: 'coding', lane: null, model: null, provider: null, needs: [], accept: 'ok', outward: null, workspace: null, max_runtime: '1h', goal: false }] as any;
  const withRemote = renderTaskBody(p, plan[0], '', plan);
  const local = renderTaskBody(p, plan[0], '', plan, false);
  assert.match(withRemote, /Push the branch and raise a pull request/);
  assert.match(withRemote, /Merge that pull request yourself/);
  assert.match(withRemote, /test evidence/);
  assert.match(withRemote, /not an outward action/);
  assert.ok(local.includes(GIT_RULES_LOCAL) && !/raise a pull request/.test(local) && /no remote yet/.test(local));
});

test('a build is sliced: slices chain, each visible slice has a parallel check, a slice never waits for a check, and each gets the right rules', async () => {
  const { editPlan } = await import('./planedit.ts');
  const add = (plan: PlanTask[], t: Partial<PlanTask> & { key: string }) => { const r = editPlan(plan, { op: 'add', task: { title: t.key, owner: 'coding', accept: 'x', ...t } }); assert.ok('plan' in r, JSON.stringify(r)); return (r as { plan: PlanTask[] }).plan; };
  let plan: PlanTask[] = [task('r', { owner: 'pm', desc: 'ask' })];
  plan = add(plan, { key: 'r-build', req: 'r', role: 'build' });
  plan = add(plan, { key: 's1', req: 'r', role: 'build', parent: 'r-build' });
  plan = add(plan, { key: 'c1', req: 'r', role: 'verify', owner: 'qa', parent: 'r-build', needs: ['s1'] });
  plan = add(plan, { key: 's2', req: 'r', role: 'build', parent: 'r-build', needs: ['s1'] });
  plan = add(plan, { key: 'c2', req: 'r', role: 'verify', owner: 'qa', parent: 'r-build', needs: ['s2'] });
  assert.equal(plan.find((t) => t.key === 's1')!.max_runtime, '45m');
  assert.equal(plan.find((t) => t.key === 'c1')!.max_runtime, '45m');
  assert.equal(plan.find((t) => t.key === 'r-build')!.max_runtime, '2h');
  for (let i = 3; i <= 14; i++) plan = add(plan, { key: `s${i}`, req: 'r', role: 'build', parent: 'r-build', needs: [`s${i - 1}`] });
  assert.ok(!checkPlan(project(), plan, CTX).errors.some((e) => /subtasks; at most/.test(e)), 'more than 9 slices are allowed');
  const slice = renderTaskBody(project(), plan.find((t) => t.key === 's2')!, '', plan);
  assert.match(slice, /ONE SLICE/);
  assert.match(slice, /Only when ALL pass, commit/);
  const check = renderTaskBody(project(), plan.find((t) => t.key === 'c1')!, '', plan, true, 'b');
  assert.match(check, /CHECK ONE SLICE/);
  assert.match(check, /git worktree add --detach/);
  assert.doesNotMatch(check, /Check out the branch req\//);
  const bad = plan.map((t) => (t.key === 's3' ? { ...t, needs: ['s2', 'c2'] } : t));
  assert.match(checkPlan(project(), bad, CTX).errors.join(';'), /must not need the check "c2"/);
});

test('a project names the person it belongs to (Frank or Diane); none named means Frank', async () => {
  const { personOf, parseProject, serializeProject } = await import('./model.ts');
  const p = project({ person: 'Diane' });
  assert.equal(personOf(p), 'Diane');
  assert.equal(personOf(project()), 'Frank');
  const back = parseProject(serializeProject(p, '')).project;
  assert.equal(back.person, 'Diane');
  assert.equal(parseProject(serializeProject(project(), '')).project.person ?? null, null);
});
