import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { main as agentsMain } from '../agents/cli.ts';
import { loadLayout } from '../apps/cockpit/src/config.ts';
import { GROUPS } from '../apps/cockpit/src/types.ts';
import { loadCatalogCached } from '../packages/roster/catalog.ts';
import { loadRegistry } from '../packages/roster/roster.ts';
import {
  BODY_TEMPLATE, HUMAN, SLUG, WORK_MARKER, type AgentLite, type Findings, type PlanTask, type Project, type Status, addDecision, appendLog, logOf, checkCharter, checkPlan,
  decisionsOf, emptyCharter, hermesPriority, parseObjectives, parseProject, readPlan, renderTaskBody, serializeObjectives, serializeProject, timeboxHours, topoOrder, writePlan,
} from '../packages/work/model.ts';
import { GITIGNORE, renderAgents, renderReadme, titleOf } from '../packages/work/repo.ts';
import { taskUsage } from '../packages/work/taskusage.ts';
import { suggestTeam } from '../packages/work/team.ts';
import { OUTBOX_ID, decide, newItemId, type OutboxItem } from '../packages/work/outbox.ts';
import { PLAN_MARKER, nextAction, planMarkerOf, type Action } from '../packages/work/advance.ts';
import { editPlan, type PlanOp } from '../packages/work/planedit.ts';
import { evaluateProject, needsHuman, runMinutes } from '../packages/work/watch.ts';

// Objectives, project charters and plans (docs/design/work-model.md). Dry run unless --apply.
//
//   work kb init [--portfolio p]                       create ~/PortfolioKB/<portfolio>/ from kb-template (never overwrites)
//   work objective show [portfolio] | add <portfolio> --title T --kr "text" [--kr …] | review <portfolio>
//   work project propose <portfolio> --id slug --outcome "…" --done-when "…" [--done-when …] [--team a,b (default: pm + qa, plus whoever the outcome calls for)] [--objective O1] [--kr KR1.1,KR1.2]
//                        [--timebox 7d] [--deploy-targets x,y] [--publish no|draft-only|auto] [--repo path] [--new-agent slug:id:model:provider]
//   work project list [portfolio] | show <id> | approve <id> | pause <id> | resume <id> | cancel <id>
//   work project set <id> [--priority 1-5] [--repo id|path] [--test-cmd "npm test"]      (no approval needed; re-prioritises open tasks)
//   work plan check <id> | apply <id> | diff <id>
//   work plan edit <id> --op move --key k --to n | remove --key k | add --key k --title T --owner o --accept A [--needs a,b] [--lane l] | set --key k [--title T] [--owner o] [--accept A] [--lane l]
//   work projects --json                         everything Cockpit shows: status, priority, tasks, repo git state
//   work status [portfolio]
//   work close <id> [--force]
//   work outbox submit <project> --kind publish|deploy|spend --target T --summary S [--payload file] [--usd n] [--task id]
//   work outbox list [project] | show <id> | release <id> | deny <id> | run          (run executes `ready` items via config/outbox.json)
//   work repo create <portfolio> --id slug --outcome "…" --done-when "…" [--test-cmd c]   new folder under ~/codes with README, AGENTS.md, git; registers it in config/projects.json
//   work repos [portfolio]                      which code folders belong to which portfolio (config/projects.json)
//   work advance [--project id]                 move approved projects forward: ask pm to plan, apply a written plan, mark finished ones for review (--apply)
//   work watch                                  check every active project against its charter; --apply pauses offenders and holds their open tasks

const root = resolve(import.meta.dirname, '..');
const PORTFOLIOS = GROUPS.map((g) => g.id as string);

interface Ctx {
  kb: string;
  layoutPath: string;
  registryPath: string;
  hermesBin: string;
  hermesHome: string;
  templateDir: string;
  today: string;
  out: (s: string) => void;
  run: (cmd: string, args: string[]) => string;
  apply: boolean;
  flags: Map<string, string[] | true>;
  pos: string[];
  env: NodeJS.ProcessEnv;
}

const BOOL = new Set(['apply', 'force', 'json', 'verbose']);

function parseArgs(argv: string[]): { pos: string[]; flags: Map<string, string[] | true> } {
  const pos: string[] = [];
  const flags = new Map<string, string[] | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (BOOL.has(k)) flags.set(k, true);
    else {
      const val = v !== undefined ? v : argv[++i];
      if (val === undefined) throw new Error(`--${k} needs a value`);
      const cur = flags.get(k);
      flags.set(k, [...(Array.isArray(cur) ? cur : []), val]);
    }
  }
  return { pos, flags };
}

const flag = (c: Ctx, k: string): string | undefined => { const v = c.flags.get(k); return Array.isArray(v) ? v[v.length - 1] : undefined; };
const flagAll = (c: Ctx, k: string): string[] => { const v = c.flags.get(k); return Array.isArray(v) ? v : []; };
const csv = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

/* ---------- places ---------- */

const portfolioDir = (c: Ctx, p: string) => join(c.kb, p);
const objectivesPath = (c: Ctx, p: string) => join(portfolioDir(c, p), 'objectives.md');

function allProjects(c: Ctx, only?: string): Array<{ path: string; project: Project; body: string }> {
  const out: Array<{ path: string; project: Project; body: string }> = [];
  for (const portfolio of only ? [only] : PORTFOLIOS) {
    const dir = join(portfolioDir(c, portfolio), 'projects');
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const path = join(dir, f);
      try { out.push({ path, ...parseProject(readFileSync(path, 'utf8')) }); } catch (e) { c.out(`  ! ${path}: ${(e as Error).message}`); }
    }
  }
  return out;
}

function loadProject(c: Ctx, id: string) {
  const found = allProjects(c).find((p) => p.project.id === id);
  if (!found) throw new Error(`no project "${id}" under ${c.kb} (see: work project list)`);
  return found;
}

function save(c: Ctx, path: string, content: string, why: string) {
  c.out(`  ${c.apply ? '✓' : '·'} ${why} → ${path.replace(homedir(), '~')}`);
  if (!c.apply) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function agentsLite(c: Ctx): AgentLite[] {
  const reg = loadRegistry(c.registryPath);
  const exists = (profile: string) => profile === 'default' || existsSync(join(c.hermesHome, 'profiles', profile));
  return reg.agents.map((a) => ({
    id: a.id, profile: a.profile, state: exists(a.profile) ? 'active' : 'proposed',
    portfolios: a.portfolios.includes('*') ? PORTFOLIOS : a.portfolios, allPortfolios: a.portfolios.includes('*'),
  }));
}

function checkCtx(c: Ctx) {
  const reg = loadRegistry(c.registryPath);
  const catalog = loadCatalogCached(reg.catalog.dir);
  return { portfolios: PORTFOLIOS, agents: agentsLite(c), catalogSlugs: catalog.length ? catalog.map((e) => e.slug) : undefined };
}

const boardFor = (c: Ctx, portfolio: string): string | undefined => Object.entries(loadLayout(c.layoutPath).boards).find(([, g]) => g === portfolio)?.[0];

function show(c: Ctx, label: string, f: Findings): boolean {
  for (const e of f.errors) c.out(`  ✗ ${label}: ${e}`);
  for (const w of f.warnings) c.out(`  ▲ ${label}: ${w}`);
  return f.errors.length === 0;
}

interface KTask { id: string; title: string; status: string; assignee: string | null; tenant: string | null; body: string | null; created_at?: number; started_at?: number | null; completed_at?: number | null }
const iso = (n?: number | null): string | null => (n ? new Date(n * 1000).toISOString() : null);

function kanban(c: Ctx, board: string, args: string[]): string {
  return c.run(c.hermesBin, ['kanban', '--board', board, ...args]);
}

/** What the task is called in Hermes: the project id first, so every task can be traced to its project. */
const taskTitle = (p: Project, t: PlanTask): string => `[${p.id}] ${t.title}`;

function tenantTasks(c: Ctx, board: string, tenant: string): KTask[] {
  return JSON.parse(kanban(c, board, ['list', '--tenant', tenant, '--json'])) as KTask[];
}

const hoursSince = (iso: string | null, today: string) => (iso ? Math.max(0, (Date.parse(today) - Date.parse(iso)) / 3_600_000) : 0);
const planSha = (plan: PlanTask[]) => createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16);

