import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './cli.ts';
import { parseProject, readPlan, writePlan, type PlanTask } from '../packages/work/model.ts';

interface FakeTask { id: string; title: string; status: string; assignee: string | null; tenant: string | null; body: string | null }

/** A throwaway world: knowledge repo, roster (pm/coding/qa active, content proposed), layout, and a fake Hermes that remembers tasks. */
async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'work-cli-'));
  const home = join(dir, 'hermes');
  for (const p of ['pm', 'coding', 'qa']) mkdirSync(join(home, 'profiles', p), { recursive: true });
  const catalog = join(dir, 'catalog');
  mkdirSync(join(catalog, 'marketing'), { recursive: true });
  writeFileSync(join(catalog, 'divisions.json'), JSON.stringify({ divisions: { marketing: {} } }));
  writeFileSync(join(catalog, 'marketing', 'marketing-seo-specialist.md'), '---\nname: SEO Specialist\ndescription: Search engine optimization\nemoji: 🔍\n---\n# SEO\nBody.\n');
  const registryPath = join(dir, 'agents.json');
  const agent = (id: string, portfolios: string[]) => ({ id, profile: id, name: id, role: `${id} role`, managed: false, lanes: [], portfolios });
  writeFileSync(registryPath, JSON.stringify({ catalog: { repo: 'r', commit: 'c', dir: catalog }, agents: [agent('pm', ['micropace', 'ai-thrival']), agent('coding', ['micropace']), agent('qa', ['micropace']), agent('content', ['micropace'])] }));
  const layoutPath = join(dir, 'cockpit.json');
  writeFileSync(layoutPath, JSON.stringify({ boards: { 'micropace-labs': 'micropace', 'ai-thrival': 'ai-thrival' } }));
  const kb = join(dir, 'kb');
  const tasks: FakeTask[] = [];
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') return '';
    if (cmd !== 'hermes') throw new Error('unexpected ' + cmd);
    if (args[0] === 'profile' || args[0] === '-p') { if (args[0] === 'profile' && args[1] === 'create') mkdirSync(join(home, 'profiles', args[2]), { recursive: true }); return ''; }
    const sub = args[3];
    if (sub === 'list') {
      const t = args.indexOf('--tenant');
      return JSON.stringify(tasks.filter((x) => t === -1 || x.tenant === args[t + 1]));
    }
    if (sub === 'create') {
      const val = (flag: string) => args[args.indexOf(flag) + 1];
      const key = val('--idempotency-key');
      const dupe = tasks.find((x) => (x as any).key === key);
      if (dupe) return JSON.stringify(dupe);
      const t: FakeTask & { key: string } = { id: `t_${(tasks.length + 1).toString().padStart(4, '0')}`, title: args[args.length - 1], status: args.includes('--parent') ? 'todo' : 'ready', assignee: val('--assignee'), tenant: val('--tenant'), body: val('--body'), key };
      tasks.push(t);
      return JSON.stringify(t);
    }
    if (sub === 'block' || sub === 'complete' || sub === 'edit' || sub === 'reclaim') {
      const t = tasks.find((x) => x.id === args[4]);
      if (t && sub === 'block') t.status = 'blocked';
      if (t && sub === 'complete') t.status = 'done';
      return '';
    }
    throw new Error('unexpected hermes call: ' + args.join(' '));
  };
  const out: string[] = [];
  const env = { PORTFOLIO_KB: kb, COCKPIT_LAYOUT: layoutPath, AGENTS_REGISTRY: registryPath, HERMES_HOME: home, HERMES_BIN: 'hermes', KB_TEMPLATE: join(process.cwd(), 'kb-template'), WORK_TODAY: '2026-11-01' } as NodeJS.ProcessEnv;
  const cli = (...argv: string[]) => main(argv, env, (s) => out.push(s), run);
  const text = () => out.join('\n');
  const project = (id = 'notice-v1') => parseProject(readFileSync(join(kb, 'micropace', 'projects', `${id}.md`), 'utf8'));
  return { cli, out, text, calls, tasks, kb, home, registryPath, project, clear: () => { out.length = 0; calls.length = 0; } };
}

const PROPOSE = ['project', 'propose', 'micropace', '--id', 'notice-v1', '--outcome', 'Notice → Calendar v1 on a public URL', '--done-when', '12 checks pass', '--done-when', 'rollback documented',
  '--team', 'coding,qa', '--objective', 'O1', '--kr', 'KR1.1', '--deploy-targets', 'preview.example.com'];

const PLAN: PlanTask[] = [
  { key: 'gate', title: 'Day-0 gate', owner: 'coding', lane: 'claude', model: null, provider: null, needs: [], accept: '≥90% correct dates', outward: null, workspace: null, max_runtime: '2h', goal: false },
  { key: 'build', title: 'Build and deploy v1', owner: 'coding', lane: null, model: 'glm-5.3-flash', provider: 'opencode-zen', needs: ['gate'], accept: 'public URL, rollback documented', outward: 'deploy', workspace: 'worktree', max_runtime: '4h', goal: false },
  { key: 'verify', title: 'Verify on the live URL', owner: 'qa', lane: null, model: null, provider: null, needs: ['build'], accept: '12 checks with evidence', outward: null, workspace: null, max_runtime: '2h', goal: false },
];

