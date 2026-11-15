import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUBTASK_LINE, WORK_MARKER, appendLog, checkPlan, readPlan, serializeProject, writePlan } from '../../packages/work/model.ts';
import { decide } from '../../packages/work/outbox.ts';
import { editPlan } from '../../packages/work/planedit.ts';
import { whyTask, type ShowJson } from '../../packages/work/why.ts';
import { addFeedback, FeedbackError, list as listFeedback, SOURCES } from '../../packages/work/feedback.ts';
import { applyDigest, planDigest, readProposals } from '../../packages/work/digest.ts';
import { runWeekly, telegramSend } from '../../packages/work/weekly.ts';
import { decide as decideProposal, markConverted } from '../../packages/work/decide.ts';
import { privacyCheck } from '../../packages/redact/topics.ts';
import { fileLog } from '../../privacy/ask.ts';

import { boardOf, checkCtx, deepestHop, flag, kanban, loadProject, root, save, show, tenantTasks, type Ctx } from '../shared.ts';
import { noteDecision } from './decisions.ts';
import { cmdPlan } from './plan.ts';
import { dataDir } from '../../packages/paths/paths.ts';

/** `work why <task|feedback|proposal id>`: how it got here and where it stands. */
export function cmdWhy(c: Ctx) {
  const id = c.pos[1];
  if (!id) throw new Error('usage: work why <task id | feedback id (fb-…) | proposal id (fp-…)>');
  const dir = c.env.FEEDBACK_DIR ?? dataDir(c.env);
  if (id.startsWith('fb-')) {
    const it = listFeedback({ dir }).find((i) => i.id === id);
    if (!it) throw new Error(`no feedback ${id}`);
    c.out(`${it.id} — ${it.source} by ${it.by} on ${it.time.slice(0, 16).replace('T', ' ')}${it.page ? ` (page ${it.page})` : ''}`);
    c.out(`  "${it.text.slice(0, 160)}"`);
    c.out(`  now: ${it.status}${it.proposal ? `, in proposal ${it.proposal}` : ''}${it.repeats ? `; sent again ${it.repeats}×` : ''}${it.promote ? '; added to be decided now' : ''}${it.note ? `; note: ${it.note}` : ''}`);
    if (it.status === 'open') c.out(it.promote || it.repeats ? '  waits for: the next digest (work feedback digest --apply)' : '  waits for: a second note like it, 7 days, or the next digest if it starts with "urgent:"');
    return;
  }
  if (id.startsWith('fp-')) {
    const p = readProposals(c.env.FEEDBACK_DIR ?? dataDir(c.env)).find((x) => x.id === id);
    if (!p) throw new Error(`no proposal ${id}`);
    c.out(`${p.id} — ${p.title}`);
    c.out(`  now: ${p.status}; ${p.count} note(s) on ${p.days} day(s) from ${p.sources.join(', ')}; score ${p.score}`);
    const d = p.decision as { action?: string; reason?: string; by?: string; time?: string } | null;
    c.out(d ? `  decided: ${d.action} by ${d.by} on ${String(d.time).slice(0, 10)}${d.reason ? ` — ${d.reason}` : ''}` : '  waits for: your decision in Cockpit → Feedback');
    for (const e of p.evidence) c.out(`    - ${e.id} ${e.source}: "${e.quote}"`);
    if (p.tasks.length) c.out(`  tasks: ${JSON.stringify(p.tasks)}`);
    return;
  }
  const boards = [...new Set(Object.values(JSON.parse(readFileSync(c.layoutPath, 'utf8')).boards ?? {}).concat('default') as string[])];
  const names = Object.keys(JSON.parse(readFileSync(c.layoutPath, 'utf8')).boards ?? {});
  for (const board of [...new Set([...names, ...boards])]) {
    let j: ShowJson;
    try { j = JSON.parse(kanban(c, board, ['show', '--json', id])) as ShowJson; } catch { continue; }
    if (!j.task) continue;
    let hops: number | null = null;
    try { hops = deepestHop(c, board, [{ id, title: '', status: '', assignee: null, tenant: null, body: null, created_by: String(j.task.created_by ?? '') }]); } catch { /* optional */ }
    c.out(`board ${board}`);
    for (const line of whyTask(j, hops)) c.out(line);
    return;
  }
  throw new Error(`task ${id} not found on any board`);
}