/* ---------- repo mapping (config/projects.json) ---------- */

const reposConfig = (c: Ctx): Record<string, Array<{ id: string; path: string | null; note?: string }>> => {
  const path = c.env.PROJECTS_CONFIG ?? join(root, 'config', 'projects.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')).repos ?? {}) : {};
};
const codesDir = (c: Ctx) => c.env.CODES_DIR ?? join(homedir(), 'codes');

/** A repo id from config/projects.json becomes its folder; anything else is kept as given. */
function resolveRepo(c: Ctx, v?: string): string | null {
  if (!v) return null;
  const hit = Object.values(reposConfig(c)).flat().find((r) => r.id === v);
  return hit ? (hit.path ?? null) : v;
}

/* ---------- kb ---------- */

function cmdKb(c: Ctx) {
  if (c.pos[1] !== 'init') throw new Error('usage: work kb init [--portfolio p]');
  const only = flag(c, 'portfolio');
  for (const p of only ? [only] : PORTFOLIOS) {
    if (!PORTFOLIOS.includes(p)) throw new Error(`unknown portfolio "${p}"`);
    const src = join(c.templateDir, p);
    if (!existsSync(src)) { c.out(`  ▲ no template for ${p} in ${c.templateDir}`); continue; }
    const dst = portfolioDir(c, p);
    const copies: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(src, rel), { withFileTypes: true })) {
        const r = join(rel, e.name);
        if (e.isDirectory()) walk(r);
        else if (!existsSync(join(dst, r))) copies.push(r);
      }
    };
    walk('');
    c.out(`${p}: ${copies.length ? `${copies.length} file(s) to create` : 'complete (nothing to create)'}${copies.length ? ': ' + copies.join(', ') : ''}`);
    if (c.apply) {
      for (const r of copies) { mkdirSync(dirname(join(dst, r)), { recursive: true }); cpSync(join(src, r), join(dst, r)); }
      if (!existsSync(join(dst, '.git'))) { try { c.run('git', ['-C', dst, 'init', '-q']); c.out('  ✓ git init'); } catch { c.out('  ▲ git init failed (not fatal)'); } }
    }
  }
  if (!c.apply) c.out('(dry run — add --apply)');
}

/* ---------- objectives ---------- */

function cmdObjective(c: Ctx) {
  const [, sub, portfolio] = c.pos;
  if (sub === 'show') {
    for (const p of portfolio ? [portfolio] : PORTFOLIOS) {
      let o;
      try { o = parseObjectives(readFileSync(objectivesPath(c, p), 'utf8')); } catch { continue; }
      const age = hoursSince(o.reviewed, c.today) / 24;
      c.out(`${p} — ${o.horizon}, reviewed ${o.reviewed || 'never'}${age > 8 ? ' ▲ overdue for review' : ''}`);
      for (const i of o.items) { c.out(`  ${i.id} ${i.title}`); for (const k of i.key_results) c.out(`    ${k.id} ${k.text}`); }
    }
    return;
  }
  if (!portfolio || !PORTFOLIOS.includes(portfolio)) throw new Error(`usage: work objective ${sub ?? 'show|add|review'} <portfolio>  (portfolios: ${PORTFOLIOS.join(', ')})`);
  const path = objectivesPath(c, portfolio);
  let o = existsSync(path) ? parseObjectives(readFileSync(path, 'utf8')) : { portfolio, horizon: 'rolling', reviewed: c.today, items: [] };
  if (!o.portfolio) o = { ...o, portfolio };
  if (sub === 'review') {
    o.reviewed = c.today;
    save(c, path, serializeObjectives(o), `reviewed ${c.today}`);
  } else if (sub === 'add') {
    const title = flag(c, 'title');
    if (!title) throw new Error('usage: work objective add <portfolio> --title "…" --kr "…" [--kr "…"]');
    const id = `O${o.items.reduce((n, i) => Math.max(n, Number(i.id.slice(1))), 0) + 1}`;
    o.items.push({ id, title, key_results: flagAll(c, 'kr').map((text, i) => ({ id: `KR${id.slice(1)}.${i + 1}`, text })) });
    o.reviewed = c.today;
    save(c, path, serializeObjectives(o), `${id} added`);
  } else throw new Error('usage: work objective show|add|review');
  if (!c.apply) c.out('(dry run — add --apply)');
}

/* ---------- projects ---------- */

function summary(c: Ctx, p: Project) {
  const ch = p.charter;
  c.out(`${p.id} [${p.status}] ${p.portfolio}${p.objective ? ` · ${p.objective}` : ''} · owner ${p.owner} · timebox ${p.timebox} · max ${ch.max_tasks} tasks`);
  c.out(`  outcome: ${ch.outcome}`);
  for (const d of ch.done_when) c.out(`  done when: ${d}`);
  c.out(`  team: ${ch.team.join(', ')}${ch.new_agents.length ? ` (new: ${ch.new_agents.map((n) => n.id).join(', ')})` : ''}`);
  c.out(`  outward: deploy ${ch.outward.deploy.allowed ? 'to ' + ch.outward.deploy.targets.join(',') : 'no'} · publish ${ch.outward.publish.allowed} · spend ${ch.outward.spend.allowed ? '≤$' + ch.outward.spend.max_usd : 'no'}`);
}