async function approvedWithPlan(plan = PLAN) {
  const w = await world();
  w.cli(...PROPOSE, '--apply');
  w.cli('project', 'approve', 'notice-v1', '--apply');
  const path = join(w.kb, 'micropace', 'projects', 'notice-v1.md');
  const { project, body } = parseProject(readFileSync(path, 'utf8'));
  const { serializeProject } = await import('../packages/work/model.ts');
  writeFileSync(path, serializeProject(project, writePlan(body, plan)));
  w.clear();
  return w;
}

test('kb init creates the portfolio folders from the template, never overwrites, and is a dry run by default', async () => {
  const w = await world();
  assert.equal(w.cli('kb', 'init', '--portfolio', 'micropace'), 0);
  assert.match(w.text(), /micropace: 5 file\(s\) to create/);
  assert.equal(existsSync(join(w.kb, 'micropace')), false);
  w.cli('kb', 'init', '--portfolio', 'micropace', '--apply');
  assert.ok(existsSync(join(w.kb, 'micropace', 'objectives.md')) && existsSync(join(w.kb, 'micropace', 'projects')));
  assert.ok(w.calls.some((c) => c[0] === 'git' && c.includes('init')));
  writeFileSync(join(w.kb, 'micropace', 'context.md'), 'MY EDITS');
  w.clear();
  w.cli('kb', 'init', '--portfolio', 'micropace', '--apply');
  assert.equal(readFileSync(join(w.kb, 'micropace', 'context.md'), 'utf8'), 'MY EDITS');
  assert.match(w.text(), /complete \(nothing to create\)/);
});

test('objectives: add (with key results), show, review; dry run writes nothing; rolling horizon', async () => {
  const w = await world();
  w.cli('objective', 'add', 'micropace', '--title', 'Ship the first product', '--kr', 'v1 live', '--kr', 'gate ≥ 90%');
  assert.equal(existsSync(join(w.kb, 'micropace', 'objectives.md')), false);
  w.cli('objective', 'add', 'micropace', '--title', 'Ship the first product', '--kr', 'v1 live', '--kr', 'gate ≥ 90%', '--apply');
  w.cli('objective', 'add', 'micropace', '--title', 'Second', '--apply');
  w.clear();
  w.cli('objective', 'show', 'micropace');
  assert.match(w.text(), /micropace — rolling, reviewed 2026-11-01/);
  assert.match(w.text(), /O1 Ship the first product[\s\S]*KR1\.1 v1 live[\s\S]*KR1\.2 gate ≥ 90%[\s\S]*O2 Second/);
  assert.equal(w.cli('objective', 'add', 'nowhere', '--title', 'x'), 1);
});

test('project propose: pm owns, the floor and defaults are applied, errors write nothing', async () => {
  const w = await world();
  assert.equal(w.cli(...PROPOSE), 0);
  assert.match(w.text(), /dry run/);
  assert.equal(existsSync(join(w.kb, 'micropace', 'projects', 'notice-v1.md')), false);
  assert.equal(w.cli(...PROPOSE, '--apply'), 0);
  const { project } = w.project();
  assert.deepEqual([project.status, project.owner, project.tenant, project.timebox, project.approved], ['proposed', 'pm', 'notice-v1', '7d', null]);
  assert.deepEqual(project.charter.team, ['pm', 'coding', 'qa']);
  assert.deepEqual([project.charter.outward.deploy.allowed, project.charter.outward.publish.allowed, project.charter.outward.spend.allowed], [true, 'draft-only', false]);
  assert.ok(project.charter.never.includes('money-movement'));
  assert.equal(w.cli(...PROPOSE, '--apply'), 1); // already exists
  assert.equal(w.cli('project', 'propose', 'micropace', '--id', 'Bad Id', '--outcome', 'x', '--done-when', 'y', '--apply'), 1);
  assert.equal(w.cli('project', 'propose', 'micropace', '--id', 'no-done', '--outcome', 'x', '--apply'), 1); // done_when is required
  assert.equal(existsSync(join(w.kb, 'micropace', 'projects', 'no-done.md')), false);
});

test('approve: the only human gate; proposed → active with a log line; refuses a bad charter or a second approval', async () => {
  const w = await world();
  w.cli(...PROPOSE, '--apply');
  w.clear();
  w.cli('project', 'approve', 'notice-v1');
  assert.equal(w.project().project.status, 'proposed'); // dry run
  assert.equal(w.cli('project', 'approve', 'notice-v1', '--apply'), 0);
  const { project, body } = w.project();
  assert.deepEqual([project.status, project.approved], ['active', '2026-11-01']);
  assert.match(body, /2026-11-01 — charter approved/);
  assert.equal(w.cli('project', 'approve', 'notice-v1', '--apply'), 1);
  assert.match(w.text(), /only a proposed project/);
});

