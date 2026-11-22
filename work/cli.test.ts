import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explainTask, main } from './cli.ts';
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
  const gh: string[][] = [];
  let ghReply: (args: string[]) => string = () => '[]';
  const run = (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') return args.includes('get-url') ? 'https://github.com/Frank-Tao/demo.git\n' : '';
    if (cmd === 'gh') { gh.push(args); return ghReply(args); }
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
    if (sub === 'show') { const t = tasks.find((x) => args.includes(x.id)); return JSON.stringify({ task: t ?? {}, latest_summary: (t as unknown as { summary?: string } | undefined)?.summary ?? '', events: [] }); }
    if (sub === 'assign') { const t = tasks.find((x) => x.id === args[4]); if (t) t.assignee = args[5]; return ''; }
    if (sub === 'unblock') { const t = tasks.find((x) => x.id === args[args.length - 1]); if (t) t.status = 'ready'; return ''; }
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
  const cliEnv = (extra: NodeJS.ProcessEnv, ...argv: string[]) => main(argv, { ...env, ...extra }, (s) => out.push(s), run);
  return { cli, cliEnv, out, text, calls, tasks, kb, home, registryPath, project, gh, setGh: (f: (args: string[]) => string) => { ghReply = f; }, clear: () => { out.length = 0; calls.length = 0; } };
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
  const big = await approvedWithPlan(Array.from({ length: 21 }, (_, i) => ({ ...PLAN[0], key: `t${i + 1}`, needs: [] })));
  assert.equal(big.cli('plan', 'apply', 'notice-v1', '--apply'), 1);
  assert.match(big.text(), /21 active top-level tasks exceed the limit of 20/);
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
  for (let i = 0; i < 18; i++) w.tasks.push({ id: `t_x${i}`, title: `extra ${i}`, status: 'ready', assignee: 'coding', tenant: 'notice-v1', body: null });
  w.tasks.push({ id: 't_loose', title: 'ad hoc', status: 'ready', assignee: 'coding', tenant: null, body: null });
  w.clear();
  w.cli('status', 'micropace');
  assert.match(w.text(), /notice-v1 {2,}active {2,}0\/21 done.*OVER the limit of active tasks \(21\/20\)/);
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
  // done means something to look at: closing asks for what was delivered first
  w.clear();
  assert.equal(w.cli('close', 'notice-v1', '--apply'), 1);
  assert.match(w.text(), /nothing is recorded about what was delivered/);
  assert.equal(w.cli('project', 'deliver', 'notice-v1', '--summary', 'A small reminder app that runs on this Mac.', '--url', 'http://localhost:8000', '--start', 'pnpm dev', '--apply'), 0);
  assert.equal(w.cli('close', 'notice-v1', '--apply'), 0);
  assert.equal(w.project().project.status, 'done');
  assert.match(w.text(), /record what was learned/);
  const { readDelivery } = await import('../packages/work/delivery.ts');
  assert.deepEqual([readDelivery(w.kb, 'micropace', 'notice-v1')?.url, readDelivery(w.kb, 'micropace', 'notice-v1')?.start], ['http://localhost:8000', 'pnpm dev']);
});