function cmdProject(c: Ctx) {
  const [, sub, arg] = c.pos;
  if (sub === 'list') {
    const rows = allProjects(c, arg);
    if (!rows.length) c.out('no projects');
    for (const r of rows) c.out(`${r.project.id.padEnd(28)}${r.project.status.padEnd(11)}${r.project.portfolio.padEnd(13)}owner ${r.project.owner}`);
    return;
  }
  if (sub === 'propose') return propose(c);
  const found = loadProject(c, arg ?? '');
  const { project: p, body } = found;
  if (sub === 'show') {
    summary(c, p);
    show(c, 'charter', checkCharter(p, checkCtx(c)));
    const plan = readPlan(body);
    c.out(plan ? `  plan: ${plan.length} task(s)` : '  plan: none yet');
    if (plan) show(c, 'plan', checkPlan(p, plan, checkCtx(c)));
    return;
  }
  const set = (status: Status, why: string) => {
    const next: Project = { ...p, status };
    save(c, found.path, serializeProject(next, appendLog(body, why, c.today)), `${p.id}: ${p.status} → ${status}`);
    if (!c.apply) c.out('(dry run — add --apply)');
  };
  if (sub === 'approve') {
    if (p.status !== 'proposed') throw new Error(`only a proposed project can be approved (this one is ${p.status})`);
    if (!show(c, 'charter', checkCharter(p, checkCtx(c)))) throw new Error('fix the charter before approving it');
    summary(c, p);
    // The charter pre-approves these agents: create them now, exactly as `agents add` would.
    for (const n of p.charter.new_agents) {
      if (loadRegistry(c.registryPath).agents.some((a) => a.id === n.id)) continue;
      const args = ['add', n.slug, '--id', n.id, '--portfolios', p.portfolio, ...(n.model ? ['--model', n.model] : []), ...(n.provider ? ['--provider', n.provider] : []), ...(c.apply ? ['--apply'] : [])];
      c.out(`  → new agent ${n.id}: agents ${args.join(' ')}`);
      const code = agentsMain(args, { ...c.env, AGENTS_REGISTRY: c.registryPath, HERMES_HOME: c.hermesHome, HERMES_BIN: c.hermesBin }, (s) => c.out('    ' + s), c.run);
      if (code !== 0) throw new Error(`could not create new agent "${n.id}"; the project stays proposed`);
    }
    const next: Project = { ...p, status: 'active', approved: c.today };
    const note = (flag(c, 'note') ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    // An approval note is a decision that applies to the whole project: it goes into the log and into the context stamped on every task.
    const approved = appendLog(note ? addDecision(body, `Approval note from the owner: ${note}`, c.today) : body, note ? `charter approved — note: ${note}` : 'charter approved', c.today);
    save(c, found.path, serializeProject(next, approved), `${p.id}: proposed → active (charter approved${note ? ' with a note' : ''})`);
    if (!c.apply) c.out('(dry run — add --apply)');
    return;
  }
  if (sub === 'set') {
    const pr = flag(c, 'priority');
    const prio = pr === undefined ? p.priority : Number(pr);
    if (!Number.isInteger(prio) || prio < 1 || prio > 5) throw new Error('--priority must be 1 (first) to 5');
    let team = p.charter.team;
    if (flag(c, 'team') !== undefined) {
      team = [...new Set(['pm', ...csv(flag(c, 'team'))])];
      const added = team.filter((x) => !p.charter.team.includes(x));
      if (p.status !== 'proposed' && added.length) throw new Error(`the charter is approved: ${added.join(', ')} can't be added without a new charter (removing people is fine)`);
    }
    const nm = flag(c, 'name');
    if (nm !== undefined && (nm.length > 80 || /[\n\r]/.test(nm))) throw new Error('--name must be one line, up to 80 characters');
    const next: Project = { ...p, name: nm === undefined ? p.name ?? null : nm.trim() || null, priority: prio, repo: flag(c, 'repo') !== undefined ? resolveRepo(c, flag(c, 'repo')) : p.repo, test_cmd: flag(c, 'test-cmd') ?? p.test_cmd, charter: { ...p.charter, team } };
    if (team !== p.charter.team) { const f = checkCharter(next, checkCtx(c)); if (!show(c, 'charter', f)) throw new Error('that team has errors; nothing written'); }
    const changes = [(next.name ?? null) !== (p.name ?? null) && `name ${next.name ?? '(from id)'}`, team.join() !== p.charter.team.join() && `team ${team.join(', ')}`, prio !== p.priority && `priority ${p.priority}→${prio}`, next.repo !== p.repo && `repo ${next.repo}`, next.test_cmd !== p.test_cmd && `test_cmd ${next.test_cmd}`].filter(Boolean).join(', ') || 'no change';
    save(c, found.path, serializeProject(next, appendLog(body, `set: ${changes}`, c.today)), `${p.id}: ${changes}`);
    if (c.apply && prio !== p.priority) {
      const board = boardFor(c, p.portfolio);
      if (board) for (const t of tenantTasks(c, board, p.tenant).filter((x) => !['done', 'archived'].includes(x.status))) { try { kanban(c, board, ['edit', t.id, '--priority', String(hermesPriority(prio))]); } catch { c.out(`  could not re-prioritise ${t.id}`); } }
    }
    if (!c.apply) c.out('(dry run — add --apply)');
    return;
  }
  if (sub === 'edit') {
    if (p.status !== 'proposed') throw new Error(`the charter is approved (${p.status}); changing the outcome or checks means a new charter`);
    const outcome = flag(c, 'outcome') ?? p.charter.outcome;
    const done = flagAll(c, 'done-when').length ? flagAll(c, 'done-when') : p.charter.done_when;
    const next: Project = { ...p, charter: { ...p.charter, outcome, done_when: done } };
    const f = checkCharter(next, checkCtx(c));
    if (!show(c, 'charter', f)) throw new Error('the edited charter has errors; nothing written');
    save(c, found.path, serializeProject(next, appendLog(body, 'charter edited', c.today)), `${p.id}: charter edited`);
    if (!c.apply) c.out('(dry run — add --apply)');
    return;
  }
  if (sub === 'stop-task') {
    const key = c.pos[3] ?? '';
    const board = boardFor(c, p.portfolio);
    if (!board) throw new Error(`no board for ${p.portfolio}`);
    const task = tenantTasks(c, board, p.tenant).find((t) => { const m = (t.body ?? '').match(WORK_MARKER); return m?.[1] === p.id && m?.[2] === key; });
    if (!task) throw new Error(`the task "${key}" has not been created in Hermes`);
    if (['done', 'archived'].includes(task.status)) throw new Error(`"${key}" is already ${task.status}; a finished task cannot be stopped`);
    const why = (flag(c, 'reason') ?? 'stopped by you').trim().slice(0, 200);
    c.out(`  ${c.apply ? '■' : '·'} stop ${key} (${task.id}, ${task.status}): ${why}`);
    if (c.apply) {
      if (task.status === 'running') kanban(c, board, ['reclaim', task.id, '--reason', why]);
      if (task.status !== 'blocked') kanban(c, board, ['block', task.id, why]);
      save(c, found.path, serializeProject(p, appendLog(body, `task "${key}" stopped: ${why}`, c.today)), 'logged');
    } else c.out('(dry run — add --apply)');
    return;
  }
  if (sub === 'step-done') {
    const key = c.pos[3] ?? '';
    const step = (readPlan(body) ?? []).find((t) => t.key === key);
    if (!step || step.owner !== HUMAN) throw new Error(`"${key}" is not a step for you in ${p.id}'s plan`);
    const board = boardFor(c, p.portfolio);
    if (!board) throw new Error(`no board for ${p.portfolio}`);
    const task = tenantTasks(c, board, p.tenant).find((t) => (t.body ?? '').match(WORK_MARKER)?.[2] === key && (t.body ?? '').match(WORK_MARKER)?.[1] === p.id);
    if (!task) throw new Error(`the step "${key}" has not been created in Hermes yet`);
    if (task.status === 'done') { c.out(`  = ${key} is already done`); return; }
    const note = (flag(c, 'note') ?? '').trim().slice(0, 500);
    c.out(`  ${c.apply ? '✓' : '·'} ${key} (${task.id}) marked done by you${note ? `: ${note}` : ''}; tasks that were waiting for it can start`);
    if (c.apply) { kanban(c, board, ['complete', task.id, '--result', `Done by Frank${note ? ': ' + note : ''}`]); save(c, found.path, serializeProject(p, appendLog(body, `your step "${key}" done${note ? ': ' + note : ''}`, c.today)), 'logged'); }
    else c.out('(dry run — add --apply)');
    return;
  }
  if (sub === 'pause') return set('paused', 'paused');
  if (sub === 'resume') {
    if (p.status !== 'paused') throw new Error('only a paused project can be resumed');
    const next: Project = { ...p, status: 'active', paused_reason: null };
    save(c, found.path, serializeProject(next, appendLog(body, 'resumed', c.today)), `${p.id}: paused → active`);
    if (p.paused_reason) c.out(`  was paused: ${p.paused_reason}\n  tasks the watchdog blocked stay blocked until you unblock them: hermes kanban --board <board> unblock <ids>`);
    if (!c.apply) c.out('(dry run — add --apply)');
    return;
  }
  if (sub === 'cancel') return set('cancelled', 'cancelled');
  throw new Error('usage: work project list|propose|show|set|edit|approve|pause|resume|cancel');
}

function propose(c: Ctx) {
  const portfolio = c.pos[2];
  const id = flag(c, 'id');
  if (!portfolio || !id) throw new Error('usage: work project propose <portfolio> --id <slug> --outcome "…" --done-when "…" --team a,b …');
  const auto = suggestTeam({ portfolio, outcome: flag(c, 'outcome') ?? '', done_when: flagAll(c, 'done-when'), test_cmd: flag(c, 'test-cmd') ?? null, agents: agentsLite(c).filter((a) => !['atlas', 'default'].includes(a.id)) });
  const team = [...new Set(['pm', ...(flag(c, 'team') ? csv(flag(c, 'team')) : auto.team)])];
  if (!flag(c, 'team')) c.out(`  team (pm + qa by default): ${auto.team.map((id) => `${id} (${auto.reasons[id]})`).join(', ')}`);
  const newAgents = flagAll(c, 'new-agent').map((v) => { const [slug, aid, model, provider] = v.split(':'); return { slug, id: aid, ...(model ? { model } : {}), ...(provider ? { provider } : {}) }; });
  for (const n of newAgents) if (!team.includes(n.id)) team.push(n.id);
  const targets = csv(flag(c, 'deploy-targets'));
  const project: Project = {
    id, name: flag(c, 'name')?.trim() || null, portfolio, objective: flag(c, 'objective') ?? null, key_results: csv(flag(c, 'kr')), status: 'proposed', owner: 'pm', tenant: id,
    timebox: flag(c, 'timebox') ?? '7d', created: c.today, approved: null, repo: resolveRepo(c, flag(c, 'repo')), priority: Number(flag(c, 'priority') ?? 3), test_cmd: flag(c, 'test-cmd') ?? null, plan_sha: null, paused_reason: null,
    charter: emptyCharter({
      outcome: flag(c, 'outcome') ?? '', done_when: flagAll(c, 'done-when'), team, new_agents: newAgents,
      outward: { deploy: { allowed: targets.length > 0, targets }, publish: { allowed: flag(c, 'publish') ?? 'draft-only' }, spend: { allowed: false } },
    } as never),
  };
  const f = checkCharter(project, checkCtx(c));
  show(c, 'charter', f);
  if (f.errors.length) throw new Error('the proposal has errors; nothing written');
  const path = join(portfolioDir(c, portfolio), 'projects', `${id}.md`);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  summary(c, project);
  save(c, path, serializeProject(project, appendLog(BODY_TEMPLATE, 'proposed', c.today)), `charter proposed (status: proposed — approve it with: work project approve ${id})`);
  if (!c.apply) c.out('(dry run — add --apply)');
}

/* ---------- plans ---------- */

function cmdPlan(c: Ctx) {
  const [, sub, id] = c.pos;
  const found = loadProject(c, id ?? '');
  const { project: p, body } = found;
  const plan = readPlan(body);
  const ctx = checkCtx(c);
  if (sub === 'check') {
    const ok = show(c, 'charter', checkCharter(p, ctx)) && show(c, 'plan', checkPlan(p, plan, ctx));
    c.out(ok ? `✓ plan OK: ${plan!.length} task(s), ${topoOrder(plan!)!.map((t) => t.key).join(' → ')}` : '✗ plan has errors');
    if (!ok) throw new Error('plan check failed');
    return;
  }
  if (sub === 'edit') {
    if (!plan) throw new Error('this project has no plan yet');
    const op = flag(c, 'op'), key = flag(c, 'key') ?? '';
    const req: PlanOp | null = op === 'move' ? { op, key, to: Number(flag(c, 'to')) } : op === 'remove' ? { op, key }
      : op === 'add' ? { op, task: { key, title: flag(c, 'title') ?? '', owner: flag(c, 'owner') ?? '', accept: flag(c, 'accept') ?? '', needs: csv(flag(c, 'needs')), lane: flag(c, 'lane') ?? null } }
      : op === 'set' ? { op, key, fields: Object.fromEntries((['title', 'owner', 'lane', 'accept', 'max_runtime'] as const).flatMap((k) => (flag(c, k.replace('_', '-')) !== undefined ? [[k, flag(c, k.replace('_', '-'))]] : []))) } : null;
    if (!req) throw new Error('--op must be move, remove, add or set');
    const r = editPlan(plan, req);
    if ('error' in r) throw new Error(r.error);
    if (!show(c, 'plan', checkPlan(p, r.plan, ctx))) throw new Error('the edited plan would not pass the check; nothing written');
    save(c, found.path, serializeProject(p, appendLog(writePlan(body, r.plan), `plan edited: ${op} ${key}`, c.today)), `plan: ${op} ${key}`);
    if (p.plan_sha) c.out('  the plan was already applied: run "plan apply" to create new tasks (removed tasks stay in Hermes until archived)');
    if (!c.apply) c.out('(dry run — add --apply)');
    return;
  }
  const board = boardFor(c, p.portfolio);
  if (!board) throw new Error(`no kanban board is mapped to "${p.portfolio}" in ${c.layoutPath}`);
  if (sub === 'diff') {
    const have = tenantTasks(c, board, p.tenant);
    const marked = new Map(have.flatMap((t) => { const m = (t.body ?? '').match(WORK_MARKER); return m && m[1] === p.id ? [[m[2], t] as const] : []; }));
    const keys = new Set((plan ?? []).map((t) => t.key));
    for (const t of plan ?? []) c.out(`  ${marked.has(t.key) ? '=' : '+'} ${t.key}${marked.has(t.key) ? `  (${marked.get(t.key)!.id}, ${marked.get(t.key)!.status})` : '  (will be created)'}`);
    for (const [k, t] of marked) if (!keys.has(k)) c.out(`  - ${k}  (${t.id}, ${t.status})  in Hermes but not in the plan`);
    const stray = have.filter((t) => !WORK_MARKER.test(t.body ?? ''));
    if (stray.length) c.out(`  ? ${stray.length} task(s) in this tenant were not created from the plan (e.g. by the auto-decomposer): ${stray.map((t) => t.id).join(', ')}`);
    if (p.plan_sha) c.out(`  plan ${planSha(plan ?? []) === p.plan_sha ? 'unchanged since it was applied' : 'CHANGED since it was applied'}`);
    return;
  }
  if (sub !== 'apply') throw new Error('usage: work plan check|apply|diff|edit <id>');
  if (p.status !== 'active') throw new Error(p.status === 'proposed' ? `the charter is not approved yet: work project approve ${p.id}` : `the project is ${p.status}; only an active project's plan can be applied`);
  const ok = show(c, 'charter', checkCharter(p, ctx)) && show(c, 'plan', checkPlan(p, plan, ctx));
  if (!ok) throw new Error('plan check failed; nothing created');
  const inactive = plan!.filter((t) => t.owner !== HUMAN && ctx.agents.find((a) => a.id === t.owner)?.state !== 'active');
  if (inactive.length) throw new Error(`these owners have no Hermes profile yet: ${[...new Set(inactive.map((t) => t.owner))].join(', ')} (run: agents sync --apply)`);

  const decisions = decisionsOf(body);
  const existing = new Map<string, KTask>();
  for (const t of tenantTasks(c, board, p.tenant)) { const m = (t.body ?? '').match(WORK_MARKER); if (m && m[1] === p.id) existing.set(m[2], t); }
  const ids = new Map<string, string>();
  let created = 0;
  for (const t of topoOrder(plan!)!) {
    if (existing.has(t.key)) {
      const ex = existing.get(t.key)!; ids.set(t.key, ex.id); c.out(`  = ${t.key} already exists (${ex.id})`);
      if (c.apply && !ex.title.startsWith(`[${p.id}]`)) { try { kanban(c, board, ['edit', ex.id, '--title', taskTitle(p, t)]); } catch { /* cosmetic */ } }
      continue;
    }
    const human = t.owner === HUMAN;
    const args = ['create', '--json', '--tenant', p.tenant, ...(human ? [] : ['--assignee', t.owner]), '--created-by', 'work', '--idempotency-key', `project:${p.id}:${t.key}`, '--max-runtime', t.max_runtime,
      ...t.needs.flatMap((k) => ['--parent', ids.get(k) ?? `<${k}>`]), ...(t.model ? ['--model', t.model] : []), ...(t.provider ? ['--provider', t.provider] : []),
      '--priority', String(hermesPriority(p.priority)), ...(t.workspace ? ['--workspace', t.workspace] : []), ...(t.goal ? ['--goal'] : []), '--body', renderTaskBody({ ...p, repo: p.repo ? (p.repo.startsWith('/') ? p.repo : join(codesDir(c), p.repo)) : null }, t, decisions, plan!), '--', taskTitle(p, t)];
    c.out(`  ${c.apply ? '+' : '·'} ${t.key}  → ${t.owner}${t.needs.length ? `  after ${t.needs.join(', ')}` : '  (starts first)'}${t.outward ? `  [outward: ${t.outward}]` : ''}`);
    if (!c.apply) { ids.set(t.key, `<${t.key}>`); continue; }
    const made = JSON.parse(kanban(c, board, args));
    ids.set(t.key, String(made.id));
    if (human) kanban(c, board, ['block', String(made.id), 'Your step: ' + t.accept.slice(0, 120)]); // nobody is assigned, so no agent can claim it
    created++;
  }
  if (c.apply) {
    const next: Project = { ...p, plan_sha: planSha(plan!) };
    save(c, found.path, serializeProject(next, appendLog(body, `plan applied: ${created} task(s) created, ${plan!.length - created} already existed`, c.today)), 'plan recorded');
  } else c.out('(dry run — add --apply)');
}

/* ---------- status / close ---------- */

function cmdStatus(c: Ctx) {
  const only = c.pos[1];
  for (const p of only ? [only] : PORTFOLIOS) {
    const objectives = existsSync(objectivesPath(c, p)) ? parseObjectives(readFileSync(objectivesPath(c, p), 'utf8')) : null;
    const projects = allProjects(c, p);
    if (!objectives && !projects.length) continue;
    c.out(`\n${p}${objectives ? ` — objectives ${objectives.horizon}, reviewed ${objectives.reviewed || 'never'}${hoursSince(objectives.reviewed, c.today) / 24 > 8 ? ' ▲ overdue' : ''}` : ''}`);
    const board = boardFor(c, p);
    for (const { project: pr } of projects) {
      let counts: Record<string, number> = {}; let n = 0; let note = '';
      if (board) {
        try { for (const t of tenantTasks(c, board, pr.tenant)) { counts[t.status] = (counts[t.status] ?? 0) + 1; n++; } } catch { note = ' (kanban unreachable)'; }
      } else note = ' (no board mapped)';
      const flags: string[] = [];
      if (n > pr.charter.max_tasks) flags.push(`OVER max_tasks (${n}/${pr.charter.max_tasks})`);
      const limit = timeboxHours(pr.timebox);
      if (pr.status === 'active' && limit && hoursSince(pr.approved ?? pr.created, c.today) > limit) flags.push('OVER timebox');
      if (pr.status === 'paused' && (counts.running || counts.ready)) flags.push(`paused but ${(counts.running ?? 0) + (counts.ready ?? 0)} task(s) still open`);
      if (pr.status === 'proposed') flags.push('charter waiting for your approval');
      c.out(`  ${pr.id.padEnd(28)}${pr.status.padEnd(10)}${n ? `${counts.done ?? 0}/${n} done` : 'no tasks'}${counts.blocked ? `, ${counts.blocked} blocked` : ''}${counts.running ? `, ${counts.running} running` : ''}${flags.length ? '  ▲ ' + flags.join('; ') : ''}${note}`);
    }
    if (board) {
      try {
        const loose = (JSON.parse(kanban(c, board, ['list', '--json'])) as KTask[]).filter((t) => !t.tenant && !planMarkerOf(t.body) && !/^Plan project /.test(t.title) && !['done', 'archived'].includes(t.status));
        if (loose.length) c.out(`  untracked (no project): ${loose.length} open task(s)`);
      } catch { /* board unreachable */ }
    }
  }
}

function cmdClose(c: Ctx) {
  const { project: p, body, path } = loadProject(c, c.pos[1] ?? '');
  const board = boardFor(c, p.portfolio);
  const open = board ? tenantTasks(c, board, p.tenant).filter((t) => !['done', 'archived'].includes(t.status)) : [];
  if (open.length && !c.flags.get('force')) throw new Error(`${open.length} task(s) are not done (${open.map((t) => `${t.id}:${t.status}`).join(', ')}); finish them or use --force`);
  const next: Project = { ...p, status: 'done' };
  save(c, path, serializeProject(next, appendLog(body, `closed${open.length ? ` (forced, ${open.length} open task(s) left)` : ''}`, c.today)), `${p.id}: ${p.status} → done`);
  c.out('  next: write the retrospective into decisions.md and update the key results in objectives.md');
  if (!c.apply) c.out('(dry run — add --apply)');
}

/* ---------- outbox ---------- */

const outboxDir = (c: Ctx, portfolio: string, project: string) => join(portfolioDir(c, portfolio), 'outbox', project);

function allOutbox(c: Ctx, only?: string): Array<{ path: string; item: OutboxItem }> {
  const out: Array<{ path: string; item: OutboxItem }> = [];
  for (const { project } of allProjects(c)) {
    if (only && project.id !== only) continue;
    const dir = outboxDir(c, project.portfolio, project.id);
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) { try { out.push({ path: join(dir, f), item: JSON.parse(readFileSync(join(dir, f), 'utf8')) as OutboxItem }); } catch { /* skip unreadable */ } }
  }
  return out;
}

