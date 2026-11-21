import { join } from 'node:path';
import { dataDir } from '../../packages/paths/paths.ts';
import { readPlan } from '../../packages/work/model.ts';
import { buildScorecard, readStaffing, recordStaffing, scorecardLines, type PlanReasons } from '../../packages/work/scorecard.ts';
import { agentsLite, allProjects, flag, kanban, type Ctx } from '../shared.ts';

/** Owner reasons pm wrote in every project's plan, by "<project>/<key>". */
export function planReasons(c: Ctx): PlanReasons {
  const m: PlanReasons = new Map();
  for (const { project, body } of allProjects(c)) for (const t of readPlan(body) ?? []) m.set(`${project.id}/${t.key}`, { owner: t.owner, why: t.why ?? null });
  return m;
}

export function scorecardOf(c: Ctx, days = 28) {
  return buildScorecard({ boardsDir: join(c.hermesHome, 'kanban', 'boards'), plans: planReasons(c), staffing: readStaffing(dataDir(c.env)), now: c.env.WORK_NOW ? new Date(c.env.WORK_NOW) : new Date(), days });
}

/**
 * work scorecard [--days 28] [--json]: each agent's track record (finished, first-time passes, needing you, failures, against the window
 * before) and how each decider's choices of owner turned out, next to the reason given.
 */
export function cmdScorecard(c: Ctx) {
  const days = Math.min(180, Math.max(1, Number(flag(c, 'days') ?? 28) || 28));
  const s = scorecardOf(c, days);
  if (c.flags.get('json') === true) { c.out(JSON.stringify(s)); return; }
  c.out(`Track record, last ${days} days (since ${s.since.slice(0, 10)})`);
  for (const l of scorecardLines(s, 50)) c.out('  ' + l);
  for (const a of s.agents) c.out(`  · ${a.agent}: ${a.trust} — ${a.why}`);
  for (const d of s.deciders) for (const p of d.recent.slice(0, 3)) c.out(`  ${d.by.padEnd(10)} → ${p.agent.padEnd(9)} ${p.outcome.padEnd(13)} ${p.title.slice(0, 50)}${p.why ? `  — ${p.why}` : '  — (no reason given)'}`);
}

/**
 * work assign --board <slug> <task> <agent> --why "…" --by <atlas|name> [--apply]: give a task an owner and record why. A task parked
 * `blocked` for a staffing decision is released. The reason is shown later next to how the task went (work scorecard).
 */
export function cmdAssign(c: Ctx) {
  const [, task, agent] = c.pos;
  const board = flag(c, 'board') ?? '';
  const why = (flag(c, 'why') ?? '').replace(/\s+/g, ' ').trim();
  const by = (flag(c, 'by') ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(board)) throw new Error('--board <slug> is required');
  if (!/^t_[a-z0-9]{4,20}$/i.test(task ?? '')) throw new Error('usage: work assign --board <slug> <task id> <agent> --why "…" --by <atlas|name> [--apply]');
  const a = agentsLite(c).find((x) => x.id === agent || x.profile === agent);
  if (!a || a.state !== 'active') throw new Error(`"${agent}" is not an active agent (npm run agents -- list)`);
  if (why.length < 10) throw new Error('--why: one sentence on why this agent (it is shown next to how the task went)');
  if (!/^[A-Za-z][A-Za-z0-9 .'-]{0,40}$/.test(by)) throw new Error('--by: who decided (atlas, pm, or a person\'s name)');
  const cur = JSON.parse(kanban(c, board, ['show', '--json', task])) as { task?: { status?: string; assignee?: string }; status?: string };
  const status = String(cur.task?.status ?? cur.status ?? '');
  if (!status) throw new Error(`no task ${task} on ${board}`);
  if (['done', 'archived'].includes(status)) throw new Error(`${task} is already ${status}`);
  c.out(`  ${c.apply ? '→' : '·'} ${task} → ${a.profile}${status === 'blocked' ? ' (and released: it was waiting for an owner)' : ''}: ${why}`);
  if (!c.apply) { c.out('(dry run — add --apply)'); return; }
  kanban(c, board, ['assign', task, a.profile]);
  if (status === 'blocked') kanban(c, board, ['unblock', task]);
  recordStaffing(dataDir(c.env), { at: new Date().toISOString(), board, task, agent: a.profile, by, why: why.slice(0, 300) });
}
