import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUBTASK_LINE, WORK_MARKER, type PlanTask, type Project, appendLog, checkCharter, checkPlan, decisionsOf, hermesPriority, parseObjectives, readPlan, serializeProject } from '../../packages/work/model.ts';
import { decide } from '../../packages/work/outbox.ts';
import { PLAN_MARKER, nextAction, planMarkerOf, type Action } from '../../packages/work/advance.ts';
import { nudgeTask, type NudgeTask } from '../../packages/work/nudge.ts';
import { evaluateProject, runMinutes } from '../../packages/work/watch.ts';

import { PORTFOLIOS, agentsLite, allProjects, boardOf, checkCtx, deepestHop, flag, hoursSince, kanban, objectivesPath, planSha, portfolioDir, recoverMarkers, save, show, tenantTasks, type Ctx, type KTask } from '../shared.ts';

/* ---------- advance: the automation after approval ---------- */

export interface AdvInfo { planning: KTask[]; work: KTask[]; plan: PlanTask[]; dirty: boolean; valid: boolean; planErrors: string[]; action: Action }

export function adviseProject(c: Ctx, p: Project, body: string, all: KTask[]): AdvInfo {
  const plan = readPlan(body) ?? [];
  const planning = all.filter((t) => planMarkerOf(t.body) === p.id || t.title === `Plan project ${p.id}`).sort((a, b) => ((a as any).created_at ?? 0) - ((b as any).created_at ?? 0));
  const work = all.filter((t) => t.tenant === p.tenant && (t.body ?? '').match(WORK_MARKER)?.[1] === p.id);
  const dirty = !p.plan_sha || planSha(plan) !== p.plan_sha;
  const ctx = checkCtx(c);
  const f = plan.length ? checkPlan(p, plan, ctx) : { errors: [], warnings: [] };
  const valid = f.errors.length === 0 && checkCharter(p, ctx).errors.length === 0;
  return { planning, work, plan, dirty, valid, planErrors: f.errors, action: nextAction(p, plan, planning, work, dirty, valid) };
}

export function cmdAdvance(c: Ctx) {
  const only = flag(c, 'project');
  const pmOk = agentsLite(c).some((a) => a.id === 'pm' && a.state === 'active');
  let acted = 0;
  for (const found of allProjects(c)) {
    const { project: p, body } = found;
    if (p.status !== 'active' || (only && p.id !== only)) continue;
    const board = boardOf(c, p);
    if (!board) continue;
    let all: KTask[];
    try { all = recoverMarkers(c, board, JSON.parse(kanban(c, board, ['list', '--json'])) as KTask[]); } catch { c.out(`  ? ${p.id}: kanban unreachable, skipped`); continue; }
    const info = adviseProject(c, p, body, all);
    const a = info.action;
    if (a.do === 'wait') { if (c.flags.get('verbose')) c.out(`  · ${p.id}: ${a.why}`); continue; }
    if (a.do === 'stalled') { c.out(`  ▲ ${p.id}: stalled — ${a.why}`); continue; }
    acted++;
    if (a.do === 'ask-pm') {
      if (!pmOk) { c.out(`  ▲ ${p.id}: needs planning but the pm agent has no Hermes profile (agents sync --apply)`); continue; }
      const text = [PLAN_MARKER(p.id), `The charter for project "${p.id}" (${p.portfolio}) was approved. Plan it now.`,
        `Use your project-planning skill: read the charter with "npm run work -- project show ${p.id}", write a plan of at most ${p.charter.max_tasks} tasks (gate → build → verify → write-up) (if it would need more, merge steps and turn the small ones into subtasks of the closest task; subtasks do not count toward the cap) into the project file ${join(portfolioDir(c, p.portfolio), 'projects', p.id + '.md')} as the skill describes, then run "npm run work -- plan check ${p.id}". Do not run "plan apply": the system applies a plan that passes its checks.`,
        decisionsOf(body) ? `Decisions and notes from the owner (they apply to the whole project):\n${decisionsOf(body)}` : '',
        'If a step only the human can do (store forms, submissions, waiting for a review) gates later work, add it as a task with owner: you and let the later tasks need it. Stay inside the charter. Do not ask the human about task order, wording or which agent; decide and record it. Report back only if the charter cannot be met.'].filter(Boolean).join('\n\n');
      const key = a.retry ? `plan-project:${p.id}:2` : `plan-project:${p.id}`;
      c.out(`  ${c.apply ? '+' : '·'} ${p.id}: asking pm to plan${a.retry ? ' (second try: the first task finished without a plan)' : ''}`);
      if (c.apply) kanban(c, board, ['create', '--json', '--assignee', 'pm', '--created-by', 'work', '--idempotency-key', key, '--priority', String(hermesPriority(p.priority) + 5), '--max-runtime', '1h', '--body', text, '--', `[${p.id}] Plan the project`]);
    } else if (a.do === 'apply-plan') {
      c.out(`  ${c.apply ? '→' : '·'} ${p.id}: plan written (${info.plan.length} tasks, passes its checks); creating the tasks`);
      if (c.apply) c.rerun?.(['plan', 'apply', p.id, '--apply'], (s) => c.out('    ' + s));
    } else if (a.do === 'mark-review') {
      c.out(`  ${c.apply ? '✓' : '·'} ${p.id}: every task is done; waiting for your review`);
      if (c.apply) save(c, found.path, serializeProject({ ...p, status: 'review' }, appendLog(body, 'all tasks done; ready for owner review', c.today)), `${p.id}: active → review`);
    }
  }
  if (!acted) c.out('advance: nothing to do');
  if (acted && !c.apply) c.out('(dry run — add --apply)');
}