function findItem(c: Ctx, id: string) {
  const f = allOutbox(c).find((x) => x.item.id === id);
  if (!f) throw new Error(`no outbox item "${id}" (see: work outbox list)`);
  return f;
}

const writeItem = (c: Ctx, path: string, item: OutboxItem, why: string) => save(c, path, JSON.stringify(item, null, 2) + '\n', why);

function cmdOutbox(c: Ctx) {
  const [, sub, arg] = c.pos;
  const line = (i: OutboxItem) => `${i.id.padEnd(34)}${i.status.padEnd(8)}${i.kind.padEnd(8)}${i.target.padEnd(24)}${i.summary.slice(0, 50)}${i.status === 'held' || i.status === 'denied' ? `  — ${i.reason}` : ''}`;
  if (sub === 'list') {
    const rows = allOutbox(c, arg);
    if (!rows.length) c.out('outbox is empty');
    for (const { item } of rows) c.out(line(item));
    return;
  }
  if (sub === 'show') { c.out(JSON.stringify(findItem(c, arg ?? '').item, null, 2)); return; }
  if (sub === 'submit') {
    const { project: p } = loadProject(c, arg ?? '');
    const kind = flag(c, 'kind') as OutboxItem['kind'] | undefined;
    if (!kind || !['publish', 'deploy', 'spend'].includes(kind)) throw new Error('--kind must be publish, deploy or spend');
    const target = flag(c, 'target'), summary = flag(c, 'summary');
    if (!target || !summary) throw new Error('--target and --summary are required');
    const usd = Number(flag(c, 'usd') ?? 0);
    if (!Number.isFinite(usd) || usd < 0) throw new Error('--usd must be a number');
    const week = allOutbox(c, p.id).filter((x) => x.item.kind === kind && x.item.status === 'done' && hoursSince(x.item.created, c.today) <= 168).length;
    const d = decide(p, { kind, target, usd }, week);
    const dir = outboxDir(c, p.portfolio, p.id);
    const existing = allOutbox(c, p.id).length;
    const id = newItemId(p.id, c.today, existing + 1);
    if (!OUTBOX_ID.test(id)) throw new Error(`cannot build an outbox id from project "${p.id}"`);
    const item: OutboxItem = { id, project: p.id, portfolio: p.portfolio, kind, target, summary, payload: flag(c, 'payload') ?? null, usd, task: flag(c, 'task') ?? null, created: c.today, status: d.status, reason: d.reason, decided_by: 'charter', result: null };
    writeItem(c, join(dir, `${id}.json`), item, `outbox ${id}: ${d.status}`);
    c.out(`  ${d.status === 'denied' ? '✗' : d.status === 'held' ? '▲' : '✓'} ${d.status}: ${d.reason}`);
    if (!c.apply) c.out('(dry run — add --apply)');
    return;
  }
  if (sub === 'release' || sub === 'deny') {
    const f = findItem(c, arg ?? '');
    if (f.item.status !== 'held') throw new Error(`only a held item can be ${sub}d (this one is ${f.item.status})`);
    const { project: p } = loadProject(c, f.item.project);
    if (sub === 'release') {
      // A human release overrides draft-only/limits, but never the charter's deny rules: re-check as if auto.
      const recheck = decide({ ...p, charter: { ...p.charter, outward: { ...p.charter.outward, publish: { ...p.charter.outward.publish, allowed: p.charter.outward.publish.allowed === 'no' ? 'no' : 'auto', max_per_week: 0 } } } }, f.item, 0);
      if (recheck.status === 'denied') throw new Error(`cannot release: ${recheck.reason}`);
    }
    const next: OutboxItem = { ...f.item, status: sub === 'release' ? 'ready' : 'denied', reason: sub === 'release' ? 'released by a human' : 'denied by a human', decided_by: 'human' };
    writeItem(c, f.path, next, `outbox ${f.item.id}: held → ${next.status}`);
    if (!c.apply) c.out('(dry run — add --apply)');
    return;
  }
  if (sub === 'run') {
    const cfgPath = c.env.OUTBOX_CONFIG ?? join(root, 'config', 'outbox.json');
    const handlers: Record<string, string[]> = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')).handlers ?? {} : {};
    const ready = allOutbox(c).filter((x) => x.item.status === 'ready');
    if (!ready.length) c.out('nothing ready');
    for (const { path, item } of ready) {
      const h = handlers[item.kind];
      if (!h?.length) { c.out(`  ▲ ${item.id}: no ${item.kind} handler in ${cfgPath.replace(homedir(), '~')}; left ready`); continue; }
      // Re-check the charter at execution time: it may have changed, or the project been paused, since submission.
      const found = loadProject(c, item.project);
      const d = decide(found.project, item, 0);
      if (d.status === 'denied') { writeItem(c, path, { ...item, status: 'denied', reason: d.reason }, `outbox ${item.id}: now denied`); continue; }
      const args = h.slice(1).map((a) => a.replaceAll('{target}', item.target).replaceAll('{payload}', item.payload ?? '').replaceAll('{summary}', item.summary).replaceAll('{usd}', String(item.usd)).replaceAll('{project}', item.project));
      c.out(`  ${c.apply ? '→' : '·'} ${item.id}: ${[h[0], ...args].join(' ')}`);
      if (!c.apply) continue;
      try { const res = c.run(h[0], args); writeItem(c, path, { ...item, status: 'done', result: res.trim().slice(0, 500) }, `outbox ${item.id}: done`); }
      catch (e) { writeItem(c, path, { ...item, status: 'failed', result: (e as Error).message.slice(0, 500) }, `outbox ${item.id}: failed`); }
    }
    if (!c.apply) c.out('(dry run — add --apply)');
    return;
  }
  throw new Error('usage: work outbox submit|list|show|release|deny|run');
}