test('deliver: a summary is required, the address must be http(s), a repo path needs a GitHub remote, private-looking text is refused; --force still closes', async () => {
  const w = await approvedWithPlan();
  w.clear();
  assert.equal(w.cli('project', 'deliver', 'notice-v1', '--summary', 'short', '--apply'), 1);
  assert.equal(w.cli('project', 'deliver', 'notice-v1', '--summary', 'A reminder app that runs here.', '--url', 'localhost:8000', '--apply'), 1);
  assert.match(w.text(), /http:\/\/ or https:\/\//);
  assert.equal(w.cli('project', 'deliver', 'notice-v1', '--summary', 'A reminder app that runs here.', '--doc', 'Guide|https://example.com/guide', '--apply'), 0);
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  for (const t of w.tasks) t.status = 'done';
  const { rmSync } = await import('node:fs');
  rmSync(join(w.kb, 'micropace', 'delivery'), { recursive: true, force: true });
  assert.equal(w.cli('close', 'notice-v1', '--apply'), 1);
  assert.equal(w.cli('close', 'notice-v1', '--force', '--apply'), 0);
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
  for (let i = 0; i < 18; i++) w.tasks.push({ id: `x_${i}`, title: `extra ${i}`, status: 'ready', assignee: 'coding', tenant: 'notice-v1', body: 'no marker' });
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
  assert.match(out.join('\n'), /over-scope: 21 active tasks/);
  assert.equal(blocked.length, 0);
  assert.equal(w.project().project.status, 'active');
  main(['watch', '--apply'], env, (s) => out.push(s), run);
  assert.ok(blocked.length >= 18);
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

test('retry-task: a blocked task is unblocked with the note recorded; a task that is not blocked is refused', async () => {
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  const gate = w.tasks.find((t) => t.title.includes('Day-0 gate'))!;
  assert.notEqual(w.cli('project', 'retry-task', 'notice-v1', 'gate', '--apply'), 0); // still ready: nothing to retry
  gate.status = 'blocked';
  w.clear();
  assert.equal(w.cli('project', 'retry-task', 'notice-v1', 'gate', '--note', 'No remote: commit locally, skip the PR', '--apply'), 0);
  const call = w.calls.find((c) => c.includes('unblock'))!;
  assert.ok(call.some((a) => a.includes('Retry by Frank: No remote: commit locally, skip the PR')));
  assert.equal(gate.status, 'ready');
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

test('reopen: a review project goes back to proposed (charter needs approval again), needs a reason, cancelled stays final', async () => {
  const w = await approvedWithPlan();
  assert.equal(w.cli('project', 'reopen', 'notice-v1', '--reason', 'x', '--apply'), 1); // active: not reopenable
  const path = join(w.kb, 'micropace', 'projects', 'notice-v1.md');
  const { project, body } = w.project();
  const { serializeProject } = await import('../packages/work/model.ts');
  writeFileSync(path, serializeProject({ ...project, status: 'review' }, body));
  assert.equal(w.cli('project', 'reopen', 'notice-v1', '--apply'), 1); // a reason is required
  assert.equal(w.cli('project', 'reopen', 'notice-v1', '--reason', 'add Android', '--apply'), 0);
  assert.equal(w.project().project.status, 'proposed');
  assert.equal(w.project().project.approved, null);
  assert.match(w.project().body, /reopened: add Android/);
  w.cli('project', 'cancel', 'notice-v1', '--apply');
  assert.equal(w.cli('project', 'reopen', 'notice-v1', '--reason', 'x', '--apply'), 1);
});

test('plan apply refuses to work inside the platform repo unless the project is cockpit-improvement', async () => {
  const core = join(import.meta.dirname, '..');
  const setup = async (repo: string | null) => {
    const w = await approvedWithPlan();
    const { project, body } = parseProject(readFileSync(join(w.kb, 'micropace', 'projects', 'notice-v1.md'), 'utf8'));
    const { serializeProject } = await import('../packages/work/model.ts');
    writeFileSync(join(w.kb, 'micropace', 'projects', 'notice-v1.md'), serializeProject({ ...project, repo }, body));
    return w;
  };
  const env = (w: Awaited<ReturnType<typeof setup>>) => ({ PORTFOLIO_KB: w.kb, COCKPIT_LAYOUT: join(w.kb, '..', 'cockpit.json'), AGENTS_REGISTRY: w.registryPath, HERMES_HOME: w.home, HERMES_BIN: 'hermes', WORK_TODAY: '2026-11-01', CODES_DIR: join(core, '..') } as NodeJS.ProcessEnv);
  const run = (_c: string, args: string[]): string => (args[3] === 'list' ? '[]' : args[3] === 'create' ? JSON.stringify({ id: 't_1' }) : '');
  const out: string[] = [];
  const apply = (w: Awaited<ReturnType<typeof setup>>) => main(['plan', 'apply', 'notice-v1', '--apply'], env(w), (s) => out.push(s), run);

  const viaRepo = await setup(core.split('/').pop()!);
  assert.equal(apply(viaRepo), 1);
  assert.match(out.join('\n'), /platform's own code; only the "cockpit-improvement" project/);
  assert.equal(viaRepo.tasks.length, 0);

  const viaAbsolute = await setup(join(core, 'packages'));
  assert.equal(apply(viaAbsolute), 1);

  // prod runs from another folder (~/services/...): the dev working copy under the codes dir is still the platform's own code
  const codes = join(viaRepo.kb, '..', 'codes');
  const prodLike = await setup('personal-agent-platform');
  const prodEnv = { ...env(prodLike), CODES_DIR: codes };
  const { platformRoots } = await import('./shared.ts');
  assert.ok(platformRoots({ env: prodEnv } as never).includes(join(codes, 'personal-agent-platform')));
  assert.equal(main(['plan', 'apply', 'notice-v1', '--apply'], prodEnv, (s) => out.push(s), run), 1);
  assert.equal(prodLike.tasks.length, 0);
  assert.ok(platformRoots({ env: { ...prodEnv, PAP_DEV_REPO: '/somewhere/else/pap' } } as never).includes('/somewhere/else/pap'));

  const elsewhere = await setup('frank-iOS/Changes');
  assert.equal(apply(elsewhere), 0);
});

test('why: explains a feedback note (and --propose makes it eligible at once) and a kanban task', async () => {
  const w = await world();
  const dir = join(w.kb, '..', 'fbdata');
  const env = { ...process.env, PORTFOLIO_KB: w.kb, COCKPIT_LAYOUT: join(w.kb, '..', 'cockpit.json'), FEEDBACK_DIR: dir, HERMES_BIN: 'hermes' } as NodeJS.ProcessEnv;
  const out: string[] = [];
  const show = JSON.stringify({ task: { id: 't_9', title: '[p] X', status: 'blocked', created_by: 'atlas', body: 'plain' }, parents: [], children: [], events: [], runs: [] });
  const run = (_c: string, args: string[]) => { if (args.includes('show')) return show; throw new Error('no'); };
  assert.equal(main(['feedback', 'add', '--by', 'frank', '--propose', '--text', 'Add a why command', '--apply'], env, (s) => out.push(s), run), 0);
  const id = out.join('\n').match(/fb-\d+-[0-9a-f]+/)![0];
  out.length = 0;
  assert.equal(main(['why', id], env, (s) => out.push(s), run), 0);
  assert.match(out.join('\n'), /now: open[\s\S]*added to be decided now[\s\S]*waits for: the next digest/);
  out.length = 0;
  assert.equal(main(['why', 't_9'], env, (s) => out.push(s), run), 0);
  assert.match(out.join('\n'), /not from a project plan; created by atlas[\s\S]*hop 1/);
});

test('a task whose body lost its [work:] line (rewritten by the auto-decomposer) is still matched to its plan row by its idempotency key', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  const gate = w.tasks.find((t) => t.title.includes('Day-0 gate'))!;
  gate.body = 'Rewritten by the decomposer: no marker here';
  (gate as any).created_by = 'work';
  const dir = join(w.home, 'kanban', 'boards', 'micropace-labs');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'kanban.db'));
  db.exec(`CREATE TABLE tasks (id TEXT, idempotency_key TEXT); INSERT INTO tasks VALUES ('${gate.id}', 'project:notice-v1:gate')`);
  db.close();
  gate.status = 'blocked';
  w.clear();
  assert.equal(w.cli('project', 'retry-task', 'notice-v1', 'gate', '--note', 'go', '--apply'), 0);
  assert.equal(gate.status, 'ready');
});

test('repo create: also makes a private GitHub repo with the folder name; without gh it says so and still succeeds', async () => {
  const w = await world();
  const codes = join(w.kb, '..', 'codes'), cfg = join(w.kb, '..', 'projects.json');   // never the real ~/codes or config/projects.json
  mkdirSync(codes, { recursive: true });
  writeFileSync(cfg, JSON.stringify({ repos: {} }));
  const env = { PORTFOLIO_KB: w.kb, COCKPIT_LAYOUT: join(w.kb, '..', 'cockpit.json'), AGENTS_REGISTRY: w.registryPath, HERMES_HOME: w.home, HERMES_BIN: 'hermes', WORK_TODAY: '2026-11-01', CODES_DIR: codes, PROJECTS_CONFIG: cfg } as NodeJS.ProcessEnv;
  const make = (ghDown: boolean) => {
    const out: string[] = []; const calls: string[][] = [];
    const run = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); if (cmd === 'gh') { if (ghDown) throw new Error('gh: not logged in'); return args[0] === 'api' ? 'Frank-Tao\n' : ''; } return ''; };
    return { out, calls, cli: (...a: string[]) => main(a, env, (s) => out.push(s), run) };
  };
  const base = (id: string) => ['repo', 'create', 'micropace', '--id', id, '--outcome', 'x', '--done-when', 'y'];
  const a = make(false);
  assert.equal(a.cli(...base('twin-app'), '--apply'), 0);
  const create = a.calls.find((c) => c[0] === 'gh' && c[1] === 'repo')!;
  assert.deepEqual(create.slice(1, 4), ['repo', 'create', 'Frank-Tao/twin-app']);
  assert.ok(create.includes('--private') && create.includes('--push'));
  assert.match(a.out.join('\n'), /private GitHub repo Frank-Tao\/twin-app created/);
  const b = make(true);
  assert.equal(b.cli(...base('solo-app'), '--apply'), 0);
  assert.match(b.out.join('\n'), /GitHub repo not created: gh is not logged in/);
  const c = make(false);
  assert.equal(c.cli(...base('priv-app'), '--no-github', '--apply'), 0);
  assert.ok(!c.calls.some((x) => x[0] === 'gh'));
});

test('retry-task --task: a blocked step created by the auto-decomposer (no plan key) can be retried; one from another project cannot', async () => {
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  const gate = w.tasks.find((t) => t.title.includes('Day-0 gate'))!;
  gate.status = 'blocked';
  w.clear();
  assert.equal(w.cli('project', 'retry-task', 'notice-v1', '-', '--task', gate.id, '--note', 'merge is authorized', '--apply'), 0);
  assert.equal(gate.status, 'ready');
  assert.notEqual(w.cli('project', 'retry-task', 'notice-v1', '-', '--task', 't_nope0000', '--apply'), 0);
});

test('explainTask: a worker that crashed twice in a row says so and where to look; otherwise the last run summary; nothing recorded gives null', () => {
  const ctx = (show: object | null) => ({ hermesBin: 'hermes', run: () => { if (!show) throw new Error('down'); return JSON.stringify(show); } }) as any;
  const task = { id: 't_1', assignee: 'research' } as any;
  const crashed = explainTask(ctx({ runs: [{ outcome: 'blocked', summary: 'old' }, { outcome: 'crashed', error: 'kanban_skills_unavailable' }, { outcome: 'crashed', error: 'kanban_skills_unavailable' }] }), 'research', task)!;
  assert.equal(crashed.crashes, 2);
  assert.match(crashed.text, /crashed 2 runs in a row.*kanban_skills_unavailable.*profiles\/research\/logs\/managed-worker\.log/);
  assert.equal(explainTask(ctx({ latest_summary: 'Needs the remote URL', runs: [{ outcome: 'blocked' }] }), 'research', task)!.text, 'Needs the remote URL');
  assert.equal(explainTask(ctx({ runs: [], events: [{ kind: 'blocked', payload: { reason: 'needs_input' } }] }), 'research', task)!.text, 'needs_input');
  assert.equal(explainTask(ctx(null), 'research', task), null);
});

test('decisions: approving, changing settings and closing record themselves; decision add/list/confirm/reject work through the CLI; the brief carries them', async () => {
  const { readDecisions } = await import('../packages/work/decisions.ts');
  const w = await world();
  w.cli(...PROPOSE, '--apply');
  assert.equal(w.cli('project', 'approve', 'notice-v1', '--note', 'Keep it to one page.', '--by', 'Frank', '--apply'), 0);
  let rows = readDecisions(w.kb, { project: 'notice-v1' });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].status, rows[0].by, rows[0].source, rows[0].why], ['active', 'Frank', 'approval', 'Keep it to one page.']);
  assert.match(rows[0].title, /^Charter approved: /);
  w.cli('project', 'approve', 'notice-v1', '--apply');                                       // approving again does not duplicate it
  assert.equal(readDecisions(w.kb, { project: 'notice-v1' }).length, 1);

  assert.equal(w.cli('project', 'set', 'notice-v1', '--priority', '1', '--reason', 'launch moved up', '--by', 'Frank', '--apply'), 0);
  assert.match(readDecisions(w.kb, { project: 'notice-v1' })[0].title, /^Project settings changed: priority 3→1/);

  // dry run writes nothing
  const before = readDecisions(w.kb, { project: 'notice-v1' }).length;
  assert.equal(w.cli('decision', 'add', 'notice-v1', '--title', 'Use SwiftUI for the player', '--by', 'coding'), 0);
  assert.equal(readDecisions(w.kb, { project: 'notice-v1' }).length, before);
  assert.equal(w.cli('decision', 'add', 'notice-v1', '--title', 'Use SwiftUI for the player', '--why', 'faster', '--by', 'coding', '--source', 'task t_ab12cd34', '--status', 'proposed', '--apply'), 0);
  assert.equal(w.cli('decision', 'add', 'notice-v1', '--title', 'Which region do we launch in first?', '--question', '--by', 'pm', '--apply'), 0);
  rows = readDecisions(w.kb, { project: 'notice-v1' });
  const proposal = rows.find((r) => r.status === 'proposed')!;
  assert.equal(proposal.ref, 'micropace/notice-v1/D3');
  assert.notEqual(w.cli('decision', 'add', 'notice-v1', '--title', 'My tax file number is 123 456 782', '--apply'), 0, 'private text is refused');

  w.clear();
  assert.equal(w.cli('brief', 'notice-v1'), 0);
  const brief = w.out.join('\n');
  assert.match(brief, /PROJECT BRIEF · notice-v1 \(micropace\)/);
  assert.match(brief, /Decisions in force[\s\S]*\n- D2 [^\n]*Project settings changed[\s\S]*\n- D1 [^\n]*Charter approved/);
  assert.match(brief, /Proposed, NOT confirmed[^\n]*\n- D3 [^\n]*Use SwiftUI for the player/);
  assert.match(brief, /Open questions[^\n]*\n- D4 [^\n]*Which region/);

  assert.equal(w.cli('decision', 'confirm', proposal.ref, '--by', 'Frank', '--apply'), 0);
  assert.equal(readDecisions(w.kb, { project: 'notice-v1' }).find((r) => r.n === 3)!.status, 'active');
  assert.notEqual(w.cli('decision', 'reject', proposal.ref, '--apply'), 0, 'an active decision cannot be rejected');
  w.clear();
  assert.equal(w.cli('decision', 'list', 'notice-v1', '--status', 'active', '--json'), 0);
  assert.equal((JSON.parse(w.out.find((l) => l.startsWith('['))!) as unknown[]).length, 4, 'two decisions, one confirmed proposal, one open question');
});