test('approve creates the pre-approved new agents through the agents tool, then activates the project', async () => {
  const w = await world();
  w.cli(...PROPOSE.slice(0, -2), '--new-agent', 'marketing/marketing-seo-specialist:seo:glm-5.3-flash:opencode-zen', '--apply');
  assert.deepEqual(w.project().project.charter.new_agents, [{ slug: 'marketing/marketing-seo-specialist', id: 'seo', model: 'glm-5.3-flash', provider: 'opencode-zen' }]);
  w.clear();
  assert.equal(w.cli('project', 'approve', 'notice-v1', '--apply'), 0, w.text());
  assert.match(w.text(), /new agent seo/);
  assert.ok(w.calls.some((c) => c.join(' ').startsWith('hermes profile create seo --clone')));
  assert.ok(w.calls.some((c) => c.join(' ') === 'hermes -p seo config set model.default glm-5.3-flash'));
  assert.equal(w.project().project.status, 'active');
});

test('plan check: reports errors per rule and passes a good plan', async () => {
  const w = await approvedWithPlan();
  assert.equal(w.cli('plan', 'check', 'notice-v1'), 0, w.text());
  assert.match(w.text(), /plan OK: 3 task\(s\), gate → build → verify/);
  const bad = await approvedWithPlan([{ ...PLAN[0], owner: 'content' }, { ...PLAN[1], outward: 'spend' }]);
  assert.equal(bad.cli('plan', 'check', 'notice-v1'), 1);
  assert.match(bad.text(), /owner "content" is not in charter\.team/);
  assert.match(bad.text(), /outward action "spend" is not allowed/);
});

test('plan apply: dry run creates nothing; apply creates tasks in order with tenant, parents, idempotency key, marker, model and workspace', async () => {
  const w = await approvedWithPlan();
  assert.equal(w.cli('plan', 'apply', 'notice-v1'), 0, w.text());
  assert.equal(w.tasks.length, 0);
  assert.match(w.text(), /gate {2}→ coding {2}\(starts first\)/);
  w.clear();
  assert.equal(w.cli('plan', 'apply', 'notice-v1', '--apply'), 0, w.text());
  assert.deepEqual(w.tasks.map((t) => [t.title, t.assignee, t.tenant, t.status]), [['[notice-v1] Day-0 gate', 'coding', 'notice-v1', 'ready'], ['[notice-v1] Build and deploy v1', 'coding', 'notice-v1', 'todo'], ['[notice-v1] Verify on the live URL', 'qa', 'notice-v1', 'todo']]);
  const create = w.calls.filter((c) => c.includes('create'));
  const build = create[1];
  assert.deepEqual(build.slice(0, 5), ['hermes', 'kanban', '--board', 'micropace-labs', 'create']); // the board mapped to the portfolio
  assert.ok(build.includes('--parent') && build[build.indexOf('--parent') + 1] === 't_0001'); // depends on the real id of "gate"
  assert.equal(build[build.indexOf('--idempotency-key') + 1], 'project:notice-v1:build');
  assert.equal(build[build.indexOf('--max-runtime') + 1], '4h');
  assert.equal(build[build.indexOf('--model') + 1], 'glm-5.3-flash');
  assert.equal(build[build.indexOf('--workspace') + 1], 'worktree');
  assert.equal(build.at(-2), '--'); // the title can never be read as a flag
  assert.match(w.tasks[1].body!, /^\[work:notice-v1:build\]/);
  assert.match(w.tasks[1].body!, /DEPLOY\. Charter targets: preview\.example\.com/);
  const { project, body } = w.project();
  assert.match(project.plan_sha ?? '', /^[0-9a-f]{16}$/);
  assert.match(body, /plan applied: 3 task\(s\) created, 0 already existed/);
});

test('plan apply is idempotent: re-applying creates nothing; a replan adds only the new task', async () => {
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  w.clear();
  assert.equal(w.cli('plan', 'apply', 'notice-v1', '--apply'), 0);
  assert.equal(w.tasks.length, 3);
  assert.equal(w.calls.filter((c) => c.includes('create')).length, 0);
  assert.match(w.text(), /= gate already exists/);
  // the owner replans: one more task
  const path = join(w.kb, 'micropace', 'projects', 'notice-v1.md');
  const { project, body } = parseProject(readFileSync(path, 'utf8'));
  const { serializeProject } = await import('../packages/work/model.ts');
  writeFileSync(path, serializeProject(project, writePlan(body, [...PLAN, { ...PLAN[2], key: 'recheck', title: 'Re-verify', needs: ['verify'] }])));
  w.clear();
  w.cli('plan', 'diff', 'notice-v1');
  assert.match(w.text(), /\+ recheck {2}\(will be created\)[\s\S]*CHANGED since it was applied|CHANGED since it was applied[\s\S]*\+ recheck/);
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  assert.deepEqual(w.tasks.map((t) => t.title).slice(3), ['[notice-v1] Re-verify']);
  assert.equal(w.tasks.length, 4);
});