/* ---------- projects (Cockpit's view) ---------- */

function gitState(c: Ctx, repo: string | null) {
  if (!repo) return null;
  const dir = repo.startsWith('/') ? repo : join(codesDir(c), repo);
  if (!existsSync(dir)) return { path: repo, missing: true };
  const g = (...a: string[]) => { try { return c.run('git', ['-C', dir, ...a]).trim(); } catch { return ''; } };
  return { path: repo, missing: false, branch: g('rev-parse', '--abbrev-ref', 'HEAD'), last: g('log', '-1', '--format=%cs %s').slice(0, 90), dirty: g('status', '--porcelain').split('\n').filter(Boolean).length };
}

const touchCache = new Map<string, boolean>();

function cmdProjects(c: Ctx) {
  const onlyId = flag(c, 'id');
  const boardTasks = new Map<string, KTask[] | null>(); // one `kanban list` per board, not per project
  const tasksOn = (board: string): KTask[] | null => {
    if (!boardTasks.has(board)) { try { boardTasks.set(board, JSON.parse(kanban(c, board, ['list', '--json'])) as KTask[]); } catch { boardTasks.set(board, null); } }
    return boardTasks.get(board)!;
  };
  const ctx = checkCtx(c);
  const rows = allProjects(c, c.pos[1]).filter((x) => !onlyId || x.project.id === onlyId).map(({ project: p, body }) => {
    const board = boardFor(c, p.portfolio);
    let tasks: KTask[] = []; let reachable = true;
    if (board) { const all = tasksOn(board); if (all) tasks = all.filter((t) => t.tenant === p.tenant); else reachable = false; }
    const plan = readPlan(body) ?? [];
    const byKey = new Map(tasks.flatMap((t) => { const m = (t.body ?? '').match(WORK_MARKER); return m && m[1] === p.id ? [[m[2], t] as const] : []; }));
    const byKeyIds = new Set([...byKey.values()].map((t) => t.id));
    const usage = board && reachable ? taskUsage(c.hermesHome, board, [...byKeyIds]) : new Map();
    const usageOf = (id?: string) => { const u = id ? usage.get(id) : null; return u ? { runs: u.runs, seconds: Math.round(u.seconds), tokens: u.tokens, cost: Math.round(u.cost * 1000) / 1000, models: u.models } : null; };
    const limit = timeboxHours(p.timebox);
    // Which finished tasks ran without anyone stepping in? Read each done task's events once (cached for the process).
    const done = tasks.filter((t) => t.status === 'done' && byKeyIds.has(t.id));
    const touched = new Set<string>(); let unknown = 0;
    for (const t of done) {
      let v = touchCache.get(t.id);
      if (v === undefined) { try { v = needsHuman(JSON.parse(kanban(c, board!, ['show', t.id, '--json'])).events); touchCache.set(t.id, v); } catch { unknown++; continue; } }
      if (v) touched.add(t.id);
    }
    const counts = (st: string[]) => tasks.filter((t) => byKeyIds.has(t.id) && st.includes(t.status)).length;
    return {
      auto: { done: done.length, untouched: done.length - touched.size - unknown, touched: touched.size, running: counts(['running']), waiting_on_you: counts(['blocked', 'review']) },
      log: logOf(body).slice(-12),
      ...(() => { const info = board && !!tasksOn(board) ? adviseProject(c, p, body, tasksOn(board)!) : null; const pl = info?.planning.at(-1); return { planning: pl ? { id: pl.id, status: pl.status, assignee: pl.assignee, tries: info!.planning.length, created: iso(pl.created_at), started: iso(pl.started_at), completed: iso(pl.completed_at) } : null, advance: info ? { do: info.action.do, why: 'why' in info.action ? info.action.why : '' } : null, plan_errors: info?.planErrors ?? [] }; })(),
      pm: { profile: existsSync(join(c.hermesHome, 'profiles', 'pm')), skill: existsSync(join(c.hermesHome, 'profiles', 'pm', 'skills', 'project-planning', 'SKILL.md')) },
      charter: p.charter, findings: checkCharter(p, ctx), repo_path: p.repo, decisions: decisionsOf(body),
      id: p.id, name: p.name ?? null, portfolio: p.portfolio, status: p.status, priority: p.priority, repo: p.repo, owner: p.owner, objective: p.objective, outcome: p.charter.outcome, done_when: p.charter.done_when,
      timebox: p.timebox, approved: p.approved, hours_left: limit && p.approved ? Math.round(limit - hoursSince(p.approved, c.today)) : null,
      paused_reason: p.paused_reason, max_tasks: p.charter.max_tasks, team: p.charter.team, test_cmd: p.test_cmd, applied: !!p.plan_sha, kanban: reachable, board: boardFor(c, p.portfolio),
      git: gitState(c, p.repo),
      plan: plan.map((t) => ({ usage: usageOf(byKey.get(t.key)?.id), key: t.key, title: t.title, owner: t.owner, lane: t.lane, needs: t.needs, accept: t.accept, outward: t.outward, task: byKey.get(t.key)?.id ?? null, created: iso(byKey.get(t.key)?.created_at), started: iso(byKey.get(t.key)?.started_at), completed: iso(byKey.get(t.key)?.completed_at), human: t.owner === HUMAN, touched: byKey.get(t.key) ? touched.has(byKey.get(t.key)!.id) : false, status: byKey.get(t.key)?.status ?? 'not created' })),
      stray: tasks.filter((t) => !WORK_MARKER.test(t.body ?? '')).length,
    };
  }).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  c.out(JSON.stringify(rows));
}

