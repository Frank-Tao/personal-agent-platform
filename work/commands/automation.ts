import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUBTASK_LINE, WORK_MARKER, type PlanTask, type Project, appendLog, fullAutoBlockers, isFinishedStatus, checkCharter, checkPlan, decisionsOf, hermesPriority, parseObjectives, readPlan, serializeProject } from '../../packages/work/model.ts';
import { decide } from '../../packages/work/outbox.ts';
import { readDecisions, setStatus } from '../../packages/work/decisions.ts';
import { PLAN_MARKER, nextAction, planMarkerOf, type Action } from '../../packages/work/advance.ts';
import { REASSIGN_MARK, heldByPrGuard, nudgeTask, type NudgeTask } from '../../packages/work/nudge.ts';
import { evaluateProject, runMinutes } from '../../packages/work/watch.ts';

import { PORTFOLIOS, agentsLite, allProjects, boardOf, checkCtx, deepestHop, flag, hoursSince, kanban, nowIso, objectivesPath, planSha, portfolioDir, recoverMarkers, save, show, tenantTasks, type Ctx, type KTask } from '../shared.ts';

/* ---------- advance: the automation after approval ---------- */

export interface AdvInfo { planning: KTask[]; work: KTask[]; plan: PlanTask[]; dirty: boolean; valid: boolean; planErrors: string[]; action: Action }

export function adviseProject(c: Ctx, p: Project, body: string, all: KTask[]): AdvInfo {
  const plan = readPlan(body) ?? [];
  const planning = all.filter((t) => planMarkerOf(t.body) === p.id || t.title === `Plan project ${p.id}`).sort((a, b) => ((a as any).created_at ?? 0) - ((b as any).created_at ?? 0));
  const work = all.filter((t) => t.tenant === p.tenant && (t.body ?? '').match(WORK_MARKER)?.[1] === p.id);
  const dirty = !p.plan_sha || planSha(plan) !== p.plan_sha;
  // tasks already done or archived do not count against the limit of active tasks
  const finished = new Set(work.filter((t) => isFinishedStatus(t.status)).map((t) => (t.body ?? '').match(WORK_MARKER)![2]));
  const ctx = { ...checkCtx(c), finished };
  const f = plan.length ? checkPlan(p, plan, ctx) : { errors: [], warnings: [] };
  const valid = f.errors.length === 0 && checkCharter(p, ctx).errors.length === 0;
  return { planning, work, plan, dirty, valid, planErrors: f.errors, action: nextAction(p, plan, planning, work, dirty, valid) };
}

export function cmdAdvance(c: Ctx) {
  const only = flag(c, 'project');
  const pmOk = agentsLite(c).some((a) => a.id === 'pm' && a.state === 'active');
  let acted = 0;
  acted += fullAutomation(c, only);
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
        `Use your project-planning skill: read the charter with "npm run work -- project show ${p.id}", write a plan with at most ${p.charter.max_tasks} ACTIVE top-level tasks at a time (finished tasks do not count; group related tasks under a parent task rather than asking for more room) (gate → build → verify → write-up) (if it would need more, merge steps and turn the small ones into subtasks of the closest task; subtasks do not count toward the cap) into the project file ${join(portfolioDir(c, p.portfolio), 'projects', p.id + '.md')} as the skill describes, then run "npm run work -- plan check ${p.id}". Do not run "plan apply": the system applies a plan that passes its checks.`,
        decisionsOf(body) ? `Decisions and notes from the owner (they apply to the whole project):\n${decisionsOf(body)}` : '',
        'If a step only the human can do (store forms, submissions, waiting for a review) gates later work, add it as a task with owner: you and let the later tasks need it. Stay inside the charter. Do not ask the human about task order, wording or which agent; decide and record it. Report back only if the charter cannot be met.'].filter(Boolean).join('\n\n');
      const key = a.retry ? `plan-project:${p.id}:2` : `plan-project:${p.id}`;
      c.out(`  ${c.apply ? '+' : '·'} ${p.id}: asking pm to plan${a.retry ? ' (second try: the first task finished without a plan)' : ''}`);
      if (c.apply) kanban(c, board, ['create', '--json', '--assignee', 'pm', '--created-by', 'work', '--idempotency-key', key, '--priority', String(hermesPriority(p.priority) + 5), '--max-runtime', '1h', '--body', text, '--', `[${p.id}] Plan the project`]);
    } else if (a.do === 'apply-plan') {
      c.out(`  ${c.apply ? '→' : '·'} ${p.id}: plan written (${info.plan.length} tasks, passes its checks); creating the tasks`);
      if (c.apply) c.rerun?.(['plan', 'apply', p.id, '--apply'], (s) => c.out('    ' + s));
    } else if (a.do === 'mark-review') {
      // Full automation: a project whose plan had a QA step (all done by now) closes by itself; the owner gets the result, not a review request.
      if (p.autonomy === 'full' && !fullAutoBlockers(p).length && info.plan.some((t) => t.owner === 'qa')) {
        c.out(`  ${c.apply ? '✓' : '·'} ${p.id}: every task is done and QA verified it; closing (full automation)`);
        if (c.apply) c.rerun?.(['close', p.id, '--by', 'automation (full)', '--reason', 'Every task is done and the QA step passed; closed by full automation. Reopen it if the result is not right.', '--apply'], (s) => c.out('    ' + s));
        continue;
      }
      c.out(`  ${c.apply ? '✓' : '·'} ${p.id}: every task is done; waiting for your review`);
      if (c.apply) save(c, found.path, serializeProject({ ...p, status: 'review' }, appendLog(body, 'all tasks done; ready for owner review', c.today)), `${p.id}: active → review`);
    }
  }
  if (!acted) c.out('advance: nothing to do');
  if (acted && !c.apply) c.out('(dry run — add --apply)');
}