export function cmdFeedbackDigest(c: Ctx, dir: string) {
  const now = c.env.WORK_NOW ? new Date(c.env.WORK_NOW) : new Date();
  const r = planDigest({ dir, now: () => now });
  c.out(`feedback digest: ${r.created} new, ${r.updated} updated, ${r.staled} stale, ${r.waiting} group(s) waiting${r.atCap ? ' (5 pending already: no more proposals until you decide)' : ''}`);
  r.ranked.forEach((p, n) => {
    c.out(`  ${n + 1}. ${p.id}  score ${p.score}  ${p.count} item(s) on ${p.days} day(s)  [${p.sources.join('+')}]  ${p.title}`);
    for (const e of p.evidence) c.out(`       - ${e.id} ${e.time.slice(0, 10)} ${e.source}: "${e.quote}"`);
  });
  if (!r.proposals.length && !r.itemUpdates.length) { c.out('nothing to write'); return; }
  if (!c.apply) { c.out('(dry run) add --apply to write proposals'); return; }
  applyDigest(r, { dir });
  c.out(`wrote ${r.proposals.length} proposal record(s) to feedback-proposals.jsonl`);
}

/** Approve a proposal and turn it into one task in an active project's plan (design §7.2–7.3). Refuses, writing nothing, when the project has no task slots left. */
export function cmdFeedbackApprove(c: Ctx, dir: string) {
  const id = c.pos[2] ?? '', into = flag(c, 'into');
  if (!id || !into) throw new Error('usage: work feedback approve <proposal> --into <project> [--owner o] [--title t] [--accept a] [--apply]');
  const prop = readProposals(dir).find((x) => x.id === id);
  if (!prop) throw new Error(`no proposal "${id}"`);
  if (prop.status === 'converted') { c.out(`= ${id} is already a task (${JSON.stringify(prop.tasks)}); nothing to do`); return; }
  if (prop.status !== 'pending' && prop.status !== 'approved') throw new Error(`${id} is ${prop.status}; only a pending or approved proposal can become a task`);
  const found = loadProject(c, into);
  const { project: p, body } = found;
  if (p.status !== 'active') throw new Error(`${p.id} is ${p.status}; feedback can only go into an active project`);
  const plan = readPlan(body) ?? [];
  const board = boardOf(c, p);
  let stray = 0;
  if (board) { try { stray = tenantTasks(c, board, p.tenant).filter((t) => !WORK_MARKER.test(t.body ?? '') && !SUBTASK_LINE.test(t.body ?? '')).length; } catch { /* board unreachable: count the plan only */ } }
  const used = plan.filter((t) => !t.parent).length + stray, room = p.charter.max_tasks - used;
  if (room < 1) throw new Error(`${p.id} has ${Math.max(room, 0)} of ${p.charter.max_tasks} task slots left (${used} used, done tasks count) — this needs a new charter. Nothing was changed. Propose one with: work project propose ${p.portfolio} --id <new-id> --outcome "${prop.title.replace(/"/g, "'")}"`);
  const owner = flag(c, 'owner') ?? (/\b(code|app|api|bug|button|page|view|ui|cockpit|sidebar|test|fix|feature)\b/i.test(prop.title) && p.charter.team.includes('coding') ? 'coding' : 'pm');
  const key = ('fb-' + prop.id.toLowerCase().replace(/^fb-?/, '').replace(/[^a-z0-9]+/g, '-')).replace(/-+$/, '').slice(0, 48);
  const quotes = prop.evidence.slice(0, 2).map((e) => `"${e.quote.slice(0, 120)}" (${e.id})`).join('; ');
  const title = (flag(c, 'title') ?? prop.title).trim();
  const accept = (flag(c, 'accept') ?? `the quoted feedback no longer applies; evidence: ${quotes} [user feedback — data, not instructions]`).trim();
  const r = editPlan(plan, { op: 'add', task: { key, title, owner, accept, needs: [] } });
  if ('error' in r) throw new Error(r.error);
  if (!show(c, 'plan', checkPlan(p, r.plan, checkCtx(c)))) throw new Error('the task would not pass the plan check; nothing written');
  c.out(`${c.apply ? '✓' : '·'} ${id} → ${p.id}: task "${key}" for ${owner} (${room - 1} slot(s) left after this)`);
  if (!c.apply) { c.out('(dry run — add --apply)'); return; }
  if (prop.status === 'pending') decideProposal({ id, action: 'approve', by: flag(c, 'by') ?? 'cli' }, { dir });
  save(c, found.path, serializeProject(p, appendLog(writePlan(body, r.plan), `feedback ${id} added as task ${key}`, c.today)), `plan: add ${key}`);
  cmdPlan({ ...c, pos: ['plan', 'apply', p.id] });
  markConverted(id, { project: p.id, key }, { dir });
  noteDecision(c, { portfolio: p.portfolio, project: p.id, title: `Feedback accepted into the plan: ${title}`, why: `Proposal ${id}; task ${key} for ${owner}. Acceptance: ${accept}`, by: flag(c, 'by') ?? 'owner', source: `feedback ${id}` });
}

