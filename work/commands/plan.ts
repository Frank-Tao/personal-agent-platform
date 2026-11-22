import { readDelivery } from '../../packages/work/delivery.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HUMAN, SUBTASK_LINE, WORK_MARKER, type Project, isFinishedStatus, appendLog, checkCharter, checkPlan, decisionsOf, hermesPriority, parseObjectives, readPlan, renderTaskBody, serializeProject, timeboxHours, topoOrder, writePlan } from '../../packages/work/model.ts';
import { planMarkerOf } from '../../packages/work/advance.ts';
import { editPlan, type PlanOp } from '../../packages/work/planedit.ts';
import { suggestRegroup } from '../../packages/work/regroup.ts';

import { PORTFOLIOS, nowIso, allProjects, boardFor, boardOf, checkCtx, codesDir, coreRepoViolation, csv, finishedKeys, flag, hoursSince, kanban, loadProject, objectivesPath, planSha, repoHasRemote, save, show, taskTitle, tenantTasks, type Ctx, type KTask } from '../shared.ts';
import { noteDecision } from './decisions.ts';

/* ---------- plans ---------- */

export function cmdPlan(c: Ctx) {
  const [, sub, id] = c.pos;
  const found = loadProject(c, id ?? '');
  const { project: p, body } = found;
  const plan = readPlan(body);
  // Finished tasks do not count against the limit of active tasks, so the checks need to know which ones are finished.
  const ctx = { ...checkCtx(c), finished: finishedKeys(c, p) };
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
      : op === 'add' ? { op, task: { key, title: flag(c, 'title') ?? '', owner: flag(c, 'owner') ?? '', accept: flag(c, 'accept') ?? '', needs: csv(flag(c, 'needs')), lane: flag(c, 'lane') ?? null, ...(flag(c, 'desc') ? { desc: String(flag(c, 'desc')).replace(/\s+/g, ' ').trim().slice(0, 1500) } : {}), added: nowIso(c), ...(flag(c, 'parent') ? { parent: flag(c, 'parent') } : {}) } }
      : op === 'set' ? { op, key, fields: Object.fromEntries((['title', 'owner', 'lane', 'accept', 'max_runtime'] as const).flatMap((k) => (flag(c, k.replace('_', '-')) !== undefined ? [[k, flag(c, k.replace('_', '-'))]] : []))) } : null;
    if (!req) throw new Error('--op must be move, remove, add or set');
    const r = editPlan(plan, req);
    if ('error' in r) throw new Error(r.error);
    if (!show(c, 'plan', checkPlan(p, r.plan, ctx))) throw new Error('the edited plan would not pass the check; nothing written');
    // A finished project that gets a new task is open again: automation only moves projects that are active, so without this the task would wait for ever.
    const reopen = op === 'add' && ['review', 'done'].includes(p.status);
    let next = appendLog(writePlan(body, r.plan), `plan edited: ${op} ${key}`, c.today);
    if (reopen) next = appendLog(next, `reopened: a new task was added (${key})`, c.today);
    save(c, found.path, serializeProject(reopen ? { ...p, status: 'active' } : p, next), `plan: ${op} ${key}${reopen ? ` (project ${p.status} → active)` : ''}`);
    if (p.plan_sha) c.out('  the plan was already applied: run "plan apply" to create new tasks (removed tasks stay in Hermes until archived)');
    if (!c.apply) c.out('(dry run — add --apply)');
    return;
  }
  const board = boardOf(c, p);
  if (!board) throw new Error(`no kanban board is mapped to "${p.portfolio}" in ${c.layoutPath}`);
  if (sub === 'regroup') return regroup(c, found, plan, ctx, board);
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
  if (sub !== 'apply') throw new Error('usage: work plan check|apply|diff|edit|regroup <id>');
  if (p.status !== 'active') throw new Error(p.status === 'proposed' ? `the charter is not approved yet: work project approve ${p.id}` : `the project is ${p.status}; only an active project's plan can be applied`);
  const core = coreRepoViolation(c, p, plan!);
  if (core) throw new Error(core);
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
      const fresh = renderTaskBody({ ...p, repo: p.repo ? (p.repo.startsWith('/') ? p.repo : join(codesDir(c), p.repo)) : null }, t, decisions, plan!, repoHasRemote(p.repo ? (p.repo.startsWith('/') ? p.repo : join(codesDir(c), p.repo)) : null));
      if (SUBTASK_LINE.test(ex.body ?? '') !== SUBTASK_LINE.test(fresh) && ex.status !== 'archived') {
        c.out(`    ~ ${t.key}: ${t.parent ? `now a subtask of ${t.parent}` : 'no longer a subtask'} (body updated)`);
        if (c.apply) { try { kanban(c, board, ['edit', ex.id, '--body', fresh]); } catch { c.out(`    could not update ${ex.id}`); } }
      }
      if (c.apply && !ex.title.startsWith(`[${p.id}]`)) { try { kanban(c, board, ['edit', ex.id, '--title', taskTitle(p, t)]); } catch { /* cosmetic */ } }
      continue;
    }
    const human = t.owner === HUMAN;
    const args = ['create', '--json', '--tenant', p.tenant, ...(human ? [] : ['--assignee', t.owner]), '--created-by', 'work', '--idempotency-key', `project:${p.id}:${t.key}`, '--max-runtime', t.max_runtime,
      ...t.needs.flatMap((k) => ['--parent', ids.get(k) ?? `<${k}>`]), ...(t.model ? ['--model', t.model] : []), ...(t.provider ? ['--provider', t.provider] : []),
      '--priority', String(hermesPriority(p.priority)), ...(t.workspace ? ['--workspace', t.workspace] : []), ...(t.goal ? ['--goal'] : []), '--body', renderTaskBody({ ...p, repo: p.repo ? (p.repo.startsWith('/') ? p.repo : join(codesDir(c), p.repo)) : null }, t, decisions, plan!, repoHasRemote(p.repo ? (p.repo.startsWith('/') ? p.repo : join(codesDir(c), p.repo)) : null)), '--', taskTitle(p, t)];
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

