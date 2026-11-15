import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { main as agentsMain } from '../../agents/cli.ts';
import { loadRegistry } from '../../packages/roster/roster.ts';
import { BODY_TEMPLATE, HUMAN, WORK_MARKER, type PlanTask, type Project, type Status, addDecision, appendLog, checkCharter, checkPlan, emptyCharter, hermesPriority, readPlan, serializeProject } from '../../packages/work/model.ts';
import { suggestTeam } from '../../packages/work/team.ts';

import { agentsLite, allProjects, boardOf, checkCtx, csv, flag, flagAll, kanban, loadProject, portfolioDir, resolveRepo, save, show, tenantTasks, type Ctx } from '../shared.ts';
import { noteDecision } from './decisions.ts';

/* ---------- projects ---------- */

export function summary(c: Ctx, p: Project) {
  const ch = p.charter;
  c.out(`${p.id} [${p.status}] ${p.portfolio}${p.objective ? ` · ${p.objective}` : ''} · owner ${p.owner} · timebox ${p.timebox} · max ${ch.max_tasks} tasks`);
  c.out(`  outcome: ${ch.outcome}`);
  for (const d of ch.done_when) c.out(`  done when: ${d}`);
  c.out(`  team: ${ch.team.join(', ')}${ch.new_agents.length ? ` (new: ${ch.new_agents.map((n) => n.id).join(', ')})` : ''}`);
  c.out(`  outward: deploy ${ch.outward.deploy.allowed ? 'to ' + ch.outward.deploy.targets.join(',') : 'no'} · publish ${ch.outward.publish.allowed} · spend ${ch.outward.spend.allowed ? '≤$' + ch.outward.spend.max_usd : 'no'}`);
}

export function cmdProject(c: Ctx) {
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
    c.out(plan ? `  plan: ${plan.filter((t) => !t.parent).length} task(s), ${plan.filter((t) => t.parent).length} subtask(s)` : '  plan: none yet');
    if (plan) show(c, 'plan', checkPlan(p, plan, checkCtx(c)));
    if (plan) {
      // The task tree: each top-level task, its subtasks indented below it, with the live Hermes status when the board is reachable.
      const status = new Map<string, string>();
      const board = boardOf(c, p);
      if (board) { try { for (const t of tenantTasks(c, board, p.tenant)) { const m = (t.body ?? '').match(WORK_MARKER); if (m && m[1] === p.id) status.set(m[2], t.status); } } catch { /* kanban unreachable: show the plan only */ } }
      const line = (t: PlanTask, indent: string) => `${indent}${(status.get(t.key) ?? 'not created').padEnd(12)} ${t.key.padEnd(20)} ${t.owner.padEnd(9)} ${t.title}`;
      for (const t of plan.filter((x) => !x.parent)) { c.out(line(t, '  ')); for (const sb of plan.filter((x) => x.parent === t.key)) c.out(line(sb, '      ')); }
    }
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
    noteDecision(c, { portfolio: p.portfolio, project: p.id, title: `Charter approved: ${p.charter.outcome}`, why: note || 'Approved by the owner; pm plans the tasks and the agents start.', by: flag(c, 'by') ?? 'owner', source: 'approval' });
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
    if (prio !== p.priority || team.join() !== p.charter.team.join()) noteDecision(c, { portfolio: p.portfolio, project: p.id, title: `Project settings changed: ${changes}`, why: flag(c, 'reason') ?? '', by: flag(c, 'by') ?? 'owner', source: 'manual' });
    if (c.apply && prio !== p.priority) {
      const board = boardOf(c, p);
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
    const board = boardOf(c, p);
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
  if (sub === 'retry-task') {
    const key = c.pos[3] ?? '';
    const taskId = flag(c, 'task');   // a step Hermes created inside a plan task has no plan key: pick it by id (it must belong to this project)
    const board = boardOf(c, p);
    if (!board) throw new Error(`no board for ${p.portfolio}`);
    const mine = tenantTasks(c, board, p.tenant);
    const task = taskId ? mine.find((t) => t.id === taskId) : mine.find((t) => { const m = (t.body ?? '').match(WORK_MARKER); return m?.[1] === p.id && m?.[2] === key; });
    if (!task) throw new Error(taskId ? `no task ${taskId} in ${p.id}` : `the task "${key}" has not been created in Hermes`);
    const label = taskId ? task.id : key;
    if (task.status !== 'blocked') throw new Error(`"${label}" is ${task.status}, not blocked: only a blocked task can be retried`);
    const note = (flag(c, 'note') ?? '').trim().slice(0, 1000);
    c.out(`  ${c.apply ? '↻' : '·'} retry ${label} (${task.id})${note ? `: ${note}` : ' with no note'}`);
    if (c.apply) {
      kanban(c, board, ['unblock', '--reason', note ? `Retry by Frank: ${note}` : 'Retry by Frank', task.id]);
      save(c, found.path, serializeProject(p, appendLog(body, `task "${label}" retried by you${note ? ': ' + note.slice(0, 120) : ''}`, c.today)), 'logged');
    } else c.out('(dry run — add --apply)');
    return;
  }
  if (sub === 'step-done') {
    const key = c.pos[3] ?? '';
    const step = (readPlan(body) ?? []).find((t) => t.key === key);
    if (!step || step.owner !== HUMAN) throw new Error(`"${key}" is not a step for you in ${p.id}'s plan`);
    const board = boardOf(c, p);
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
  if (sub === 'reopen') {
    // A finished project goes back to "proposed": the charter (now allowed to change) needs your approval again, then `plan apply` adds the new tasks.
    if (!['done', 'review', 'paused'].includes(p.status)) throw new Error(`only a done, review or paused project can be reopened (cancelled is final; this one is ${p.status})`);
    const why = (flag(c, 'reason') ?? '').trim().replace(/\s+/g, ' ');
    if (!why) throw new Error('usage: work project reopen <id> --reason "what is being added or changed" [--apply]');
    const next: Project = { ...p, status: 'proposed', approved: null, paused_reason: null };
    save(c, found.path, serializeProject(next, appendLog(body, `reopened: ${why}`, c.today)), `${p.id}: ${p.status} → proposed (charter needs your approval again; edit it with: work project edit ${p.id}, approve with: work project approve ${p.id})`);
    if (!c.apply) c.out('(dry run — add --apply)');
    return;
  }
  throw new Error('usage: work project list|propose|show|set|edit|approve|pause|resume|cancel|reopen');
}

export function propose(c: Ctx) {
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
    timebox: flag(c, 'timebox') ?? '7d', created: c.today, approved: null, repo: resolveRepo(c, flag(c, 'repo')), priority: Number(flag(c, 'priority') ?? 3), test_cmd: flag(c, 'test-cmd') ?? null, plan_sha: null, board: null, paused_reason: null,
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