/* ---------- nudge: keep tasks moving ---------- */

export function cmdNudge(c: Ctx) {
  const only = flag(c, 'project');
  const agents = new Set(agentsLite(c).map((a) => a.id));
  const nowSec = c.env.WORK_NOW ? Date.parse(c.env.WORK_NOW) / 1000 : Date.now() / 1000;
  let acted = 0, escalated = 0;
  for (const found of allProjects(c)) {
    const { project: p } = found;
    if (p.status !== 'active' || (only && p.id !== only)) continue;
    const board = boardOf(c, p);
    if (!board) continue;
    let tasks: KTask[];
    try { tasks = tenantTasks(c, board, p.tenant); } catch { c.out(`  ? ${p.id}: kanban unreachable, skipped`); continue; }
    const status = new Map(tasks.map((t) => [t.id, t.status]));
    for (const t of tasks.filter((x) => x.status === 'todo' || x.status === 'blocked')) {
      let d: { parents?: string[]; events?: NudgeTask['events']; comments?: NudgeTask['comments'] };
      try { d = JSON.parse(kanban(c, board, ['show', '--json', t.id])); } catch { continue; }
      const a = nudgeTask({ id: t.id, status: t.status, parents: (d.parents ?? []).map((id) => ({ id, status: status.get(id) ?? 'unknown' })), events: d.events ?? [], comments: d.comments ?? [] }, nowSec, agents);
      if (!a) continue;
      const label = `${p.id} · ${t.title.replace(/^\[[^\]]*\]\s*/, '').slice(0, 60)} (${t.id})`;
      if (a.do === 'escalate') { escalated++; c.out(`  ▲ ${label}: needs you — ${a.why}`); continue; }
      acted++;
      c.out(`  ${c.apply ? '→' : '·'} ${label}: ${a.do === 'promote' ? 'promote' : `retry ${a.attempt}`} — ${a.why}`);
      if (!c.apply) continue;
      try {
        if (a.do === 'promote') kanban(c, board, ['promote', t.id, 'work nudge: ' + a.why]);
        else kanban(c, board, ['unblock', '--reason', `[auto-retry ${a.attempt}] work nudge: ${a.why}`, t.id]);
      } catch (e) { c.out(`    could not ${a.do} ${t.id}: ${(e as Error).message.split('\n')[0]}`); }
    }
  }
  if (!acted && !escalated) c.out('nudge: nothing is stuck');
  if (acted && !c.apply) c.out('(dry run — add --apply)');
}

/* ---------- watchdog ---------- */

export function cmdWatch(c: Ctx) {
  const now = c.env.WORK_NOW ?? new Date().toISOString();
  let flagged = 0;
  for (const found of allProjects(c)) {
    const { project: p, body } = found;
    if (p.status !== 'active') continue;
    const board = boardOf(c, p);
    if (!board) continue;
    let tasks: KTask[];
    try { tasks = tenantTasks(c, board, p.tenant); } catch { c.out(`  ? ${p.id}: kanban unreachable, skipped`); continue; }
    let minutes = 0;
    for (const t of tasks) { try { minutes += runMinutes(JSON.parse(kanban(c, board, ['runs', '--json', t.id]))); } catch { /* no run data for this task */ } }
    const v = evaluateProject(p, tasks, minutes, now, deepestHop(c, board, tasks));
    if (!v.pause) { c.out(`  ✓ ${p.id}: within its charter (${tasks.filter((t) => !SUBTASK_LINE.test(t.body ?? '')).length}/${p.charter.max_tasks} tasks, ${Math.round(minutes)}/${p.charter.budget.lane_minutes} lane min)`); continue; }
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