test('plan apply refuses: unapproved charter, paused project, owner without a Hermes profile, over-large plan', async () => {
  const w = await world();
  w.cli(...PROPOSE, '--apply');
  assert.equal(w.cli('plan', 'apply', 'notice-v1', '--apply'), 1);
  assert.match(w.text(), /charter is not approved yet/);
  const p = await approvedWithPlan();
  p.cli('project', 'pause', 'notice-v1', '--apply'); p.clear();
  assert.equal(p.cli('plan', 'apply', 'notice-v1', '--apply'), 1);
  assert.match(p.text(), /project is paused/);
  const big = await approvedWithPlan(Array.from({ length: 10 }, (_, i) => ({ ...PLAN[0], key: `t${i + 1}`, needs: [] })));
  assert.equal(big.cli('plan', 'apply', 'notice-v1', '--apply'), 1);
  assert.match(big.text(), /10 tasks exceed the charter's max_tasks \(9\)/);
  assert.equal(big.tasks.length, 0);
});

test('plan diff separates plan tasks from stray tasks (e.g. made by the auto-decomposer in the same tenant)', async () => {
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  w.tasks.push({ id: 't_9999', title: 'Decomposed extra', status: 'ready', assignee: 'coding', tenant: 'notice-v1', body: 'no marker' });
  w.clear();
  w.cli('plan', 'diff', 'notice-v1');
  assert.match(w.text(), /= gate {2}\(t_0001, ready\)/);
  assert.match(w.text(), /1 task\(s\) in this tenant were not created from the plan.*t_9999/);
  assert.match(w.text(), /unchanged since it was applied/);
});

test('status flags: waiting charter, too many tasks (the decomposer has no cap), over timebox, untracked work', async () => {
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  for (let i = 0; i < 7; i++) w.tasks.push({ id: `t_x${i}`, title: `extra ${i}`, status: 'ready', assignee: 'coding', tenant: 'notice-v1', body: null });
  w.tasks.push({ id: 't_loose', title: 'ad hoc', status: 'ready', assignee: 'coding', tenant: null, body: null });
  w.clear();
  w.cli('status', 'micropace');
  assert.match(w.text(), /notice-v1 {2,}active {2,}0\/10 done.*OVER max_tasks \(10\/9\)/);
  assert.match(w.text(), /untracked \(no project\): 1 open task/);
  assert.doesNotMatch(w.text(), /OVER timebox/);
  const late = { ...process.env } as NodeJS.ProcessEnv;
  void late;
  const { main: m } = await import('./cli.ts');
  const out: string[] = [];
  m(['status', 'micropace'], { PORTFOLIO_KB: w.kb, COCKPIT_LAYOUT: join(w.kb, '..', 'cockpit.json'), AGENTS_REGISTRY: w.registryPath, HERMES_HOME: w.home, HERMES_BIN: 'hermes', WORK_TODAY: '2026-11-20' } as NodeJS.ProcessEnv, (s) => out.push(s), () => '[]');
  assert.match(out.join('\n'), /OVER timebox/);
  const p = await world();
  p.cli(...PROPOSE, '--apply'); p.clear(); p.cli('status', 'micropace');
  assert.match(p.text(), /charter waiting for your approval/);
});

test('close needs every task done (or --force) and points at the retrospective', async () => {
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  w.clear();
  assert.equal(w.cli('close', 'notice-v1', '--apply'), 1);
  assert.match(w.text(), /3 task\(s\) are not done/);
  for (const t of w.tasks) t.status = 'done';
  assert.equal(w.cli('close', 'notice-v1', '--apply'), 0);
  assert.equal(w.project().project.status, 'done');
  assert.match(w.text(), /retrospective into decisions\.md/);
});

test('pause / resume / cancel move the status and log it; cancelled is final', async () => {
  const w = await approvedWithPlan();
  w.cli('project', 'pause', 'notice-v1', '--apply');
  assert.equal(w.project().project.status, 'paused');
  w.cli('project', 'resume', 'notice-v1', '--apply');
  assert.equal(w.project().project.status, 'active');
  w.cli('project', 'cancel', 'notice-v1', '--apply');
  assert.equal(w.project().project.status, 'cancelled');
  assert.match(w.project().body, /paused[\s\S]*resumed[\s\S]*cancelled/);
  assert.equal(w.cli('project', 'resume', 'notice-v1', '--apply'), 1);
  assert.equal(readPlan(w.project().body)!.length, 3); // the plan survives status changes
});

test('outbox: charter decides; held items need a human release; run executes only ready items through the handler and re-checks', async () => {
  const w = await approvedWithPlan();
  assert.equal(w.cli('outbox', 'submit', 'notice-v1', '--kind', 'deploy', '--target', 'evil.example.com', '--summary', 'x', '--apply'), 0);
  assert.match(w.text(), /denied: "evil.example.com" is not a charter deploy target/);
  w.clear();
  w.cli('outbox', 'submit', 'notice-v1', '--kind', 'deploy', '--target', 'preview.example.com', '--summary', 'v1', '--apply');
  w.cli('outbox', 'submit', 'notice-v1', '--kind', 'publish', '--target', 'blog', '--summary', 'post', '--apply');
  assert.match(w.text(), /ready: deploy to preview.example.com/);
  assert.match(w.text(), /denied: "blog" is not an approved channel/);
  w.clear();
  w.cli('outbox', 'list');
  assert.match(w.text(), /ready\s+deploy\s+preview.example.com/);
  assert.equal(w.cli('outbox', 'release', 'notice-v1-20261101-002', '--apply'), 1); // denied items cannot be released
  w.clear();
  w.cli('outbox', 'run'); // no handler config on this path (OUTBOX_CONFIG unset → repo config, empty) → left ready
  assert.match(w.text(), /no deploy handler|nothing ready/);
});

test('watch: a project over its task cap is paused and its open tasks blocked; dry run changes nothing; resume clears the reason', async () => {
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  for (let i = 0; i < 8; i++) w.tasks.push({ id: `x_${i}`, title: `extra ${i}`, status: 'ready', assignee: 'coding', tenant: 'notice-v1', body: 'no marker' });
  const blocked: string[] = [];
  const env = { PORTFOLIO_KB: w.kb, COCKPIT_LAYOUT: join(w.kb, '..', 'cockpit.json'), AGENTS_REGISTRY: w.registryPath, HERMES_HOME: w.home, HERMES_BIN: 'hermes', WORK_TODAY: '2026-11-01' } as NodeJS.ProcessEnv;
  const out: string[] = [];
  const run = (cmd: string, args: string[]): string => {
    const sub = args[3];
    if (sub === 'list') return JSON.stringify(w.tasks.filter((x) => !args.includes('--tenant') || x.tenant === args[args.indexOf('--tenant') + 1]));
    if (sub === 'runs') return '[]';
    if (sub === 'block') { blocked.push(args[args.length - 2]); return ''; }
    return '';
  };
  assert.equal(main(['watch'], env, (s) => out.push(s), run), 0);
  assert.match(out.join('\n'), /over-scope: 11 tasks/);
  assert.equal(blocked.length, 0);
  assert.equal(w.project().project.status, 'active');
  main(['watch', '--apply'], env, (s) => out.push(s), run);
  assert.ok(blocked.length >= 8);
  const { project, body } = w.project();
  assert.equal(project.status, 'paused');
  assert.match(project.paused_reason ?? '', /over-scope/);
  assert.match(body, /paused by the watchdog/);
  main(['project', 'resume', 'notice-v1', '--apply'], env, (s) => out.push(s), run);
  assert.equal(w.project().project.paused_reason, null);
});

test('repos: every folder in config/projects.json exists under ~/codes, and each belongs to one portfolio', async () => {
  const cfg = JSON.parse(readFileSync(join(process.cwd(), 'config', 'projects.json'), 'utf8')).repos as Record<string, Array<{ id: string; path: string | null }>>;
  const ids = Object.values(cfg).flat().map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of Object.values(cfg).flat() as Array<{ id: string; draft?: { outcome: string; done_when: string[]; priority: number } }>) {
    if (!r.draft) continue;
    assert.ok(r.draft.outcome.length > 20 && r.draft.outcome.length <= 300, r.id);
    assert.ok(r.draft.done_when.length >= 1 && r.draft.done_when.length <= 8 && r.draft.done_when.every((d) => d.length <= 200), r.id);
    assert.ok(r.draft.priority >= 1 && r.draft.priority <= 5, r.id);
  }
  const w = await world();
  assert.equal(w.cli('repos', 'family'), 0);
  assert.match(w.text(), /utility-portal[\s\S]*family-account/);
});