/* ---------- new repo ---------- */

function cmdRepoCreate(c: Ctx) {
  const [, , portfolio] = c.pos;
  if (!portfolio || !PORTFOLIOS.includes(portfolio)) throw new Error(`usage: work repo create <${PORTFOLIOS.join('|')}> --id slug --outcome "…" --done-when "…"`);
  const id = flag(c, 'id') ?? '';
  if (!SLUG.test(id)) throw new Error('--id must be a lowercase slug (letters, digits, dashes)');
  const outcome = flag(c, 'outcome') ?? '', done = flagAll(c, 'done-when');
  if (!outcome || !done.length) throw new Error('--outcome and at least one --done-when are required');
  const cfgPath = c.env.PROJECTS_CONFIG ?? join(root, 'config', 'projects.json');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : { repos: {} };
  cfg.repos ??= {};
  if (Object.values(cfg.repos as Record<string, Array<{ id: string }>>).flat().some((r) => r.id === id)) throw new Error(`repo id "${id}" is already in ${cfgPath}`);
  const dir = join(codesDir(c), id);
  if (existsSync(dir)) throw new Error(`${dir} already exists; link it instead of creating it`);
  const r = { id, title: flag(c, 'name') ?? titleOf(id), portfolio, outcome, done_when: done, test_cmd: flag(c, 'test-cmd') ?? '', created: c.today };
  c.out(`  ${c.apply ? '+' : '·'} new repo ${dir.replace(homedir(), '~')}: README.md, AGENTS.md, .gitignore, git init + first commit`);
  c.out(`  ${c.apply ? '✓' : '·'} registered as "${id}" under ${portfolio} in ${cfgPath.replace(homedir(), '~')}`);
  if (!c.apply) { c.out('(dry run — add --apply)'); return; }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), renderReadme(r));
  writeFileSync(join(dir, 'AGENTS.md'), renderAgents(r));
  writeFileSync(join(dir, '.gitignore'), GITIGNORE);
  const git = (...a: string[]) => c.run('git', ['-C', dir, ...a]);
  git('init', '-b', 'main'); git('add', '-A'); git('commit', '-m', `Start ${r.title}: README and agent notes from the project charter`);
  (cfg.repos[portfolio] ??= []).push({ id, path: id, note: 'created from Cockpit', draft: { priority: 3, test_cmd: r.test_cmd, outcome, done_when: done } });
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
}