test('harvest: decisions and open questions in a finished task\'s hand-off become proposals and open questions, once, and the task body asks for them', async () => {
  const { readDecisions } = await import('../packages/work/decisions.ts');
  const { renderTaskBody } = await import('../packages/work/model.ts');
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  const gate = w.tasks.find((t) => t.title.includes('Day-0 gate'))!;
  assert.match(gate.body ?? '', /npm run work -- brief notice-v1/, 'every task starts from the brief');
  assert.match(gate.body ?? '', /`Decisions:` section/, 'and says how to hand decisions over');
  assert.match(renderTaskBody(w.project().project, { key: 'x', title: 'X', owner: 'coding', lane: null, model: null, provider: null, needs: [], accept: 'ok', outward: null, workspace: null, max_runtime: '1h', goal: false } as never, '', [], true), /Before you start, read the project brief/);

  gate.status = 'done';
  (gate as unknown as { completed_at: number; summary: string }).completed_at = Date.parse('2026-11-01T01:00:00Z') / 1000;
  (gate as unknown as { summary: string }).summary = 'Built it.\n\nDecisions:\n- Use SwiftUI for the player view — faster to ship\n- Skip the iPad layout for v1\n\nOpen questions:\n- Which store region first?\n';
  w.clear();
  assert.equal(w.cli('decision', 'harvest'), 0);                                                 // dry run
  const baseline = readDecisions(w.kb, { project: 'notice-v1' }).length;                        // the charter approval is already in
  assert.equal(baseline, 1);
  assert.match(w.text(), /would record proposal "Use SwiftUI for the player view"/);
  assert.equal(w.cli('decision', 'harvest', '--apply'), 0);
  const rows = readDecisions(w.kb, { project: 'notice-v1' }).filter((r) => r.source?.startsWith('harvest')).sort((a, b) => a.n - b.n);
  assert.deepEqual(rows.map((r) => [r.title, r.status, r.kind, r.by, r.source]), [
    ['Use SwiftUI for the player view', 'proposed', 'decision', gate.assignee, `harvest ${gate.id}`],
    ['Skip the iPad layout for v1', 'proposed', 'decision', gate.assignee, `harvest ${gate.id}`],
    ['Which store region first?', 'active', 'question', gate.assignee, `harvest ${gate.id}`],
  ]);
  assert.equal(rows[0].why, 'faster to ship');
  assert.equal(rows[0].date, '2026-11-01');
  w.cli('decision', 'harvest', '--apply');                                                       // again: nothing new
  assert.equal(readDecisions(w.kb, { project: 'notice-v1' }).length, baseline + 3);
  // a task finished long ago is left alone
  (gate as unknown as { completed_at: number }).completed_at = Date.parse('2025-01-01T00:00:00Z') / 1000;
  assert.match((w.clear(), w.cli('decision', 'harvest', '--days', '14'), w.text()), /harvest: 0 finished task/);
});

test('project set --max-tasks: any whole number from 1 to 20, recorded as a decision; nothing else is accepted', async () => {
  const { readDecisions } = await import('../packages/work/decisions.ts');
  const w = await approvedWithPlan();
  assert.equal(w.cli('project', 'set', 'notice-v1', '--max-tasks', '12', '--reason', 'bigger project', '--by', 'Frank', '--apply'), 0, w.text());
  assert.equal(w.project().project.charter.max_tasks, 12);
  assert.match(w.project().body, /active-task limit 20→12/);
  assert.match(readDecisions(w.kb, { project: 'notice-v1' })[0].title, /active-task limit 20→12/);
  for (const bad of ['0', '21', 'abc', '2.5']) assert.notEqual(w.cli('project', 'set', 'notice-v1', '--max-tasks', bad, '--apply'), 0, bad);
  assert.equal(w.project().project.charter.max_tasks, 12);
});