test('project set re-prioritises open tasks; plan edit moves/adds/removes within the checks; projects --json is what Cockpit shows', async () => {
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  const edits: string[][] = [];
  const env = { PORTFOLIO_KB: w.kb, COCKPIT_LAYOUT: join(w.kb, '..', 'cockpit.json'), AGENTS_REGISTRY: w.registryPath, HERMES_HOME: w.home, HERMES_BIN: 'hermes', WORK_TODAY: '2026-11-01', CODES_DIR: w.kb, PROJECTS_CONFIG: join(w.kb, '..', 'none.json') } as NodeJS.ProcessEnv;
  const out: string[] = [];
  const run = (cmd: string, args: string[]): string => {
    if (cmd === 'git') return '';
    if (args[3] === 'list') return JSON.stringify(w.tasks);
    if (args[3] === 'edit') { edits.push(args); return ''; }
    return '';
  };
  const cli = (...a: string[]) => { const c = main(a, env, (s) => out.push(s), run); if (process.env.DBG) console.log(a.join(' '), c, out.splice(0).join('|')); return c; };
  assert.equal(cli('project', 'set', 'notice-v1', '--priority', '9', '--apply'), 1);
  assert.equal(cli('project', 'set', 'notice-v1', '--priority', '1', '--test-cmd', 'npm test', '--apply'), 0);
  assert.equal(edits.length, 3);
  assert.ok(edits.every((e) => e.includes('--priority') && e.includes('50')));
  assert.equal(w.project().project.priority, 1);

  assert.equal(cli('plan', 'edit', 'notice-v1', '--op', 'move', '--key', 'verify', '--to', '9', '--apply'), 1); // out of range
  assert.equal(cli('plan', 'edit', 'notice-v1', '--op', 'move', '--key', 'verify', '--to', '1', '--apply'), 0); // list order is display order; dependencies decide run order
  assert.equal(cli('plan', 'edit', 'notice-v1', '--op', 'move', '--key', 'verify', '--to', '3', '--apply'), 0);
  assert.equal(cli('plan', 'edit', 'notice-v1', '--op', 'remove', '--key', 'gate', '--apply'), 1); // build depends on gate
  assert.equal(cli('plan', 'edit', 'notice-v1', '--op', 'add', '--key', 'docs', '--title', 'Write README', '--owner', 'coding', '--accept', 'README has run steps', '--needs', 'verify', '--apply'), 0);
  assert.equal(cli('plan', 'edit', 'notice-v1', '--op', 'add', '--key', 'bad', '--title', 'x', '--owner', 'nobody', '--accept', 'y', '--apply'), 1); // not in the team
  assert.equal(cli('plan', 'edit', 'notice-v1', '--op', 'set', '--key', 'docs', '--title', 'Write the README', '--apply'), 0);
  assert.deepEqual(readPlan(w.project().body)!.map((t) => t.key), ['gate', 'build', 'verify', 'docs']);
  assert.equal(readPlan(w.project().body)![3].title, 'Write the README');

  out.length = 0;
  cli('projects');
  const rows = JSON.parse(out.find((l) => l.startsWith('['))!);
  assert.equal(rows[0].id, 'notice-v1');
  assert.deepEqual(rows[0].plan.map((t: any) => [t.key, t.status]), [['gate', 'ready'], ['build', 'todo'], ['verify', 'todo'], ['docs', 'not created']]);
});