/* ---------- repos ---------- */

function cmdRepos(c: Ctx) {
  const path = c.env.PROJECTS_CONFIG ?? join(root, 'config', 'projects.json');
  const repos = (JSON.parse(readFileSync(path, 'utf8')).repos ?? {}) as Record<string, Array<{ id: string; path: string | null; note?: string; draft?: unknown }>>;
  const base = c.env.CODES_DIR ?? join(homedir(), 'codes');
  if (c.flags.get('json') === true) { c.out(JSON.stringify(Object.entries(repos).flatMap(([portfolio, rs]) => rs.map((r) => ({ portfolio, id: r.id, path: r.path, exists: r.path ? existsSync(join(base, r.path)) : false, git: r.path ? gitState(c, r.path) : null, draft: r.draft ?? null }))))); return; }
  for (const p of c.pos[1] ? [c.pos[1]] : PORTFOLIOS) {
    if (!repos[p]?.length) continue;
    c.out(`\n${p}`);
    for (const r of repos[p]) c.out(`  ${r.id.padEnd(20)}${(r.path ?? '(not built yet)').padEnd(32)}${r.path && !existsSync(join(base, r.path)) ? '✗ folder missing' : r.note ?? ''}`);
  }
}

/* ---------- advance: the automation after approval ---------- */

interface AdvInfo { planning: KTask[]; work: KTask[]; plan: PlanTask[]; dirty: boolean; valid: boolean; planErrors: string[]; action: Action }

function adviseProject(c: Ctx, p: Project, body: string, all: KTask[]): AdvInfo {
  const plan = readPlan(body) ?? [];
  const planning = all.filter((t) => planMarkerOf(t.body) === p.id || t.title === `Plan project ${p.id}`).sort((a, b) => ((a as any).created_at ?? 0) - ((b as any).created_at ?? 0));
  const work = all.filter((t) => t.tenant === p.tenant && (t.body ?? '').match(WORK_MARKER)?.[1] === p.id);
  const dirty = !p.plan_sha || planSha(plan) !== p.plan_sha;
  const ctx = checkCtx(c);
  const f = plan.length ? checkPlan(p, plan, ctx) : { errors: [], warnings: [] };
  const valid = f.errors.length === 0 && checkCharter(p, ctx).errors.length === 0;
  return { planning, work, plan, dirty, valid, planErrors: f.errors, action: nextAction(p, plan, planning, work, dirty, valid) };
}