test('plan regroup: over the limit, prerequisites become subtasks on the board (body and link) and in the plan; the project is then within its limit; running work is left alone', async () => {
  const chain: PlanTask[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((k, i, all) => ({ ...PLAN[0], key: k, title: `Step ${k}`, needs: i ? [all[i - 1]] : [], lane: null, outward: null }));
  const w = await approvedWithPlan(chain);
  assert.equal(w.cli('project', 'set', 'notice-v1', '--max-tasks', '3', '--apply'), 0);
  assert.equal(w.cli('plan', 'apply', 'notice-v1', '--apply'), 1, 'six active tasks are over a limit of three');
  assert.match(w.text(), /6 active top-level tasks exceed the limit of 3.*plan regroup notice-v1/);
  assert.equal(w.tasks.length, 0);

  // a dry run only says what it would do
  w.clear();
  assert.equal(w.cli('plan', 'regroup', 'notice-v1', '--headroom', '0'), 0, w.text());
  assert.match(w.text(), /6 active top-level task\(s\), limit 3/);
  assert.match(w.text(), /dry run/);
  assert.ok(!w.project().body.includes('parent:'), 'nothing written');

  // applied before any task exists: the plan is regrouped, and the next apply creates tasks in the right shape
  w.clear();
  assert.equal(w.cli('plan', 'regroup', 'notice-v1', '--headroom', '0', '--apply'), 0, w.text());
  const { readPlan } = await import('../packages/work/model.ts');
  const plan = readPlan(w.project().body)!;
  assert.ok(plan.filter((t) => !t.parent).length <= 3, 'at most three top-level tasks');
  assert.ok(plan.some((t) => t.parent));
  assert.match(w.project().body, /regrouped: .* under .* \(6 → \d active\)/);
  assert.equal(w.cli('plan', 'check', 'notice-v1'), 0, w.text());
  assert.equal(w.cli('plan', 'apply', 'notice-v1', '--apply'), 0, w.text());
  const subs = w.tasks.filter((t) => /Subtask of:/.test(t.body ?? ''));
  assert.equal(subs.length, plan.filter((t) => t.parent).length, 'the subtasks carry the Subtask line, so the watchdog does not count them');
  w.clear();
  assert.equal(w.cli('status', 'micropace'), 0);
  assert.doesNotMatch(w.text(), /OVER the limit of active tasks/);
  assert.equal(w.cli('plan', 'regroup', 'notice-v1', '--headroom', '0'), 0);
  assert.match(w.text(), /nothing to group|no safe grouping/);
});

test('plan regroup on a project whose tasks already exist: the Hermes tasks are edited and linked; a running task is not touched', async () => {
  const chain: PlanTask[] = ['a', 'b', 'c', 'd'].map((k, i, all) => ({ ...PLAN[0], key: k, title: `Step ${k}`, needs: i ? [all[i - 1]] : [], lane: null, outward: null }));
  const w = await approvedWithPlan(chain);
  assert.equal(w.cli('plan', 'apply', 'notice-v1', '--apply'), 0);                      // four tasks on the board
  assert.equal(w.cli('project', 'set', 'notice-v1', '--max-tasks', '2', '--apply'), 0);
  const before = w.project().body;
  const idOf = (k: string) => w.tasks.find((t) => (t.body ?? '').includes(`[work:notice-v1:${k}]`))!.id;
  w.tasks.find((t) => t.id === idOf('b'))!.status = 'running';                           // b is being worked on: it stays top-level
  // a limit of two cannot be reached with b running: it says so and writes nothing, rather than leaving a plan that fails its own check
  w.clear();
  assert.equal(w.cli('plan', 'regroup', 'notice-v1', '--headroom', '0', '--apply'), 1);
  assert.match(w.text(), /still above the target/);
  assert.equal(w.project().body, before, 'nothing written');
  assert.ok(!w.calls.some((c) => c.includes('link')));
  // a limit of three can: c becomes a subtask of d, b is untouched
  assert.equal(w.cli('project', 'set', 'notice-v1', '--max-tasks', '3', '--apply'), 0);
  w.clear();
  assert.equal(w.cli('plan', 'regroup', 'notice-v1', '--headroom', '0', '--apply'), 0, w.text());
  const edits = w.calls.filter((c) => c.includes('edit') && c.includes('--body')).map((c) => c[c.indexOf('edit') + 1]);
  assert.ok(!edits.includes(idOf('b')), 'a running task is never rewritten');
  const links = w.calls.filter((c) => c.includes('link')).map((c) => c.slice(c.indexOf('link') + 1).join('>'));
  for (const l of links) { const [child, parent] = l.split('>'); assert.ok(edits.includes(child) && edits.includes(parent), 'the subtask and its parent are rewritten'); assert.notEqual(child, idOf('b')); assert.notEqual(parent, idOf('b')); }
  const { readPlan: rp } = await import('../packages/work/model.ts');
  const plan = rp(w.project().body)!;
  assert.ok(!plan.some((t) => t.key === 'b' && t.parent) && !plan.some((t) => t.parent === 'b'), 'b is neither a subtask nor a parent');
});

test('automation levels: a full-automation charter starts by itself after the grace window, closes itself once QA is done, and confirms agents\' decisions the next day; semi and charters that deploy wait for you', async () => {
  const w = await world();
  const at = (iso: string, day: string, ...argv: string[]) => w.cliEnv({ WORK_NOW: iso, WORK_TODAY: day }, ...argv);
  const FULL = ['project', 'propose', 'micropace', '--id', 'inner-v1', '--outcome', 'Internal notes tool', '--done-when', 'tests pass', '--team', 'coding,qa'];
  assert.equal(at('2026-11-01T08:00:00Z', '2026-11-01', ...FULL, '--autonomy', 'full', '--apply'), 0, w.text());
  assert.match(w.text(), /starts by itself at 2026-11-01T12:00:00.000Z/);
  assert.equal(w.project('inner-v1').project.auto_start_after, '2026-11-01T12:00:00.000Z');
  at('2026-11-01T08:00:00Z', '2026-11-01', ...PROPOSE, '--apply');                     // semi, and it deploys
  at('2026-11-01T08:00:00Z', '2026-11-01', 'project', 'set', 'notice-v1', '--autonomy', 'full', '--apply');
  assert.match(w.text(), /these still need you: it deploys/);

  w.clear();
  at('2026-11-01T11:59:00Z', '2026-11-01', 'advance', '--apply');                      // inside the window: nothing starts
  assert.equal(w.project('inner-v1').project.status, 'proposed');
  at('2026-11-01T12:01:00Z', '2026-11-01', 'advance', '--apply');
  assert.equal(w.project('inner-v1').project.status, 'active');
  assert.equal(w.project('notice-v1').project.status, 'proposed', 'a charter that deploys is never started by automation');
  assert.match(w.project('inner-v1').body, /Started by full automation/);

  // the plan has a QA step; when every task is done the project closes itself
  const path = join(w.kb, 'micropace', 'projects', 'inner-v1.md');
  const { project, body } = parseProject(readFileSync(path, 'utf8'));
  const { serializeProject } = await import('../packages/work/model.ts');
  const plan: PlanTask[] = [{ ...PLAN[0], key: 'build', outward: null }, { ...PLAN[2], key: 'verify', needs: ['build'] }];
  writeFileSync(path, serializeProject(project, writePlan(body, plan)));
  for (const t of w.tasks) t.status = 'done';
  at('2026-11-01T12:10:00Z', '2026-11-01', 'advance', '--apply');                      // applies the plan
  for (const t of w.tasks) t.status = 'done';
  w.clear();
  // without a record of what was delivered, full automation does not close it: it waits for the owner
  at('2026-11-01T12:15:00Z', '2026-11-01', 'advance');
  assert.doesNotMatch(w.text(), /closing \(full automation\)/);
  w.cli('project', 'deliver', 'inner-v1', '--summary', 'The inner app, running on this Mac.', '--apply');
  w.clear();
  at('2026-11-01T12:20:00Z', '2026-11-01', 'advance', '--apply');
  assert.match(w.text(), /QA verified it; closing \(full automation\)/);
  assert.equal(w.project('inner-v1').project.status, 'done');

  // agents' proposed decisions: confirmed the next day on full, left alone on semi
  const { addDecision: addD, readDecisions } = await import('../packages/work/decisions.ts');
  writeFileSync(path, serializeProject({ ...w.project('inner-v1').project, status: 'active' }, w.project('inner-v1').body));
  addD(w.kb, { portfolio: 'micropace', project: 'inner-v1', title: 'Use SQLite', by: 'coding', date: '2026-11-01', status: 'proposed' } as never);
  addD(w.kb, { portfolio: 'micropace', project: 'inner-v1', title: 'Which font?', by: 'coding', date: '2026-11-01', kind: 'question' } as never);
  addD(w.kb, { portfolio: 'micropace', project: 'notice-v1', title: 'Use Swift', by: 'coding', date: '2026-11-01', status: 'proposed' } as never);
  at('2026-11-01T20:00:00Z', '2026-11-01', 'advance', '--apply');
  assert.equal(readDecisions(w.kb, { project: 'inner-v1', status: 'proposed' }).length, 1, 'same day: the owner still has time');
  const qBefore = readDecisions(w.kb, { project: 'inner-v1', kind: 'question' })[0];
  at('2026-11-02T08:00:00Z', '2026-11-02', 'advance', '--apply');
  assert.equal(readDecisions(w.kb, { project: 'inner-v1', status: 'proposed' }).length, 0, w.text() + JSON.stringify(readDecisions(w.kb, { project: 'inner-v1' })));
  assert.equal(readDecisions(w.kb, { project: 'inner-v1', status: 'active' }).find((d) => d.title === 'Use SQLite')?.by, 'coding');
  assert.deepEqual(readDecisions(w.kb, { project: 'inner-v1', kind: 'question' })[0], qBefore, 'a question is never answered by automation');
  assert.equal(readDecisions(w.kb, { project: 'notice-v1', status: 'proposed' }).length, 1, 'notice-v1 is blocked from full automation: its decisions wait');

  // switching back to semi clears the window
  at('2026-11-02T08:00:00Z', '2026-11-02', ...FULL.map((x) => x === 'inner-v1' ? 'inner-v2' : x), '--autonomy', 'full', '--apply');
  at('2026-11-02T08:00:00Z', '2026-11-02', 'project', 'set', 'inner-v2', '--autonomy', 'semi', '--apply');
  assert.equal(w.project('inner-v2').project.autonomy, undefined);
  at('2026-11-03T08:00:00Z', '2026-11-03', 'advance', '--apply');
  assert.equal(w.project('inner-v2').project.status, 'proposed');
  assert.equal(at('2026-11-03T08:00:00Z', '2026-11-03', 'project', 'set', 'inner-v2', '--autonomy', 'yolo'), 1);
});

test('work act: a reply code approves a charter once, even from inside Atlas; without a code an agent is refused; "not now" snoozes; every answer is audited', async () => {
  const w = await world();
  const { issueCode, readSnoozes } = await import('../packages/needs/needs.ts');
  const data = join(w.kb, '..', 'pap-data');
  const ENV = { PAP_DATA_DIR: data };
  w.cliEnv(ENV, ...PROPOSE, '--apply');
  w.cliEnv(ENV, 'project', 'propose', 'micropace', '--id', 'second-v1', '--outcome', 'Second', '--done-when', 'ok', '--team', 'coding,qa', '--apply');
  const code = issueCode(data, { kind: 'approve-charter', project: 'notice-v1' }, 'Approve notice-v1');
  w.clear();
  assert.equal(w.cliEnv({ ...ENV, HERMES_SESSION_KEY: 'atlas-telegram' }, 'act', code, 'yes', '--via', 'telegram'), 0, w.text());
  assert.equal(w.project().project.status, 'active');
  assert.match(w.text(), /✓ done: approve — Approve notice-v1/);
  assert.ok(w.tasks.some((t) => t.title === '[notice-v1] Plan the project'), 'pm is asked to plan straight away');
  assert.equal(w.cliEnv({ ...ENV, HERMES_SESSION_KEY: 'x' }, 'act', code, 'yes'), 1, 'a code works once');

  assert.equal(w.cliEnv({ ...ENV, HERMES_SESSION_KEY: 'x' }, 'act', '--kind', 'approve-charter', '--project', 'second-v1', '--answer', 'yes', '--by', 'Frank', '--apply'), 1);
  assert.match(w.text(), /only with a reply code/);
  assert.equal(w.project('second-v1').project.status, 'proposed');
  assert.equal(w.cliEnv(ENV, 'act', '--kind', 'approve-charter', '--project', 'second-v1', '--answer', 'no', '--by', 'Frank', '--via', 'cockpit', '--apply'), 0);
  assert.ok(readSnoozes(data)['approve-charter:second-v1']);
  assert.equal(w.project('second-v1').project.status, 'proposed');
  const audit = readFileSync(join(data, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(audit.map((a) => [a.who, a.device, a.action, a.ok]), [['Frank', 'telegram', 'act.approve-charter.yes', true], ['Frank', 'cli', 'act.code', false], ['Frank', 'cockpit', 'act.approve-charter.no', true]]);
});

test('portfolio default automation: new projects pick it up; making full the default is refused from inside an agent', async () => {
  const w = await world();
  const ENV = { AUTOMATION_CONFIG: join(w.kb, '..', 'automation.json') };
  assert.equal(w.cliEnv({ ...ENV, HERMES_SESSION_KEY: 'x' }, 'automation', 'default', 'micropace', 'full', '--apply'), 1);
  assert.equal(w.cliEnv(ENV, 'automation', 'default', 'micropace', 'full', '--by', 'Frank', '--apply'), 0, w.text());
  w.clear(); w.cliEnv(ENV, 'automation', 'show', '--json');
  assert.equal(JSON.parse(w.text()).micropace, 'full');
  w.cliEnv(ENV, 'project', 'propose', 'micropace', '--id', 'auto-one', '--outcome', 'A', '--done-when', 'ok', '--team', 'coding,qa', '--apply');
  assert.equal(w.project('auto-one').project.autonomy, 'full');
  w.cliEnv(ENV, 'project', 'propose', 'micropace', '--id', 'auto-two', '--outcome', 'B', '--done-when', 'ok', '--team', 'coding,qa', '--autonomy', 'semi', '--apply');
  assert.equal(w.project('auto-two').project.autonomy, undefined, 'asking for semi overrides the default');
});

test('work assign: gives a task its owner, releases it if it waited for one, and records why; the plan keeps pm\'s one-line reason', async () => {
  const w = await world();
  const data = join(w.kb, '..', 'pap-data');
  w.tasks.push({ id: 't_9001', title: 'Fix the import', status: 'blocked', assignee: null, tenant: null, body: '' });
  const A = (...a: string[]) => w.cliEnv({ PAP_DATA_DIR: data }, 'assign', '--board', 'micropace-labs', ...a);
  assert.equal(A('t_9001', 'coding', '--why', 'short', '--by', 'atlas', '--apply'), 1);
  assert.equal(A('t_9001', 'nobody', '--why', 'a long enough reason', '--by', 'atlas', '--apply'), 1);
  assert.equal(A('t_9001', 'coding', '--why', 'Swift import code; coding has the best record here', '--by', 'atlas', '--apply'), 0, w.text());
  assert.deepEqual([w.tasks[0].assignee, w.tasks[0].status], ['coding', 'ready']);
  const { readStaffing } = await import('../packages/work/scorecard.ts');
  assert.deepEqual(readStaffing(data).map((r) => [r.task, r.agent, r.by, r.why]), [['t_9001', 'coding', 'atlas', 'Swift import code; coding has the best record here']]);
  const plan = writePlan('## Plan\n', [{ ...PLAN[0], why: 'coding:   owns   the Swift code' }]);
  assert.equal(readPlan(plan)![0].why, 'coding: owns the Swift code');
  assert.equal(readPlan(writePlan('## Plan\n', [PLAN[0]]))![0].why, undefined);
});

test('delegated approval: Frank names an approver; it reviews from its own review task, never its own request; merges happen only when every check is green', async () => {
  const w = await world();
  const data = join(w.kb, '..', 'pap-data');
  const E = { PAP_DATA_DIR: data, AUDIT_LOG: join(data, 'audit.jsonl') };
  w.cliEnv(E, 'project', 'propose', 'micropace', '--id', 'tracker-v1', '--outcome', 'Tracker', '--done-when', 'ok', '--team', 'coding,qa', '--apply');
  w.cliEnv(E, 'project', 'approve', 'tracker-v1', '--apply');
  const PR = 'https://github.com/Frank-Tao/demo/pull/3';
  // no approver yet: a merge waits for Frank
  w.clear(); w.cliEnv(E, 'outbox', 'submit', 'tracker-v1', '--kind', 'merge', '--target', 'https://github.com/Frank-Tao/demo/pull/2', '--summary', 'tests green', '--apply');
  assert.match(w.text(), /held: a merge into main: waits for your yes/);
  // an agent cannot make itself (or anyone) an approver
  assert.equal(w.cliEnv({ ...E, HERMES_SESSION_KEY: 'x' }, 'project', 'set', 'tracker-v1', '--approver', 'qa', '--delegate', 'merge', '--apply'), 1);
  assert.equal(w.cliEnv(E, 'project', 'set', 'tracker-v1', '--delegate', 'merge,spend', '--approver', 'qa', '--apply'), 1, 'spending cannot be delegated');
  assert.equal(w.cliEnv(E, 'project', 'set', 'tracker-v1', '--approver', 'qa', '--delegate', 'merge,access', '--by', 'Frank', '--apply'), 0, w.text());
  assert.deepEqual([w.project('tracker-v1').project.approver, w.project('tracker-v1').project.delegate], ['qa', ['merge', 'access']]);

  // coding asks for a merge from inside its task; qa gets a review task
  w.tasks.push({ id: 't_7001', title: 'build', status: 'running', assignee: 'coding', tenant: 'tracker-v1', body: 'build it' });
  const asCoding = { ...E, HERMES_SESSION_KEY: 's', HERMES_KANBAN_TASK: 't_7001', HERMES_KANBAN_BOARD: 'micropace-labs' };
  w.clear(); w.cliEnv(asCoding, 'outbox', 'submit', 'tracker-v1', '--kind', 'merge', '--target', PR, '--summary', 'tests 37/37', '--apply');
  assert.match(w.text(), /waits for qa's review \(delegated by Frank\) \(review task t_\d+ for qa\)/);
  const review = w.tasks.find((t) => t.title.startsWith('[tracker-v1] Review: merge'))!;
  assert.equal(review.assignee, 'qa');
  const id = review.body!.match(/\[approve:([a-z0-9-]+)\]/)![1];
  const asQa = (task: string) => ({ ...E, HERMES_SESSION_KEY: 's', HERMES_KANBAN_TASK: task, HERMES_KANBAN_BOARD: 'micropace-labs' });
  // wrong caller, wrong task, no reason: refused
  assert.equal(w.cliEnv(asCoding, 'outbox', 'release', id, '--why', 'it is all good to me', '--apply'), 1);
  w.tasks.push({ id: 't_7002', title: 'other', status: 'running', assignee: 'qa', tenant: 'tracker-v1', body: 'something else' });
  assert.equal(w.cliEnv(asQa('t_7002'), 'outbox', 'release', id, '--why', 'checked the diff and checks', '--apply'), 1);
  assert.equal(w.cliEnv(asQa(review.id), 'outbox', 'release', id, '--why', 'ok', '--apply'), 1);
  w.clear();
  assert.equal(w.cliEnv(asQa(review.id), 'outbox', 'release', id, '--why', 'diff matches the task; 3 checks green; no data files', '--apply'), 0, w.text());
  const { readDecisions } = await import('../packages/work/decisions.ts');
  assert.ok(readDecisions(w.kb, { project: 'tracker-v1' }).some((d) => d.by === 'qa' && /Approved on Frank's behalf: merge/.test(d.title)), w.text() + JSON.stringify(readDecisions(w.kb, { project: 'tracker-v1' }).map((d) => [d.by, d.title])));
  // the platform merges only with every check green
  w.setGh((a) => a[1] === 'view' ? JSON.stringify({ state: 'OPEN', baseRefName: 'main', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }) : '');
  w.clear(); w.cliEnv(E, 'outbox', 'run', '--apply');
  assert.ok(!w.gh.some((a) => a[1] === 'merge'));
  const { allOutbox } = await import('./commands/outbox.ts');
  void allOutbox;
  // a request for a secret is refused outright; a variable goes to the approver
  w.clear(); w.cliEnv(asCoding, 'outbox', 'submit', 'tracker-v1', '--kind', 'access', '--target', 'github-secret:VERCEL_TOKEN', '--value', 'x', '--summary', 'y', '--apply');
  assert.match(w.text(), /denied: secrets are set by Frank only/);
  // a deploy is not delegated here: denied by the charter as before
  w.clear(); w.cliEnv(asCoding, 'outbox', 'submit', 'tracker-v1', '--kind', 'deploy', '--target', 'vercel', '--summary', 'y', '--apply');
  assert.match(w.text(), /denied: the charter does not allow deploys/);
});

test('work ci: a workflow failing on main becomes one fix task with its log; none while one is open; green main is quiet', async () => {
  const w = await world();
  w.cli('project', 'propose', 'micropace', '--id', 'tracker-v2', '--outcome', 'Tracker', '--done-when', 'ok', '--team', 'coding,qa', '--apply');
  w.cli('project', 'approve', 'tracker-v2', '--apply');
  const path = join(w.kb, 'micropace', 'projects', 'tracker-v2.md');
  const { serializeProject } = await import('../packages/work/model.ts');
  writeFileSync(path, serializeProject({ ...w.project('tracker-v2').project, repo: '/tmp/demo' }, w.project('tracker-v2').body));
  const runs = [{ databaseId: 9, workflowName: 'CI', conclusion: 'failure', status: 'completed', headSha: 'abcdef1234', url: 'https://github.com/x/runs/9', createdAt: '2026-11-21T06:00:00Z' },
    { databaseId: 8, workflowName: 'CI', conclusion: 'success', status: 'completed', headSha: '0000000', url: 'u', createdAt: '2026-11-20T06:00:00Z' },
    { databaseId: 7, workflowName: 'Deploy', conclusion: 'failure', status: 'completed', headSha: 'abcdef1234', url: 'u', createdAt: '2026-11-21T06:00:00Z' }];
  const live = ['CI'];   // the Deploy workflow was deleted: its last failed run must not make a task
  w.setGh((a) => a[0] === 'workflow' ? JSON.stringify(live.map((name) => ({ name, state: 'active' }))) : a[1] === 'list' ? JSON.stringify(runs) : 'test\tTest\t2026-11-21T06:37:40.9974018Z \x1b[31mError: Cannot find module ./demoApi\x1b[39m\n');
  w.clear(); assert.equal(w.cli('ci', '--apply'), 0, w.text());
  const fix = w.tasks.filter((t) => t.title === '[tracker-v2] Fix failing CI on main: CI');
  assert.equal(fix.length, 1);
  assert.equal(fix[0].assignee, 'coding');
  assert.ok(!w.tasks.some((t) => t.title.includes('Deploy')), 'a deleted workflow makes no task');
  assert.match(fix[0].body!, /Error: Cannot find module \.\/demoApi/);
  assert.ok(!/\x1b/.test(fix[0].body!));
  w.clear(); w.cli('ci', '--apply');
  assert.equal(w.tasks.filter((t) => t.title.includes('Fix failing CI')).length, 1, 'no second task while one is open');
  runs.unshift({ ...runs[0], databaseId: 10, conclusion: 'success' });
  fix[0].status = 'done';
  w.clear(); w.cli('ci', '--apply');
  assert.match(w.text(), /main is green/);
});

test('negotiation: a refusal sends the work back with the reasons, Atlas mediates from round 2, round 3 goes to Frank; a person\'s refusal is final; any agent may escalate', async () => {
  const w = await world();
  const data = join(w.kb, '..', 'pap-data');
  const E = { PAP_DATA_DIR: data, AUDIT_LOG: join(data, 'audit.jsonl') };
  w.cliEnv(E, 'project', 'propose', 'micropace', '--id', 'neg-v1', '--outcome', 'N', '--done-when', 'ok', '--team', 'coding,qa', '--apply');
  w.cliEnv(E, 'project', 'approve', 'neg-v1', '--apply');
  w.cliEnv(E, 'project', 'set', 'neg-v1', '--approver', 'qa', '--delegate', 'merge', '--by', 'Frank', '--apply');
  w.tasks.push({ id: 't_8001', title: 'build', status: 'running', assignee: 'coding', tenant: 'neg-v1', body: 'b' });
  const asCoding = { ...E, HERMES_SESSION_KEY: 's', HERMES_KANBAN_TASK: 't_8001', HERMES_KANBAN_BOARD: 'micropace-labs' };
  const PR = 'https://github.com/Frank-Tao/demo/pull/9';
  const ask = (summary: string) => { w.clear(); w.cliEnv(asCoding, 'outbox', 'submit', 'neg-v1', '--kind', 'merge', '--target', PR, '--summary', summary, '--task', 't_8001', '--apply'); };
  const refuse = (why: string) => {
    const review = [...w.tasks].reverse().find((t) => t.title.includes('Review: merge'))!;
    const id = review.body!.match(/\[approve:([a-z0-9-]+)\]/)![1];
    w.clear(); assert.equal(w.cliEnv({ ...E, HERMES_SESSION_KEY: 's', HERMES_KANBAN_TASK: review.id, HERMES_KANBAN_BOARD: 'micropace-labs' }, 'outbox', 'deny', id, '--why', why, '--apply'), 0, w.text());
    return id;
  };
  ask('first try'); assert.match(w.text(), /waits for qa/);
  const id1 = refuse('the diff touches the schema without a migration');
  let revise = w.tasks.filter((t) => t.title.includes('Revise and resubmit'));
  assert.equal(revise.length, 1); assert.equal(revise[0].assignee, 'coding');
  assert.match(revise[0].body!, /round 1 of 3/); assert.match(revise[0].body!, /schema without a migration/);
  assert.ok(!w.tasks.some((t) => t.title.includes('Mediate')), 'no mediation after the first refusal');
  w.clear(); assert.equal(w.cliEnv(asCoding, 'outbox', 'submit', 'neg-v1', '--kind', 'merge', '--target', PR, '--summary', 'second try, migration added', '--task', 't_8001', '--apply'), 0);
  const id2 = refuse('migration is not reversible');
  assert.ok(id2 !== id1);
  const mediate = w.tasks.find((t) => t.title.includes('Mediate'))!;
  assert.equal(mediate.assignee, 'default'); assert.match(mediate.body!, /outbox escalate/);
  assert.equal(w.tasks.filter((t) => t.title.includes('Revise and resubmit')).length, 2);
  ask('third try, reversible'); const id3 = refuse('still lacks a rollback test');
  w.clear(); w.cliEnv(E, 'outbox', 'thread', id3);
  assert.match(w.text(), /round 1 · .*denied[\s\S]*round 2[\s\S]*round 3 · .*\(with Frank\)/);
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = join(w.kb, 'micropace', 'outbox', 'neg-v1');
  const last = JSON.parse(readFileSync(join(dir, readdirSync(dir).sort().at(-1)!), 'utf8'));
  assert.deepEqual([last.status, last.escalated, last.round], ['held', true, 3]);
  assert.match(last.reason, /did not agree after 3 rounds/);
  // the approver can no longer decide it; Frank can
  const review3 = [...w.tasks].reverse().find((t) => t.title.includes('Review: merge'))!;
  w.clear(); assert.equal(w.cliEnv({ ...E, HERMES_SESSION_KEY: 's', HERMES_KANBAN_TASK: review3.id, HERMES_KANBAN_BOARD: 'micropace-labs' }, 'outbox', 'release', id3, '--why', 'fine by me really', '--apply'), 1);
  assert.match(w.text(), /Frank decides/);
  w.clear(); assert.equal(w.cliEnv(E, 'outbox', 'deny', id3, '--by', 'Frank', '--why', 'not now', '--apply'), 0);
  w.clear(); assert.equal(w.cliEnv(asCoding, 'outbox', 'submit', 'neg-v1', '--kind', 'merge', '--target', PR, '--summary', 'again', '--apply'), 1);
  assert.match(w.text(), /refused by Frank: ask him before asking again/);
  // any agent may ask Frank early
  const PR2 = 'https://github.com/Frank-Tao/demo/pull/10';
  w.clear(); w.cliEnv(asCoding, 'outbox', 'submit', 'neg-v1', '--kind', 'merge', '--target', PR2, '--summary', 'other', '--apply');
  const idE = [...w.tasks].reverse().find((t) => t.title.includes(PR2))!.body!.match(/\[approve:([a-z0-9-]+)\]/)![1];
  w.clear(); assert.equal(w.cliEnv(asCoding, 'outbox', 'escalate', idE, '--why', 'architect wants a redesign; coder says out of scope', '--apply'), 0);
  w.clear(); w.cliEnv(E, 'outbox', 'list', 'neg-v1'); assert.match(w.text(), /escalated to you: architect wants a redesign/);
});

const readPlanOf = (body: string): PlanTask[] => readPlan(body) ?? [];

test('adding a task: it records when and what was asked, a planner gets planning instructions, and a finished project is open again so automation picks the task up', async () => {
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  for (const t of w.tasks) t.status = 'done';
  // pretend the project had finished and was waiting for review
  const path = join(w.kb, 'micropace', 'projects', 'notice-v1.md');
  const { project, body } = parseProject(readFileSync(path, 'utf8'));
  const { serializeProject } = await import('../packages/work/model.ts');
  writeFileSync(path, serializeProject({ ...project, status: 'review' }, body));
  w.clear();
  assert.equal(w.cli('plan', 'edit', 'notice-v1', '--op', 'add', '--key', 'dark-mode', '--title', 'Add a dark mode', '--owner', 'pm', '--accept', 'Settings has a dark mode switch and tests cover it', '--desc', 'Frank wants a dark mode on every screen,   remembered per device.', '--apply'), 0);
  const after = w.project();
  assert.equal(after.project.status, 'active');                                   // reopened
  assert.match(after.body, /reopened: a new task was added \(dark-mode\)/);
  const t = readPlanOf(after.body).find((x) => x.key === 'dark-mode')!;
  assert.deepEqual([t.desc, /^\d{4}-\d{2}-\d{2}T/.test(t.added ?? '')], ['Frank wants a dark mode on every screen, remembered per device.', true]);
  // the Hermes task for a planner carries the requirement and the planning instructions, not only a title
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  const made = w.tasks.find((x) => /dark-mode/.test(x.body ?? ''))!;
  assert.match(made.body!, /Requirement \(from the owner/);
  assert.match(made.body!, /do NOT build it yourself/);
  assert.match(made.body!, /plan edit notice-v1 --op add/);
  assert.doesNotMatch(made.body!, /Git workflow/);                                  // a planner does not commit or merge
  // a builder gets the requirement but no planning instructions
  w.cli('plan', 'edit', 'notice-v1', '--op', 'add', '--key', 'fix-typo', '--title', 'Fix a typo', '--owner', 'coding', '--accept', 'The typo is fixed', '--desc', 'The word "recieve" is misspelt on the welcome screen.', '--apply');
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  const builder = w.tasks.find((x) => /fix-typo/.test(x.body ?? ''))!;
  assert.match(builder.body!, /misspelt/);
  assert.doesNotMatch(builder.body!, /do NOT build it yourself/);
});

test('a requirement chain: build, verify and release carry their own rules, link to the requirement, and are checked as a chain', async () => {
  const w = await approvedWithPlan();
  const add = (...a: string[]) => w.cli('plan', 'edit', 'notice-v1', '--op', 'add', ...a, '--apply');
  w.clear();
  assert.equal(add('--key', 'dark', '--title', 'Add a dark mode', '--owner', 'pm', '--accept', 'Dark mode works', '--desc', 'Dark mode on every screen, remembered per device.'), 0);
  assert.equal(add('--key', 'dark-build', '--title', 'Build it', '--owner', 'coding', '--accept', 'Switch works', '--req', 'dark', '--role', 'build'), 0);
  // a verify task must follow a build task of the same requirement
  w.clear();
  assert.equal(add('--key', 'dark-verify', '--title', 'Prove it', '--owner', 'qa', '--accept', 'Screenshots show it', '--req', 'dark', '--role', 'verify'), 1);
  assert.match(w.text(), /verify task must come after a build task/);
  assert.equal(add('--key', 'dark-verify', '--title', 'Prove it', '--owner', 'qa', '--accept', 'Screenshots show it', '--req', 'dark', '--role', 'verify', '--needs', 'dark-build'), 0);
  w.clear();
  assert.equal(add('--key', 'dark-release', '--title', 'Release it', '--owner', 'coding', '--accept', 'PR raised', '--req', 'dark', '--role', 'release'), 1);
  assert.match(w.text(), /release task must come after a verify task/);
  assert.equal(add('--key', 'dark-release', '--title', 'Release it', '--owner', 'coding', '--accept', 'PR raised', '--req', 'dark', '--role', 'release', '--needs', 'dark-verify'), 0);
  w.clear();
  assert.equal(add('--key', 'orphan', '--title', 'Lost', '--owner', 'coding', '--accept', 'x', '--role', 'build'), 1);
  assert.match(w.text(), /needs --req/);
  assert.equal(add('--key', 'orphan2', '--title', 'Lost', '--owner', 'coding', '--accept', 'x', '--req', 'nope', '--role', 'build'), 1);
  assert.match(w.text(), /req "nope" is not a task/);
  // the Hermes bodies
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  const body = (k: string) => w.tasks.find((x) => new RegExp(`:${k}\\]`).test(x.body ?? ''))!.body!;
  assert.match(body('dark-build'), /branch req\/dark/);
  assert.match(body('dark-build'), /Do NOT open a pull request and do NOT merge/);
  assert.doesNotMatch(body('dark-build'), /gh pr merge/);
  assert.match(body('dark-verify'), /REAL browser|real browser/);
  assert.match(body('dark-verify'), /Dark mode on every screen, remembered per device/);            // the requirement travels with the test
  assert.match(body('dark-verify'), /ui-evidence\.py/);
  assert.match(body('dark-verify'), /hermes kanban --board micropace-labs attach/);            // the exact command, with the board, so the evidence is attached from the terminal
  assert.match(body('dark-verify'), /--attach <this task id> --board micropace-labs/);
  assert.match(body('dark-verify'), /not the URL tool|never the URL tool/);
  assert.match(body('dark-release'), /outbox submit notice-v1 --kind merge/);
  assert.match(body('dark-release'), /--req dark/);
  assert.match(body('dark'), /--req dark \[--role/);
  assert.match(body('dark'), /At most THREE top-level tasks/);
  assert.match(body('dark'), /SUBTASK of the task it belongs to/);
  assert.match(body('dark-build'), /same branch and is pushed there/);                                                  // the planner is told how to build the chain
  // and the plan survives a round trip with the links intact
  const plan = readPlan(w.project().body)!;
  assert.deepEqual(plan.filter((t) => t.req === 'dark').map((t) => [t.key, t.role]), [['dark-build', 'build'], ['dark-verify', 'verify'], ['dark-release', 'release']]);
});

function allOutboxCount(kb: string): number { try { return readdirSync(join(kb, 'micropace', 'outbox', 'notice-v1')).length; } catch { return 0; } }

test('releasing a requirement: no merge request without browser screenshots from passing verify tasks; then full automation releases it and semi waits for Frank', async () => {
  const w = await approvedWithPlan();
  const add = (...a: string[]) => w.cli('plan', 'edit', 'notice-v1', '--op', 'add', ...a, '--apply');
  add('--key', 'dark', '--title', 'Add a dark mode', '--owner', 'pm', '--accept', 'Dark mode works', '--desc', 'Dark mode on every screen.');
  add('--key', 'dark-build', '--title', 'Build it', '--owner', 'coding', '--accept', 'Switch works', '--req', 'dark', '--role', 'build');
  add('--key', 'dark-verify', '--title', 'Prove it', '--owner', 'qa', '--accept', 'Screenshots show it', '--req', 'dark', '--role', 'verify', '--needs', 'dark-build');
  add('--key', 'dark-release', '--title', 'Release it', '--owner', 'pm', '--accept', 'PR raised', '--req', 'dark', '--role', 'release', '--needs', 'dark-verify');
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  const verifyTask = () => w.tasks.find((x) => /:dark-verify\]/.test(x.body ?? ''))!;
  const submit = (...extra: string[]) => w.cli('outbox', 'submit', 'notice-v1', '--kind', 'merge', '--target', 'https://github.com/Frank-Tao/demo/pull/9', '--summary', 'dark: Add a dark mode', '--req', 'dark', '--by', 'pm', ...extra, '--apply');
  // 1. the verify task is not done: nothing is recorded
  w.clear();
  assert.equal(submit(), 1);
  assert.match(w.text(), /has no UI evidence yet: verify task "dark-verify" is (ready|todo), not done/);
  assert.equal(allOutboxCount(w.kb), 0);
  // 2. done, but no screenshots attached
  verifyTask().status = 'done';
  w.clear();
  assert.equal(submit(), 1);
  assert.match(w.text(), /has no screenshots attached/);
  // 3. a screenshot is attached: semi waits for Frank (not for a delegated agent)
  const dir = join(w.home, 'kanban', 'boards', 'micropace-labs', 'attachments', verifyTask().id);
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ac1-dark.png'), 'png'); writeFileSync(join(dir, 'ui-report.md'), '# report');
  w.clear();
  assert.equal(submit(), 0);
  assert.match(w.text(), /held: requirement "dark": 1 verify task passed with 1 screenshot; semi automation: waits for your yes/);
  const item = JSON.parse(readFileSync(join(w.kb, 'micropace', 'outbox', 'notice-v1', readdirSync(join(w.kb, 'micropace', 'outbox', 'notice-v1'))[0]), 'utf8'));
  assert.deepEqual([item.req, item.kind, item.status, item.review_task ?? null], ['dark', 'merge', 'held', null]);
  assert.match(item.summary, /UI evidence: 1 screenshot from 1 passed verify task/);
  // full automation: the same evidence, and the merge is released by the system (it still waits for green checks when it is carried out)
  const path = join(w.kb, 'micropace', 'projects', 'notice-v1.md');
  const cur = parseProject(readFileSync(path, 'utf8'));
  const { serializeProject: ser } = await import('../packages/work/model.ts');
  writeFileSync(path, ser({ ...cur.project, autonomy: 'full' }, cur.body));
  w.clear();
  assert.equal(w.cli('outbox', 'submit', 'notice-v1', '--kind', 'merge', '--target', 'https://github.com/Frank-Tao/demo/pull/11', '--summary', 'dark: second try', '--req', 'dark', '--by', 'pm', '--apply'), 0);
  assert.match(w.text(), /ready: requirement "dark": 1 verify task passed with 1 screenshot; full automation: it merges once the checks are green/);
  writeFileSync(path, ser({ ...cur.project, autonomy: 'semi' }, cur.body));
  // a plain merge request keeps working as before (no --req)
  assert.equal(w.cli('outbox', 'submit', 'notice-v1', '--kind', 'merge', '--target', 'https://github.com/Frank-Tao/demo/pull/10', '--summary', 'a fix', '--by', 'coding', '--apply'), 0);
  // what Cockpit shows: the chain links on the plan rows and the outbox items on the project
  w.clear();
  assert.equal(w.cli('projects', '--id', 'notice-v1'), 0);
  const pj = JSON.parse(w.text().split('\n').find((l) => l.startsWith('['))!)[0];
  assert.deepEqual(pj.plan.filter((t: { req: string | null }) => t.req === 'dark').map((t: { key: string; role: string }) => [t.key, t.role]), [['dark-build', 'build'], ['dark-verify', 'verify'], ['dark-release', 'release']]);
  assert.deepEqual(pj.outbox.filter((o: { req: string | null }) => o.req === 'dark').map((o: { kind: string; status: string; target: string }) => [o.kind, o.status, o.target]), [['merge', 'held', 'https://github.com/Frank-Tao/demo/pull/9'], ['merge', 'ready', 'https://github.com/Frank-Tao/demo/pull/11']]);
  // --req only goes with a merge
  w.clear();
  assert.equal(w.cli('outbox', 'submit', 'notice-v1', '--kind', 'deploy', '--target', 'preview.example.com', '--summary', 'x', '--req', 'dark', '--apply'), 1);
  assert.match(w.text(), /--req goes with --kind merge/);
});

test('steward: agents settle only what is theirs. The project manager confirms and answers planning matters; secrets, money, Frank\'s own decisions and escalated items stay with Frank; other agents only propose', async () => {
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  const { readDecisions } = await import('../packages/work/decisions.ts');
  const P = 'micropace/notice-v1';
  const all = () => readDecisions(w.kb, { portfolio: 'micropace', project: 'notice-v1' });
  const by = (title: string) => all().find((d) => d.title.startsWith(title))!;
  const asTask = (assignee: string) => {                                              // run a command the way an agent inside its kanban task does
    const t = w.tasks[0];
    return (...argv: string[]) => { t.assignee = assignee; return w.cliEnv({ HERMES_KANBAN_TASK: t.id, HERMES_KANBAN_BOARD: 'micropace-labs' }, ...argv); };
  };
  // Frank decides one thing; agents' proposals follow
  w.cli('decision', 'add', 'notice-v1', '--title', 'Frank: parser output stays on this Mac', '--by', 'Frank', '--source', 'manual', '--apply');
  const frankN = by('Frank: parser output').n;
  const propose = (title: string) => w.cli('decision', 'add', 'notice-v1', '--title', title, '--by', 'coding', '--source', 'manual', '--status', 'proposed', '--apply');
  propose('Retry a failed import three times before giving up');
  propose('Spend $20 a month on a market data subscription');
  propose(`This changes D${frankN} so the parser may run elsewhere`);
  w.cli('decision', 'add', 'notice-v1', '--title', 'Is a nightly snapshot enough', '--question', '--by', 'coding', '--source', 'manual', '--apply');
  const ref = (title: string) => `${P}/D${by(title).n}`;
  const pm = asTask('pm'), coding = asTask('coding');
  // the steward (pm) settles a planning matter...
  w.clear(); assert.equal(pm('decision', 'confirm', ref('Retry a failed import'), '--reason', 'fine', '--apply'), 0, w.text());
  assert.equal(by('Retry a failed import').status, 'active');
  assert.match(by('Retry a failed import').notes, /by pm \(steward\)/);                  // recorded as the steward's, not as Frank's
  // ...but not money, and not a change to what Frank decided
  w.clear(); assert.equal(pm('decision', 'confirm', ref('Spend $20'), '--apply'), 1); assert.match(w.text(), /owner's to settle: it is about spending/);
  w.clear(); assert.equal(pm('decision', 'confirm', ref('This changes D'), '--apply'), 1); assert.match(w.text(), /which you decided/);
  assert.deepEqual([by('Spend $20').status, by('This changes D').status], ['proposed', 'proposed']);
  // another agent is not the steward
  w.clear(); assert.equal(coding('decision', 'reject', ref('This changes D'), '--apply'), 1); assert.match(w.text(), /only the project's steward \(pm\)/);
  // the steward answers a question by superseding it; the answer counts at once
  const qn = by('Is a nightly snapshot').n;
  w.clear(); assert.equal(pm('decision', 'add', 'notice-v1', '--title', 'Answer: nightly is enough', '--why', 'the data changes daily', '--supersedes', `D${qn}`, '--source', 'manual', '--apply'), 0, w.text());
  assert.equal(by('Is a nightly snapshot').status, 'superseded');
  assert.deepEqual([by('Answer: nightly').status, by('Answer: nightly').by], ['active', 'pm']);
  // what an agent merely records stays a proposal, whatever --status says
  w.clear(); assert.equal(coding('decision', 'add', 'notice-v1', '--title', 'Use a 5 minute cache for quotes', '--source', 'manual', '--apply'), 0);
  assert.equal(by('Use a 5 minute cache').status, 'proposed');
  // an agent can say an item is not its to settle: it becomes Frank's, and the steward can no longer touch it
  w.clear(); assert.equal(coding('decision', 'escalate', ref('Use a 5 minute cache'), '--reason', 'unsure about the cache rule', '--apply'), 0, w.text());
  w.clear(); assert.equal(pm('decision', 'confirm', ref('Use a 5 minute cache'), '--apply'), 1); assert.match(w.text(), /an agent escalated it to you/);
  // Frank (no agent environment) settles anything
  w.clear(); assert.equal(w.cli('decision', 'confirm', ref('Spend $20'), '--by', 'Frank', '--apply'), 0, w.text());
  assert.equal(by('Spend $20').status, 'active');
});

test('steward routine: agent-level proposals and questions get ONE triage task for the project manager (never the owner-level ones), not a second while one is open or just finished, and its own hand-off creates no new items', async () => {
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  const dec = (title: string, ...extra: string[]) => w.cli('decision', 'add', 'notice-v1', '--title', title, '--by', 'coding', '--source', 'manual', ...extra, '--apply');
  dec('Retry a failed import three times', '--status', 'proposed');                    // planning: the steward's
  dec('Is a nightly snapshot enough', '--question');                                    // a question the steward can answer
  dec('Spend $20 a month on a market data subscription', '--status', 'proposed');      // money: Frank's
  const steward = () => w.tasks.filter((t) => (t.body ?? '').startsWith('[steward-for:notice-v1]'));
  w.clear(); w.cli('advance', '--apply');
  assert.equal(steward().length, 1);
  const t = steward()[0];
  assert.equal(t.assignee, 'pm');
  assert.match(t.body!, /Retry a failed import three times/);
  assert.match(t.body!, /Is a nightly snapshot enough/);
  assert.doesNotMatch(t.body!, /Spend \$20/);                                            // not the steward's
  assert.match(t.body!, /decision confirm <ref>/);
  assert.match(t.body!, /decision escalate <ref>/);
  assert.match(t.body!, /do NOT write a "Decisions:"/);
  assert.match(w.text(), /2 proposals\/questions for the steward \(pm\), not for you/);
  // one at a time
  w.cli('advance', '--apply');
  assert.equal(steward().length, 1);
  // just finished: let the next harvest and planning round settle before another one
  t.status = 'done'; (t as unknown as { completed_at: number }).completed_at = Math.floor(Date.now() / 1000) - 60;
  w.cli('advance', '--apply');
  assert.equal(steward().length, 1);
  // a while later, if items are still waiting, there is a new one
  (t as unknown as { completed_at: number }).completed_at = Math.floor(Date.now() / 1000) - 3600;
  w.cli('advance', '--apply');
  assert.equal(steward().length, 2);
  // with nothing agent-level waiting there is nothing to create
  const { readDecisions, setStatus } = await import('../packages/work/decisions.ts');
  for (const d of readDecisions(w.kb, { portfolio: 'micropace', project: 'notice-v1' }).filter((x) => /Retry|nightly/.test(x.title))) setStatus(w.kb, d.ref, d.kind === 'question' ? 'superseded' : 'active', 'pm');
  steward()[1].status = 'done'; (steward()[1] as unknown as { completed_at: number }).completed_at = 1;
  w.cli('advance', '--apply');
  assert.equal(steward().length, 2);
});

test("Frank's rejection with a reason becomes ONE task for the steward (not a dead end); a steward's rejection does not; the same proposal is not brought back by a later hand-off", async () => {
  const w = await approvedWithPlan();
  w.cli('plan', 'apply', 'notice-v1', '--apply');
  const { readDecisions, setStatus, addDecision } = await import('../packages/work/decisions.ts');
  w.cli('decision', 'add', 'notice-v1', '--title', 'Real files are run only by Frank', '--by', 'pm', '--source', 'manual', '--status', 'proposed', '--apply');
  w.cli('decision', 'add', 'notice-v1', '--title', 'Retry a failed import', '--by', 'pm', '--source', 'manual', '--status', 'proposed', '--apply');
  const ds = readDecisions(w.kb, { portfolio: 'micropace', project: 'notice-v1' });
  setStatus(w.kb, ds.find((d) => /Real files/.test(d.title))!.ref, 'rejected', 'Frank', 'None of it works: upload says API error 404.');
  setStatus(w.kb, ds.find((d) => /Retry/.test(d.title))!.ref, 'rejected', 'pm (steward)', 'not needed at all here');
  const fb = () => w.tasks.filter((t) => (t.body ?? '').startsWith('[feedback-for:notice-v1'));
  w.clear(); w.cli('advance', '--apply');
  assert.equal(fb().length, 1, w.text());
  assert.equal(fb()[0].assignee, 'pm');
  assert.match(fb()[0].body!, /upload says API error 404/);
  assert.match(fb()[0].body!, /plan edit notice-v1 --op add/);
  assert.match(fb()[0].title, /Your feedback on D2/);
  w.cli('advance', '--apply');
  assert.equal(fb().length, 1, 'handed over once');
  assert.match(readDecisions(w.kb, { portfolio: 'micropace', project: 'notice-v1' }).find((d) => /Real files/.test(d.title))!.notes, /routed to t_/);
  // a later hand-off that says it again is not a new proposal
  const again = addDecision(w.kb, { portfolio: 'micropace', project: 'notice-v1', date: '2026-11-22', title: 'Real files are run only by Frank', by: 'pm', source: 'harvest t_abcd1234', status: 'proposed' } as never);
  assert.equal(again.duplicate, true);
});

test('a merge that fails is fixed by an agent, not Frank; a PR merged by hand settles the item', async () => {
  const w = await world();
  const data = join(w.kb, '..', 'pap-data');
  const E = { PAP_DATA_DIR: data, AUDIT_LOG: join(data, 'audit.jsonl') };
  w.cliEnv(E, 'project', 'propose', 'micropace', '--id', 'tracker-v3', '--outcome', 'Tracker', '--done-when', 'ok', '--team', 'coding,qa', '--apply');
  w.cliEnv(E, 'project', 'approve', 'tracker-v3', '--apply');
  assert.equal(w.cliEnv(E, 'project', 'set', 'tracker-v3', '--approver', 'qa', '--delegate', 'merge,access', '--by', 'Frank', '--apply'), 0, w.text());
  const PR = 'https://github.com/Frank-Tao/demo/pull/9';
  w.clear(); w.cliEnv(E, 'outbox', 'submit', 'tracker-v3', '--kind', 'merge', '--target', PR, '--summary', 'tests green', '--apply');
  const itemId = w.text().match(/tracker-v3-\d{8}-\d+/)![0];
  assert.ok(itemId, w.text());
  const itemFile = () => { const dir = join(w.kb, 'micropace', 'outbox', 'tracker-v3'); const f = readdirSync(dir)[0]; return { path: join(dir, f), item: JSON.parse(readFileSync(join(dir, f), 'utf8')) }; };
  const set = (patch: object) => { const { path, item } = itemFile(); writeFileSync(path, JSON.stringify({ ...item, ...patch }, null, 2)); };
  set({ status: 'ready', decided_by: 'qa (delegated by Frank)' });
  let state = 'OPEN';
  w.setGh((a) => a[1] === 'view' ? JSON.stringify(a.includes('state') ? { state } : { state, baseRefName: 'main', statusCheckRollup: [] }) : (a[1] === 'merge' ? (() => { throw new Error('GraphQL: Pull Request has merge conflicts (mergePullRequest)'); })() : ''));
  w.clear(); w.cliEnv(E, 'outbox', 'run', '--apply');
  let it = itemFile().item;
  assert.equal(it.status, 'failed');
  assert.ok(it.fix_task, w.text());
  const fix = w.tasks.find((t) => t.id === it.fix_task)!;
  assert.equal(fix.assignee, 'coding');
  assert.match(fix.body!, /merge origin\/main/);
  // the fix is done: the merge is tried again by itself
  fix.status = 'done';
  w.clear(); w.cliEnv(E, 'outbox', 'run', '--apply');
  it = itemFile().item;
  assert.ok(['failed', 'ready'].includes(it.status));
  assert.equal(it.fix_round, 2, 'the second try failed again and was handed back');
  // the PR was merged by hand: the item settles
  state = 'MERGED';
  w.clear(); w.cliEnv(E, 'outbox', 'run', '--apply');
  assert.equal(itemFile().item.status, 'done');
  assert.match(itemFile().item.result, /merged outside the outbox/);
});