test('propose without --team starts at pm + qa; coding joins only for code delivery; team can be shrunk after approval but not grown', async () => {
  const w = await world();
  assert.equal(w.cli('project', 'propose', 'micropace', '--id', 'auto-team', '--outcome', 'Agree a study plan', '--done-when', 'plan written', '--apply'), 0);
  assert.deepEqual(w.project('auto-team').project.charter.team, ['pm', 'qa']);
  assert.equal(w.cli('project', 'propose', 'micropace', '--id', 'code-team', '--outcome', 'Ship the app', '--done-when', 'tests green', '--test-cmd', 'npm test', '--apply'), 0);
  assert.deepEqual(w.project('code-team').project.charter.team, ['pm', 'qa', 'coding']);
  assert.equal(w.cli('project', 'set', 'auto-team', '--team', 'pm,qa,coding', '--apply'), 0); // proposed: may grow
  assert.deepEqual(w.project('auto-team').project.charter.team, ['pm', 'qa', 'coding']);
  assert.equal(w.cli('project', 'approve', 'auto-team', '--apply'), 0);
  assert.notEqual(w.cli('project', 'set', 'auto-team', '--team', 'pm,qa,coding,content', '--apply'), 0); // approved: may not grow
  assert.equal(w.cli('project', 'set', 'auto-team', '--team', 'pm,qa', '--apply'), 0);
  assert.deepEqual(w.project('auto-team').project.charter.team, ['pm', 'qa']);
});