/** Full automation, before the normal pass: start charters whose grace window is over, and confirm agents' proposed decisions from before today.
 *  Projects that are semi, or full but with something only the owner may allow (fullAutoBlockers), are left to the owner. Returns how many things it did. */
function fullAutomation(c: Ctx, only?: string): number {
  let n = 0;
  const now = Date.parse(nowIso(c));
  for (const found of allProjects(c)) {
    const { project: p } = found;
    if (p.autonomy !== 'full' || (only && p.id !== only)) continue;
    const blockers = fullAutoBlockers(p);
    if (blockers.length) { if (p.status === 'proposed' && c.flags.get('verbose')) c.out(`  · ${p.id}: full automation, but waits for you: ${blockers.join('; ')}`); continue; }
    if (p.status === 'proposed') {
      const at = Date.parse(p.auto_start_after ?? '');
      if (!Number.isFinite(at)) continue;                                  // no window set: the owner switches it on with project set --autonomy full
      if (at > now) { if (c.flags.get('verbose')) c.out(`  · ${p.id}: starts by itself at ${p.auto_start_after}`); continue; }
      n++;
      c.out(`  ${c.apply ? '▶' : '·'} ${p.id}: full automation — the grace window is over; approving the charter`);
      if (c.apply) c.rerun?.(['project', 'approve', p.id, '--by', 'automation (full)', '--note', 'Started by full automation after the grace window (no deploy, publish, spend or new agents in this charter).', '--apply'], (s) => c.out('    ' + s));
      continue;
    }
    if (!['active', 'review', 'done'].includes(p.status)) continue;      // a hand-off harvested at the end can still propose one
    for (const d of readDecisions(c.kb, { portfolio: p.portfolio, project: p.id, status: 'proposed' })) {
      if (d.kind !== 'decision' || d.legacy || d.date >= c.today) continue;   // questions need an answer; give the owner the rest of the day
      n++;
      c.out(`  ${c.apply ? '✓' : '·'} ${p.id}: confirming "${d.title.slice(0, 70)}" (${d.ref}, proposed ${d.date} by ${d.by}; full automation)`);
      if (c.apply) { try { setStatus(c.kb, d.ref, 'active', 'automation (full)', 'confirmed by full automation the day after it was proposed; revert it if it is wrong'); } catch (e) { c.out(`    could not confirm ${d.ref}: ${(e as Error).message}`); } }
    }
  }
  return n;
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
    for (const t of tasks.filter((x) => ['todo', 'blocked', 'ready'].includes(x.status))) {
      let d: { parents?: string[]; events?: NudgeTask['events']; comments?: NudgeTask['comments'] };
      try { d = JSON.parse(kanban(c, board, ['show', '--json', t.id])); } catch { continue; }
      const input = { id: t.id, status: t.status, parents: (d.parents ?? []).map((id) => ({ id, status: status.get(id) ?? 'unknown' })), events: d.events ?? [], comments: d.comments ?? [] };
      // Held back by Hermes' "open PR" guard although every PR it names is merged or closed: hand it to the same agent again
      const held = heldByPrGuard(input, nowSec);
      if (held) {
        let open: string[] = [];
        try { open = held.prs.filter((u) => !['MERGED', 'CLOSED'].includes((JSON.parse(c.run(c.env.GH_BIN ?? 'gh', ['pr', 'view', u, '--json', 'state'])) as { state: string }).state)); } catch { open = held.prs; }
        const label = `${p.id} · ${t.title.replace(/^\[[^\]]*\]\s*/, '').slice(0, 60)} (${t.id})`;
        if (!open.length && t.assignee) {
          acted++;
          c.out(`  ${c.apply ? '→' : '·'} ${label}: held back for an open PR that is merged or closed (${held.prs.length}) — reassigning to ${t.assignee}`);
          if (c.apply) { try { kanban(c, board, ['comment', t.id, `${REASSIGN_MARK}] work nudge: the PR(s) it names are merged or closed (${held.prs.join(', ')}), so Hermes' open-PR guard was holding the task back; reassigned to ${t.assignee} to continue.`]); kanban(c, board, ['reassign', t.id, t.assignee]); } catch (e) { c.out(`    could not reassign ${t.id}: ${(e as Error).message.split('\n')[0]}`); } }
        }
        continue;
      }
      if (t.status === 'ready') continue;
      const a = nudgeTask(input, nowSec, agents);
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
    if (!v.pause) { c.out(`  ✓ ${p.id}: within its charter (${tasks.filter((t) => t.status !== 'done' && t.status !== 'archived' && !SUBTASK_LINE.test(t.body ?? '')).length}/${p.charter.max_tasks} active tasks, ${Math.round(minutes)}/${p.charter.budget.lane_minutes} lane min)`); continue; }
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