export function cmdStatus(c: Ctx) {
  const only = c.pos[1];
  for (const p of only ? [only] : PORTFOLIOS) {
    const objectives = existsSync(objectivesPath(c, p)) ? parseObjectives(readFileSync(objectivesPath(c, p), 'utf8')) : null;
    const projects = allProjects(c, p);
    if (!objectives && !projects.length) continue;
    c.out(`\n${p}${objectives ? ` — objectives ${objectives.horizon}, reviewed ${objectives.reviewed || 'never'}${hoursSince(objectives.reviewed, c.today) / 24 > 8 ? ' ▲ overdue' : ''}` : ''}`);
    for (const { project: pr } of projects) {
      const board = boardOf(c, pr);
      let counts: Record<string, number> = {}; let n = 0; let active = 0; let note = '';
      if (board) {
        try { for (const t of tenantTasks(c, board, pr.tenant)) { counts[t.status] = (counts[t.status] ?? 0) + 1; if (!SUBTASK_LINE.test(t.body ?? '') && !/^\[plan-for:/.test((t.body ?? '').trim())) { n++; if (!isFinishedStatus(t.status)) active++; } } } catch { note = ' (kanban unreachable)'; }
      } else note = ' (no board mapped)';
      const flags: string[] = [];
      if (active > pr.charter.max_tasks) flags.push(`OVER the limit of active tasks (${active}/${pr.charter.max_tasks}): work plan regroup ${pr.id}`);
      const limit = timeboxHours(pr.timebox);
      if (pr.status === 'active' && limit && hoursSince(pr.approved ?? pr.created, c.today) > limit) flags.push('OVER timebox');
      if (pr.status === 'paused' && (counts.running || counts.ready)) flags.push(`paused but ${(counts.running ?? 0) + (counts.ready ?? 0)} task(s) still open`);
      if (pr.status === 'proposed') flags.push('charter waiting for your approval');
      c.out(`  ${pr.id.padEnd(28)}${pr.status.padEnd(10)}${n ? `${counts.done ?? 0}/${n} done` : 'no tasks'}${counts.blocked ? `, ${counts.blocked} blocked` : ''}${counts.running ? `, ${counts.running} running` : ''}${flags.length ? '  ▲ ' + flags.join('; ') : ''}${note}`);
    }
    const board = boardFor(c, p);
    if (board) {
      try {
        const loose = (JSON.parse(kanban(c, board, ['list', '--json'])) as KTask[]).filter((t) => !t.tenant && !planMarkerOf(t.body) && !/^Plan project /.test(t.title) && !['done', 'archived'].includes(t.status));
        if (loose.length) c.out(`  untracked (no project): ${loose.length} open task(s)`);
      } catch { /* board unreachable */ }
    }
  }
}

export function cmdClose(c: Ctx) {
  const { project: p, body, path } = loadProject(c, c.pos[1] ?? '');
  const board = boardOf(c, p);
  const open = board ? tenantTasks(c, board, p.tenant).filter((t) => !['done', 'archived'].includes(t.status)) : [];
  if (open.length && !c.flags.get('force')) throw new Error(`${open.length} task(s) are not done (${open.map((t) => `${t.id}:${t.status}`).join(', ')}); finish them or use --force`);
  if (!readDelivery(c.kb, p.portfolio, p.id) && !c.flags.get('force')) throw new Error(`nothing is recorded about what was delivered. Say what it is and how to open it: work project deliver ${p.id} --summary "…" [--url http://…] [--start "…"] [--doc "Title|docs/verify.md"] --apply (or close with --force)`);
  const next: Project = { ...p, status: 'done' };
  save(c, path, serializeProject(next, appendLog(body, `closed${open.length ? ` (forced, ${open.length} open task(s) left)` : ''}`, c.today)), `${p.id}: ${p.status} → done`);
  noteDecision(c, { portfolio: p.portfolio, project: p.id, title: `Project closed${open.length ? ` with ${open.length} task(s) left open` : ''}`, why: flag(c, 'reason') ?? '', by: flag(c, 'by') ?? 'owner', source: 'approval' });
  c.out(`  next: record what was learned: npm run work -- decision add ${p.id} --title "…" --apply (and update the key results in objectives.md)`);
  if (!c.apply) c.out('(dry run — add --apply)');
}

/** The body Hermes shows for a plan task, as `plan apply` renders it. */
function bodyOf(c: Ctx, p: Project, t: Parameters<typeof renderTaskBody>[1], plan: Parameters<typeof renderTaskBody>[3], decisions: string): string {
  const repo = p.repo ? (p.repo.startsWith('/') ? p.repo : join(codesDir(c), p.repo)) : null;
  return renderTaskBody({ ...p, repo }, t, decisions, plan, repoHasRemote(repo));
}

/**
 * work plan regroup <id> [--headroom 2] [--apply]: over the limit of active tasks (or close to it)? Tasks that exist only as prerequisites of one other
 * task become its subtasks, so only the parent counts. Applying also updates the Hermes tasks (their bodies and the dependency links), but only for
 * tasks that are not running or in review. Dry run unless --apply.
 */
function regroup(c: Ctx, found: ReturnType<typeof loadProject>, plan: ReturnType<typeof readPlan>, ctx: Parameters<typeof checkPlan>[2], board: string) {
  const { project: p, body } = found;
  if (!plan) throw new Error('this project has no plan yet');
  const have = tenantTasks(c, board, p.tenant);
  const byKey = new Map(have.flatMap((t) => { const m = (t.body ?? '').match(WORK_MARKER); return m && m[1] === p.id ? [[m[2], t] as const] : []; }));
  const cap = p.charter.max_tasks;
  const r = suggestRegroup({ plan, cap, headroom: Math.max(0, Math.min(10, Number(flag(c, 'headroom') ?? 2) || 0)), status: (k) => byKey.get(k)?.status ?? null });
  c.out(`${p.id}: ${r.activeBefore} active top-level task(s), limit ${cap}`);
  if (!r.groups.length) {
    c.out(r.activeBefore <= r.target ? '  nothing to group: there is room.' : `  no safe grouping found (a task is only grouped when it is a prerequisite of exactly one other task, is not running or finished, and adds no new waiting). ${r.activeBefore > cap ? 'Finish or archive some tasks, or split the project in two.' : ''}`);
    return;
  }
  for (const g of r.groups) c.out(`  ${g.parent}  ←  ${g.children.join(', ')}`);
  c.out(`  → ${r.activeAfter} active (aiming for ${r.target})${r.reached ? '' : ': still above the target; finish or archive some tasks, or split the project'}`);
  if (!show(c, 'plan', checkPlan(p, r.plan, ctx))) throw new Error('the regrouped plan would not pass the check; nothing written');
  if (!c.apply) { c.out('(dry run — add --apply)'); return; }
  const decisions = decisionsOf(body);
  const next = r.plan;
  for (const g of r.groups) {
    const parent = byKey.get(g.parent), pt = next.find((t) => t.key === g.parent)!;
    if (!parent) continue;                                              // not on the board yet: `plan apply` will create it in the right shape
    for (const ck of g.children) {
      const child = byKey.get(ck), ct = next.find((t) => t.key === ck)!;
      if (!child) continue;
      try {
        kanban(c, board, ['edit', child.id, '--body', bodyOf(c, p, ct, next, decisions)]);                 // "Subtask of …": the watchdog stops counting it
        kanban(c, board, ['link', child.id, parent.id]);                                                    // the parent waits for it (it already did, through its own prerequisites)
        c.out(`  ✓ ${ck} is now a subtask of ${g.parent} on the board`);
      } catch (e) { c.out(`  ▲ could not update ${ck} on the board: ${(e as Error).message.split('\n')[0]}`); }
    }
    try { kanban(c, board, ['edit', parent.id, '--body', bodyOf(c, p, pt, next, decisions)]); } catch { /* cosmetic: the wrap-up line */ }
  }
  save(c, found.path, serializeProject({ ...p, plan_sha: planSha(next) }, appendLog(writePlan(body, next), `regrouped: ${r.groups.map((g) => `${g.children.join(', ')} under ${g.parent}`).join('; ')} (${r.activeBefore} → ${r.activeAfter} active)`, c.today)), 'plan regrouped');
}