test('repo create: a new folder with README, agent notes and a first commit, registered once; refuses existing folders and duplicate ids', async () => {
  const w = await world();
  const codes = join(w.kb, '..', 'codes');
  const cfg = join(w.kb, '..', 'projects.json');
  mkdirSync(codes, { recursive: true });
  writeFileSync(cfg, JSON.stringify({ repos: { micropace: [{ id: 'old', path: 'old' }] } }));
  const env = { PORTFOLIO_KB: w.kb, COCKPIT_LAYOUT: join(w.kb, '..', 'cockpit.json'), AGENTS_REGISTRY: w.registryPath, HERMES_HOME: w.home, HERMES_BIN: 'hermes', WORK_TODAY: '2026-11-01', CODES_DIR: codes, PROJECTS_CONFIG: cfg } as NodeJS.ProcessEnv;
  const out: string[] = []; const gitCalls: string[][] = [];
  const run = (cmd: string, args: string[]) => { gitCalls.push([cmd, ...args]); return ''; };
  const cli = (...a: string[]) => main(a, env, (s) => out.push(s), run);
  const args = ['repo', 'create', 'micropace', '--id', 'photo-notes', '--outcome', 'Turn photos of notes into searchable text', '--done-when', 'OCR works on 10 samples', '--done-when', 'Search finds a phrase', '--test-cmd', 'npm test'];
  assert.equal(cli(...args), 0); // dry run
  assert.equal(existsSync(join(codes, 'photo-notes')), false);
  assert.equal(cli(...args, '--apply'), 0);
  const readme = readFileSync(join(codes, 'photo-notes', 'README.md'), 'utf8');
  assert.match(readme, /^# Photo Notes/);
  assert.match(readme, /- \[ \] OCR works on 10 samples/);
  assert.match(readme, /npm test/);
  assert.match(readFileSync(join(codes, 'photo-notes', 'AGENTS.md'), 'utf8'), /Run `npm test`/);
  assert.ok(existsSync(join(codes, 'photo-notes', '.gitignore')));
  assert.ok(gitCalls.some((g) => g.includes('init')) && gitCalls.some((g) => g.includes('commit')));
  const reg = JSON.parse(readFileSync(cfg, 'utf8')).repos.micropace;
  assert.deepEqual(reg.map((r: any) => r.id), ['old', 'photo-notes']);
  assert.equal(cli(...args, '--apply'), 1); // id already registered
  assert.equal(cli('repo', 'create', 'micropace', '--id', 'old', '--outcome', 'x', '--done-when', 'y', '--apply'), 1);
  mkdirSync(join(codes, 'taken'));
  assert.equal(cli('repo', 'create', 'micropace', '--id', 'taken', '--outcome', 'x', '--done-when', 'y', '--apply'), 1); // folder exists
  assert.equal(cli('repo', 'create', 'micropace', '--id', '../evil', '--outcome', 'x', '--done-when', 'y', '--apply'), 1);
});

test('project edit: only while the charter is proposed; projects --json reports how many finished tasks ran without anyone stepping in', async () => {
  const w = await world();
  w.cli(...PROPOSE, '--apply');
  assert.equal(w.cli('project', 'edit', 'notice-v1', '--outcome', 'A sharper outcome', '--done-when', 'check one', '--done-when', 'check two', '--apply'), 0);
  assert.deepEqual([w.project().project.charter.outcome, w.project().project.charter.done_when], ['A sharper outcome', ['check one', 'check two']]);
  assert.match(readFileSync(join(w.kb, 'micropace', 'projects', 'notice-v1.md'), 'utf8'), /charter edited/);
  w.cli('project', 'approve', 'notice-v1', '--apply');
  assert.equal(w.cli('project', 'edit', 'notice-v1', '--outcome', 'Changed after approval', '--apply'), 1);
  assert.equal(w.project().project.charter.outcome, 'A sharper outcome');

  // two finished tasks: one untouched, one that was blocked and unblocked by a human
  const path = join(w.kb, 'micropace', 'projects', 'notice-v1.md');
  const { project, body } = parseProject(readFileSync(path, 'utf8'));
  const { serializeProject } = await import('../packages/work/model.ts');
  writeFileSync(path, serializeProject(project, writePlan(body, PLAN.slice(0, 2))));
  w.tasks.push({ id: 't_a', title: 'Day-0 gate', status: 'done', assignee: 'coding', tenant: 'notice-v1', body: '[work:notice-v1:gate]\nx' });
  w.tasks.push({ id: 't_b', title: 'Build', status: 'done', assignee: 'coding', tenant: 'notice-v1', body: '[work:notice-v1:build]\nx' });
  const env = { PORTFOLIO_KB: w.kb, COCKPIT_LAYOUT: join(w.kb, '..', 'cockpit.json'), AGENTS_REGISTRY: w.registryPath, HERMES_HOME: w.home, HERMES_BIN: 'hermes', WORK_TODAY: '2026-11-01', CODES_DIR: w.kb, PROJECTS_CONFIG: join(w.kb, '..', 'none.json') } as NodeJS.ProcessEnv;
  const out: string[] = [];
  const run = (cmd: string, args: string[]): string => {
    if (cmd === 'git') return '';
    if (args[3] === 'list') return JSON.stringify(w.tasks);
    if (args[3] === 'show') return JSON.stringify({ events: args[4] === 't_b' ? [{ kind: 'created' }, { kind: 'blocked', payload: { reason: 'needs_input' } }, { kind: 'unblocked' }] : [{ kind: 'created' }, { kind: 'blocked', payload: { reason: 'initial_status' } }] });
    return '';
  };
  main(['projects'], env, (s) => out.push(s), run);
  const row = JSON.parse(out.find((l) => l.startsWith('['))!)[0];
  assert.deepEqual(row.auto, { done: 2, untouched: 1, touched: 1, running: 0, waiting_on_you: 0 });
  assert.deepEqual(row.plan.map((t: any) => [t.key, t.touched]), [['gate', false], ['build', true]]);
  assert.ok(row.log.some((l: string) => /charter edited/.test(l)));
});

test('approve with a note: the note goes into the log and into the context stamped on every task body', async () => {
  const w = await world();
  w.cli(...PROPOSE, '--apply');
  assert.equal(w.cli('project', 'approve', 'notice-v1', '--note', 'Keep it to one page.   Ask me before schema changes.', '--apply'), 0);
  const { project, body } = w.project();
  assert.equal(project.status, 'active');
  assert.match(body, /Approval note from the owner: Keep it to one page\. Ask me before schema changes\./);
  assert.match(body, /charter approved — note: Keep it to one page/);
  const { decisionsOf } = await import('../packages/work/model.ts');
  assert.match(decisionsOf(body), /Ask me before schema changes/);
});

test('advance: after approval the project moves on by itself: pm is asked to plan once, a written plan is applied, finished work goes to review', async () => {
  const w = await world();
  w.cli(...PROPOSE, '--apply');
  w.cli('project', 'approve', 'notice-v1', '--note', 'Keep it small.', '--apply');
  w.clear();
  assert.equal(w.cli('advance'), 0); // dry run
  assert.equal(w.tasks.length, 0);
  assert.equal(w.cli('advance', '--apply'), 0);
  assert.equal(w.tasks.length, 1);
  assert.deepEqual([w.tasks[0].assignee, w.tasks[0].title], ['pm', '[notice-v1] Plan the project']);
  assert.match(w.tasks[0].body!, /^\[plan-for:notice-v1\]/);
  assert.match(w.tasks[0].body!, /Keep it small\./); // the owner's approval note travels with the task
  assert.match(w.tasks[0].body!, /Do not run "plan apply"/);
  w.cli('advance', '--apply');
  assert.equal(w.tasks.length, 1); // pm is working on it: nothing is created twice

  // pm writes the plan into the project file
  const path = join(w.kb, 'micropace', 'projects', 'notice-v1.md');
  const { project, body } = parseProject(readFileSync(path, 'utf8'));
  const { serializeProject } = await import('../packages/work/model.ts');
  writeFileSync(path, serializeProject(project, writePlan(body, PLAN)));
  w.tasks[0].status = 'done';
  w.clear();
  w.cli('advance', '--apply');
  assert.equal(w.tasks.length, 1 + PLAN.length); // the code applied the plan; the tasks exist now
  assert.ok(w.project().project.plan_sha);

  for (const t of w.tasks) t.status = 'done';
  w.clear();
  w.cli('advance', '--apply');
  assert.equal(w.project().project.status, 'review');
  assert.match(w.project().body, /ready for owner review/);
  w.clear();
  w.cli('advance', '--apply');
  assert.match(w.text(), /nothing to do/); // review is the end of the automation; a human closes it
});

test('plan apply gives agents the absolute repo path (they start in a scratch folder, so a relative path is useless)', async () => {
  const w = await approvedWithPlan();
  const { project, body } = parseProject(readFileSync(join(w.kb, 'micropace', 'projects', 'notice-v1.md'), 'utf8'));
  const { serializeProject } = await import('../packages/work/model.ts');
  writeFileSync(join(w.kb, 'micropace', 'projects', 'notice-v1.md'), serializeProject({ ...project, repo: 'frank-iOS/Changes', test_cmd: 'npm test' }, body));
  const codes = join(w.kb, '..', 'codes-x');
  const env = { PORTFOLIO_KB: w.kb, COCKPIT_LAYOUT: join(w.kb, '..', 'cockpit.json'), AGENTS_REGISTRY: w.registryPath, HERMES_HOME: w.home, HERMES_BIN: 'hermes', WORK_TODAY: '2026-11-01', CODES_DIR: codes } as NodeJS.ProcessEnv;
  const made: string[] = [];
  const run = (cmd: string, args: string[]): string => {
    if (args[3] === 'list') return '[]';
    if (args[3] === 'create') { made.push(args[args.indexOf('--body') + 1]); return JSON.stringify({ id: `t_${made.length}` }); }
    return '';
  };
  assert.equal(main(['plan', 'apply', 'notice-v1', '--apply'], env, () => {}, run), 0);
  assert.ok(made.length > 0 && made.every((b) => b.includes(`Repository: ${codes}/frank-iOS/Changes. Check your work with: npm test`)));
});

test('project name: a display name can be set and cleared; the id never changes', async () => {
  const w = await world();
  assert.equal(w.cli('project', 'propose', 'micropace', '--id', 'named', '--outcome', 'x', '--done-when', 'y', '--apply'), 0);
  assert.equal(w.cli('project', 'set', 'named', '--name', 'Pretty Name', '--apply'), 0);
  assert.equal(w.project('named').project.name, 'Pretty Name');
  assert.equal(w.project('named').project.id, 'named');
  assert.equal(w.cli('project', 'set', 'named', '--name', '', '--apply'), 0);
  assert.equal(w.project('named').project.name ?? null, null);
});

test('a step for you: created with no assignee and blocked so no agent claims it; later work needs it; step-done completes it', async () => {
  const human: PlanTask = { ...PLAN[0], key: 'submit', title: 'Fill in App Store Connect and wait for review', owner: 'you', lane: null, accept: 'status is Ready for Sale', outward: null };
  const w = await approvedWithPlan([PLAN[0], human, { ...PLAN[2], key: 'market', title: 'Post-listing marketing', needs: ['submit'], owner: 'qa' }]);
  const rc = w.cli('plan', 'check', 'notice-v1'); if (rc !== 0) console.log(w.text());
  assert.equal(rc, 0);
  const ra = w.cli('plan', 'apply', 'notice-v1', '--apply'); if (ra !== 0) console.log(w.text()); assert.equal(ra, 0);
  const create = w.calls.find((c) => c.includes('create') && c.some((x) => x.includes('App Store Connect')))!;
  assert.ok(!create.includes('--assignee'), 'a human step has no assignee');
  assert.ok(w.calls.some((c) => c.includes('block')), 'and is blocked at once');
  assert.ok(w.calls.find((c) => c.includes('create') && c.some((x) => x.includes('Post-listing')))!.includes('--parent'));
  w.clear();
  assert.notEqual(w.cli('project', 'step-done', 'notice-v1', 'gate', '--apply'), 0); // an agent step is not yours to complete
  assert.equal(w.tasks.find((t) => t.title.includes('App Store Connect'))!.status, 'blocked');
  assert.equal(w.cli('project', 'step-done', 'notice-v1', 'submit', '--note', 'Approved and live', '--apply'), 0);
  assert.equal(w.tasks.find((t) => t.title.includes('App Store Connect'))!.status, 'done');
  assert.match(w.project().body, /your step "submit" done: Approved and live/);
});

test('stop-task: a running task is reclaimed then blocked; a finished one cannot be stopped', async () => {
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  const gate = w.tasks.find((t) => t.title.includes('Day-0 gate'))!;
  gate.status = 'running';
  w.clear();
  assert.equal(w.cli('project', 'stop-task', 'notice-v1', 'gate', '--apply'), 0);
  assert.ok(w.calls.some((c) => c.includes('reclaim')) && w.calls.some((c) => c.includes('block')));
  assert.equal(gate.status, 'blocked');
  gate.status = 'done';
  assert.notEqual(w.cli('project', 'stop-task', 'notice-v1', 'gate', '--apply'), 0);
});
