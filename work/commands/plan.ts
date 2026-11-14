import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HUMAN, SUBTASK_LINE, WORK_MARKER, type Project, appendLog, checkCharter, checkPlan, decisionsOf, hermesPriority, parseObjectives, readPlan, renderTaskBody, serializeProject, timeboxHours, topoOrder, writePlan } from '../../packages/work/model.ts';
import { planMarkerOf } from '../../packages/work/advance.ts';
import { editPlan, type PlanOp } from '../../packages/work/planedit.ts';

import { PORTFOLIOS, allProjects, boardFor, boardOf, checkCtx, codesDir, coreRepoViolation, csv, flag, hoursSince, kanban, loadProject, objectivesPath, planSha, repoHasRemote, save, show, taskTitle, tenantTasks, type Ctx, type KTask } from '../shared.ts';

/* ---------- plans ---------- */

export function cmdPlan(c: Ctx) {
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
      : op === 'add' ? { op, task: { key, title: flag(c, 'title') ?? '', owner: flag(c, 'owner') ?? '', accept: flag(c, 'accept') ?? '', needs: csv(flag(c, 'needs')), lane: flag(c, 'lane') ?? null, ...(flag(c, 'parent') ? { parent: flag(c, 'parent') } : {}) } }
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
  const board = boardOf(c, p);
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
      let counts: Record<string, number> = {}; let n = 0; let note = '';
      if (board) {
        try { for (const t of tenantTasks(c, board, pr.tenant)) { counts[t.status] = (counts[t.status] ?? 0) + 1; if (!SUBTASK_LINE.test(t.body ?? '') && !/^\[plan-for:/.test((t.body ?? '').trim())) n++; } } catch { note = ' (kanban unreachable)'; }
      } else note = ' (no board mapped)';
      const flags: string[] = [];
      if (n > pr.charter.max_tasks) flags.push(`OVER max_tasks (${n}/${pr.charter.max_tasks})`);
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
  const next: Project = { ...p, status: 'done' };
  save(c, path, serializeProject(next, appendLog(body, `closed${open.length ? ` (forced, ${open.length} open task(s) left)` : ''}`, c.today)), `${p.id}: ${p.status} → done`);
  c.out('  next: write the retrospective into decisions.md and update the key results in objectives.md');
  if (!c.apply) c.out('(dry run — add --apply)');
}