function cmdAdvance(c: Ctx) {
  const only = flag(c, 'project');
  const pmOk = agentsLite(c).some((a) => a.id === 'pm' && a.state === 'active');
  let acted = 0;
  for (const found of allProjects(c)) {
    const { project: p, body } = found;
    if (p.status !== 'active' || (only && p.id !== only)) continue;
    const board = boardFor(c, p.portfolio);
    if (!board) continue;
    let all: KTask[];
    try { all = JSON.parse(kanban(c, board, ['list', '--json'])) as KTask[]; } catch { c.out(`  ? ${p.id}: kanban unreachable, skipped`); continue; }
    const info = adviseProject(c, p, body, all);
    const a = info.action;
    if (a.do === 'wait') { if (c.flags.get('verbose')) c.out(`  · ${p.id}: ${a.why}`); continue; }
    if (a.do === 'stalled') { c.out(`  ▲ ${p.id}: stalled — ${a.why}`); continue; }
    acted++;
    if (a.do === 'ask-pm') {
      if (!pmOk) { c.out(`  ▲ ${p.id}: needs planning but the pm agent has no Hermes profile (agents sync --apply)`); continue; }
      const text = [PLAN_MARKER(p.id), `The charter for project "${p.id}" (${p.portfolio}) was approved. Plan it now.`,
        `Use your project-planning skill: read the charter with "npm run work -- project show ${p.id}", write a plan of at most ${p.charter.max_tasks} tasks (gate → build → verify → write-up) into the project file ${join(portfolioDir(c, p.portfolio), 'projects', p.id + '.md')} as the skill describes, then run "npm run work -- plan check ${p.id}". Do not run "plan apply": the system applies a plan that passes its checks.`,
        decisionsOf(body) ? `Decisions and notes from the owner (they apply to the whole project):\n${decisionsOf(body)}` : '',
        'If a step only the human can do (store forms, submissions, waiting for a review) gates later work, add it as a task with owner: you and let the later tasks need it. Stay inside the charter. Do not ask the human about task order, wording or which agent; decide and record it. Report back only if the charter cannot be met.'].filter(Boolean).join('\n\n');
      const key = a.retry ? `plan-project:${p.id}:2` : `plan-project:${p.id}`;
      c.out(`  ${c.apply ? '+' : '·'} ${p.id}: asking pm to plan${a.retry ? ' (second try: the first task finished without a plan)' : ''}`);
      if (c.apply) kanban(c, board, ['create', '--json', '--assignee', 'pm', '--created-by', 'work', '--idempotency-key', key, '--priority', String(hermesPriority(p.priority) + 5), '--max-runtime', '1h', '--body', text, '--', `[${p.id}] Plan the project`]);
    } else if (a.do === 'apply-plan') {
      c.out(`  ${c.apply ? '→' : '·'} ${p.id}: plan written (${info.plan.length} tasks, passes its checks); creating the tasks`);
      if (c.apply) main(['plan', 'apply', p.id, '--apply'], c.env, (s) => c.out('    ' + s), c.run);
    } else if (a.do === 'mark-review') {
      c.out(`  ${c.apply ? '✓' : '·'} ${p.id}: every task is done; waiting for your review`);
      if (c.apply) save(c, found.path, serializeProject({ ...p, status: 'review' }, appendLog(body, 'all tasks done; ready for owner review', c.today)), `${p.id}: active → review`);
    }
  }
  if (!acted) c.out('advance: nothing to do');
  if (acted && !c.apply) c.out('(dry run — add --apply)');
}

/* ---------- watchdog ---------- */

function cmdWatch(c: Ctx) {
  const now = c.env.WORK_NOW ?? new Date().toISOString();
  let flagged = 0;
  for (const found of allProjects(c)) {
    const { project: p, body } = found;
    if (p.status !== 'active') continue;
    const board = boardFor(c, p.portfolio);
    if (!board) continue;
    let tasks: KTask[];
    try { tasks = tenantTasks(c, board, p.tenant); } catch { c.out(`  ? ${p.id}: kanban unreachable, skipped`); continue; }
    let minutes = 0;
    for (const t of tasks) { try { minutes += runMinutes(JSON.parse(kanban(c, board, ['runs', '--json', t.id]))); } catch { /* no run data for this task */ } }
    const v = evaluateProject(p, tasks, minutes, now);
    if (!v.pause) { c.out(`  ✓ ${p.id}: within its charter (${tasks.length}/${p.charter.max_tasks} tasks, ${Math.round(minutes)}/${p.charter.budget.lane_minutes} lane min)`); continue; }
    flagged++;
    c.out(`  ▲ ${p.id}: ${v.reasons.join('; ')}${v.hold.length ? ` → will hold ${v.hold.length} open task(s)` : ''}`);
    if (!c.apply) continue;
    for (const id of v.hold) { try { kanban(c, board, ['block', '--kind', 'needs_input', id, `work watchdog: ${v.reasons[0]}`]); } catch (e) { c.out(`    could not block ${id}: ${(e as Error).message.split('\n')[0]}`); } }
    const reason = v.reasons.join('; ');
    save(c, found.path, serializeProject({ ...p, status: 'paused', paused_reason: reason }, appendLog(body, `paused by the watchdog: ${reason}`, c.today)), `${p.id}: active → paused`);
  }
  // Objectives not reviewed for more than a week and a day.
  for (const portfolio of PORTFOLIOS) {
    if (!existsSync(objectivesPath(c, portfolio))) continue;
    const o = parseObjectives(readFileSync(objectivesPath(c, portfolio), 'utf8'));
    if (o.items.length && hoursSince(o.reviewed || null, c.today) / 24 > 8) c.out(`  ▲ ${portfolio}: objectives not reviewed since ${o.reviewed || 'ever'}`);
  }
  if (!flagged) c.out('watchdog: nothing to enforce');
  if (flagged && !c.apply) c.out('(dry run — add --apply)');
}

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, out: (s: string) => void = console.log, run?: Ctx['run']): number {
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { out(`error: ${(e as Error).message}`); return 1; }
  const c: Ctx = {
    kb: env.PORTFOLIO_KB ?? join(homedir(), 'PortfolioKB'),
    layoutPath: env.COCKPIT_LAYOUT ?? join(root, 'config', 'cockpit.json'),
    registryPath: env.AGENTS_REGISTRY ?? join(root, 'config', 'agents.json'),
    hermesBin: env.HERMES_BIN ?? join(homedir(), '.local', 'bin', 'hermes'),
    hermesHome: env.HERMES_HOME ?? join(homedir(), '.hermes'),
    templateDir: env.KB_TEMPLATE ?? join(root, 'kb-template'),
    today: env.WORK_TODAY ?? new Date().toISOString().slice(0, 10),
    out, apply: parsed.flags.get('apply') === true, flags: parsed.flags, pos: parsed.pos, env,
    run: run ?? ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })),
  };
  try {
    const cmd = c.pos[0];
    if (cmd === 'kb') cmdKb(c);
    else if (cmd === 'objective') cmdObjective(c);
    else if (cmd === 'project') cmdProject(c);
    else if (cmd === 'plan') cmdPlan(c);
    else if (cmd === 'status') cmdStatus(c);
    else if (cmd === 'close') cmdClose(c);
    else if (cmd === 'outbox') cmdOutbox(c);
    else if (cmd === 'watch') cmdWatch(c);
    else if (cmd === 'advance') cmdAdvance(c);
    else if (cmd === 'repos') cmdRepos(c);
    else if (cmd === 'repo' && c.pos[1] === 'create') cmdRepoCreate(c);
    else if (cmd === 'projects') cmdProjects(c);
    else { out('usage: work <kb init | objective | project | plan | status | close | outbox | watch | advance | repos | projects> … [--apply]'); return cmd ? 2 : 0; }
    return 0;
  } catch (e) {
    out(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) process.exit(main(process.argv.slice(2)));