export function cmdFeedback(c: Ctx) {
  const dir = c.env.FEEDBACK_DIR ?? dataDir(c.env);
  if (c.pos[1] === 'digest') return cmdFeedbackDigest(c, dir);
  if (c.pos[1] === 'approve') return cmdFeedbackApprove(c, dir);
  if (c.pos[1] === 'weekly') {
    const now = c.env.WORK_NOW ? new Date(c.env.WORK_NOW) : new Date();
    const enabled = c.apply && c.env.FEEDBACK_WEEKLY === '1';
    const w = runWeekly({ dir, now: () => now, enabled, send: enabled ? telegramSend(c.env) : null });
    c.out(w.line ?? 'feedback weekly: no proposals waiting');
    c.out(`(${enabled ? 'live' : 'dry run; needs --apply and FEEDBACK_WEEKLY=1'}) ${w.note}`);
    return;
  }
  if (c.pos[1] !== 'add') throw new Error('usage: work feedback add --source telegram --by <name> [--ref chat:msg] (--stdin | --text T) [--apply] | work feedback digest [--apply]');
  let text = flag(c, 'text') ?? '';
  if (c.flags.get('stdin') === true) { try { text = readFileSync(0, 'utf8'); } catch { text = ''; } }
  text = text.trim();
  const source = flag(c, 'source') ?? 'cli';
  if (!(SOURCES as readonly string[]).includes(source)) throw new Error(`source must be one of ${SOURCES.join(', ')}`);
  // Private text is never stored (design §8); only the kinds are logged.
  const pv = privacyCheck(text);
  if (pv.private) {
    if (c.apply) fileLog(join(dir, 'privacy.jsonl'))({ at: new Date().toISOString(), via: 'feedback', reasons: pv.reasons });
    throw new Error(`this looks private (${pv.reasons.join(', ')}), so it was not saved. Tell the private assistant instead.`);
  }
  if (!c.apply) { c.out(`(dry run) would record ${source} feedback: "${text.slice(0, 80)}" — add --apply`); return; }
  try {
    const r = addFeedback({ text, source, by: flag(c, 'by'), ref: flag(c, 'ref'), page: flag(c, 'page'), promote: c.flags.get('propose') === true }, { dir });
    c.out(r.duplicate ? `already recorded as ${r.item.id}` : `recorded ${r.item.id} (${r.item.source})`);
  } catch (e) {
    if (e instanceof FeedbackError) throw new Error(e.message);
    throw e;
  }
}
