import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './cli.ts';
import { parseProject, readPlan, serializeProject, writePlan, type PlanTask } from '../packages/work/model.ts';
import { readProposals, type Proposal } from '../packages/work/digest.ts';

// `work feedback approve`: an approved proposal becomes one plan task through the work tool; a full project refuses (design §7.2–7.3).

interface FakeTask { id: string; title: string; status: string; assignee: string | null; tenant: string | null; body: string | null; key?: string }

async function world(planSize: number) {
  const dir = await mkdtemp(join(tmpdir(), 'fb-approve-'));
  const home = join(dir, 'hermes');
  for (const p of ['pm', 'coding', 'qa']) mkdirSync(join(home, 'profiles', p), { recursive: true });
  const catalog = join(dir, 'catalog');
  mkdirSync(join(catalog, 'marketing'), { recursive: true });
  writeFileSync(join(catalog, 'divisions.json'), JSON.stringify({ divisions: { marketing: {} } }));
  const registryPath = join(dir, 'agents.json');
  const agent = (id: string) => ({ id, profile: id, name: id, role: `${id} role`, managed: false, lanes: [], portfolios: ['micropace'] });
  writeFileSync(registryPath, JSON.stringify({ catalog: { repo: 'r', commit: 'c', dir: catalog }, agents: [agent('pm'), agent('coding'), agent('qa')] }));
  const layoutPath = join(dir, 'cockpit.json');
  writeFileSync(layoutPath, JSON.stringify({ boards: { 'micropace-labs': 'micropace' } }));
  const kb = join(dir, 'kb'), fb = join(dir, 'data');
  mkdirSync(fb);
  const tasks: FakeTask[] = [];
  const run = (cmd: string, args: string[]): string => {
    if (cmd === 'git') return '';
    const sub = args[3];
    if (sub === 'list') { const t = args.indexOf('--tenant'); return JSON.stringify(tasks.filter((x) => t === -1 || x.tenant === args[t + 1])); }
    if (sub === 'create') {
      const val = (f: string) => args[args.indexOf(f) + 1];
      const key = val('--idempotency-key');
      const dupe = tasks.find((x) => x.key === key);
      if (dupe) return JSON.stringify(dupe);
      const t: FakeTask = { id: `t_${tasks.length + 1}`, title: args[args.length - 1], status: 'ready', assignee: val('--assignee'), tenant: val('--tenant'), body: val('--body'), key };
      tasks.push(t);
      return JSON.stringify(t);
    }
    return '';
  };
  const out: string[] = [];
  const env = { PORTFOLIO_KB: kb, COCKPIT_LAYOUT: layoutPath, AGENTS_REGISTRY: registryPath, HERMES_HOME: home, HERMES_BIN: 'hermes', KB_TEMPLATE: join(process.cwd(), 'kb-template'), WORK_TODAY: '2026-11-01', FEEDBACK_DIR: fb } as NodeJS.ProcessEnv;
  const cli = (...argv: string[]) => main(argv, env, (s) => out.push(s), run);
  cli('project', 'propose', 'micropace', '--id', 'cockpit-improvement', '--outcome', 'Cockpit gets a feedback loop', '--done-when', 'checks pass', '--team', 'coding,qa', '--apply');
  cli('project', 'approve', 'cockpit-improvement', '--apply');
  const path = join(kb, 'micropace', 'projects', 'cockpit-improvement.md');
  const { project, body } = parseProject(readFileSync(path, 'utf8'));
  const plan: PlanTask[] = Array.from({ length: planSize }, (_, i) => ({ key: `t${i + 1}`, title: `Task ${i + 1}`, owner: 'coding', lane: null, model: null, provider: null, needs: [], accept: 'works', outward: null, workspace: null, max_runtime: '2h', goal: false }));
  writeFileSync(path, serializeProject(project, writePlan(body, plan)));
  const proposal: Proposal = {
    v: 1, id: 'prop-2026-w45-1', week: '2026-W45', created: '2026-11-07T00:00:00Z', title: 'Show blocked tasks on the project page', items: ['fb-1'],
    evidence: [{ id: 'fb-1', source: 'cockpit', time: '2026-11-06T00:00:00Z', quote: 'blocked tasks are hidden' }], count: 1, days: 1, sources: ['cockpit'], pages: [], score: 1,
    status: 'pending', decision: null, tasks: [], prior: null,
  };
  writeFileSync(join(fb, 'feedback-proposals.jsonl'), JSON.stringify(proposal) + '\n');
  out.length = 0;
  return { cli, out, text: () => out.join('\n'), tasks, fb, plan: () => readPlan(parseProject(readFileSync(path, 'utf8')).body) ?? [], proposal: () => readProposals(fb)[0] };
}

test('approve adds one task to the project plan, creates it in Hermes, marks the proposal converted, and a second approve is a no-op', async () => {
  const w = await world(3);
  assert.equal(w.cli('feedback', 'approve', 'prop-2026-w45-1', '--into', 'cockpit-improvement'), 0, w.text());
  assert.match(w.text(), /dry run/);
  assert.equal(w.plan().length, 3);
  assert.equal(w.proposal().status, 'pending');

  assert.equal(w.cli('feedback', 'approve', 'prop-2026-w45-1', '--into', 'cockpit-improvement', '--apply'), 0, w.text());
  const added = w.plan().find((t) => t.key.startsWith('fb-'));
  assert.ok(added, 'a fb- task is in the plan');
  assert.equal(added!.owner, 'coding');
  assert.match(added!.accept, /blocked tasks are hidden/);
  assert.equal(w.plan().length, 4);
  assert.equal(w.tasks.length, 4);
  assert.match(w.tasks.find((t) => t.key?.endsWith(added!.key))!.title, /Show blocked tasks/);
  assert.equal(w.proposal().status, 'converted');
  assert.deepEqual(w.proposal().tasks, [{ project: 'cockpit-improvement', key: added!.key }]);

  w.out.length = 0;
  assert.equal(w.cli('feedback', 'approve', 'prop-2026-w45-1', '--into', 'cockpit-improvement', '--apply'), 0);
  assert.match(w.text(), /already a task/);
  assert.equal(w.plan().length, 4);
  assert.equal(w.tasks.length, 4);
});

test('approve refuses when the project has no task slots left, says a new charter is needed, and changes nothing', async () => {
  const w = await world(9);
  assert.equal(w.cli('feedback', 'approve', 'prop-2026-w45-1', '--into', 'cockpit-improvement', '--apply'), 1);
  assert.match(w.text(), /0 of 9 task slots left.*needs a new charter/);
  assert.equal(w.plan().length, 9);
  assert.equal(w.tasks.length, 0);
  assert.equal(w.proposal().status, 'pending');
});
