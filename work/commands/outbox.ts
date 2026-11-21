import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { OUTBOX_ID, OUTBOX_KINDS, decide, delegated, newItemId, type OutboxItem, type OutboxKind } from '../../packages/work/outbox.ts';
import { insideAgent } from '../../packages/mail/mail.ts';
import { fileAudit } from '../../apps/cockpit/src/audit.ts';
import { dataDir } from '../../packages/paths/paths.ts';
import { hermesPriority, type Project } from '../../packages/work/model.ts';

import { allProjects, boardOf, codesDir, flag, hoursSince, kanban, loadProject, nowIso, portfolioDir, root, save, type Ctx } from '../shared.ts';
import { noteDecision } from './decisions.ts';

/* ---------- outbox ---------- */

export const outboxDir = (c: Ctx, portfolio: string, project: string) => join(portfolioDir(c, portfolio), 'outbox', project);

export function allOutbox(c: Ctx, only?: string): Array<{ path: string; item: OutboxItem }> {
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

export function findItem(c: Ctx, id: string) {
  const f = allOutbox(c).find((x) => x.item.id === id);
  if (!f) throw new Error(`no outbox item "${id}" (see: work outbox list)`);
  return f;
}

export const writeItem = (c: Ctx, path: string, item: OutboxItem, why: string) => save(c, path, JSON.stringify(item, null, 2) + '\n', why);

/** The agent running this command, from the kanban task Hermes is running it in (its assignee), or null for a person. */
function callerAgent(c: Ctx): { profile: string; task: string; body: string } | 'agent-unknown' | null {
  const task = c.env.HERMES_KANBAN_TASK, board = c.env.HERMES_KANBAN_BOARD;
  if (task && board) {
    try {
      const d = JSON.parse(kanban(c, board, ['show', '--json', task])) as { task?: { assignee?: string; body?: string } };
      return { profile: String(d.task?.assignee ?? ''), task, body: String(d.task?.body ?? '') };
    } catch { return 'agent-unknown'; }
  }
  return insideAgent(c.env) ? 'agent-unknown' : null;
}

/** owner/repo of the project's GitHub remote. */
function githubRepo(c: Ctx, p: Project): string {
  if (!p.repo) throw new Error(`${p.id} has no repo linked`);
  const path = isAbsolute(p.repo) ? p.repo : join(codesDir(c), p.repo);
  const url = c.run('git', ['-C', path, 'remote', 'get-url', 'origin']).trim();
  const m = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (!m) throw new Error(`${p.id}'s repo has no GitHub remote`);
  return m[1];
}

const REVIEW_MARK = (id: string) => `[approve:${id}]`;

/** Make (or find: idempotent) the approver's review task for a held, delegated item. null when Hermes refused. */
function reviewTask(c: Ctx, p: Project, item: OutboxItem): string | null {
  const board = boardOf(c, p);
  if (!board || !p.approver) return null;
  const body = [REVIEW_MARK(item.id), '', `Project: ${p.id} (${p.portfolio}). ${item.submitted_by ?? 'An agent'} asks for: ${item.kind} → ${item.target}`, `What: ${item.summary}`, item.value ? `Value: ${item.value}` : '',
    '', 'You approve this on Frank\'s behalf (delegated). Use your delegated-approval skill: check it against the charter (outcome, never-list, privacy), and for a merge read the diff and make sure every check is green.',
    `Approve: npm run work -- outbox release ${item.id} --why "<what you checked>" --apply   ·   Refuse: npm run work -- outbox deny ${item.id} --why "<why>" --apply`,
    'Run these from ~/services/personal-agent-platform, from inside this task. Then complete the task with one line saying what you decided.'].filter(Boolean).join('\n');
  try {
    const made = JSON.parse(kanban(c, board, ['create', '--json', '--assignee', p.approver, '--created-by', 'work', '--tenant', p.tenant, '--idempotency-key', `approve:${item.id}`, '--priority', String(hermesPriority(p.priority) + 3), '--max-runtime', '1h', '--body', body, '--', `[${p.id}] Review: ${item.kind} ${item.target}`.slice(0, 190)])) as { id?: string };
    return made.id ?? null;
  } catch (e) { c.out(`  ▲ ${item.id}: the review task for ${p.approver} could not be made here (${(e as Error).message.split('\n')[0].slice(0, 120)}); the work-watch job makes it on its next pass`); return null; }
}

export function cmdOutbox(c: Ctx) {
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
    const kind = flag(c, 'kind') as OutboxKind | undefined;
    if (!kind || !OUTBOX_KINDS.includes(kind)) throw new Error(`--kind must be ${OUTBOX_KINDS.join(', ')}`);
    const target = flag(c, 'target'), summary = flag(c, 'summary');
    if (!target || !summary) throw new Error('--target and --summary are required');
    const usd = Number(flag(c, 'usd') ?? 0);
    if (!Number.isFinite(usd) || usd < 0) throw new Error('--usd must be a number');
    const value = kind === 'access' ? (flag(c, 'value') ?? '') : null;
    if (kind === 'access' && (!value || value.length > 500 || /[\r\n]/.test(value))) throw new Error('--value: the setting\'s value (one line)');
    const week = allOutbox(c, p.id).filter((x) => x.item.kind === kind && x.item.status === 'done' && hoursSince(x.item.created, c.today) <= 168).length;
    const d = decide(p, { kind, target, usd }, week);
    const dir = outboxDir(c, p.portfolio, p.id);
    const existing = allOutbox(c, p.id).length;
    const id = newItemId(p.id, c.today, existing + 1);
    if (!OUTBOX_ID.test(id)) throw new Error(`cannot build an outbox id from project "${p.id}"`);
    const caller = callerAgent(c);
    const submittedBy = caller && caller !== 'agent-unknown' ? caller.profile : (flag(c, 'by') ?? (caller ? 'an agent' : 'a person'));
    const item: OutboxItem = { id, project: p.id, portfolio: p.portfolio, kind, target, summary, payload: flag(c, 'payload') ?? null, usd, task: flag(c, 'task') ?? null, created: c.today, status: d.status, reason: d.reason, decided_by: 'charter', result: null, value, submitted_by: submittedBy, review_task: null };
    // Handed to an approver agent: give it a review task (it can approve only from inside that task). Inside some agent workers Hermes
    // refuses to create tasks; then the work-watch job makes it on its next pass (outbox run).
    if (c.apply && d.status === 'held' && delegated(p, kind)) item.review_task = reviewTask(c, p, item);
    writeItem(c, join(dir, `${id}.json`), item, `outbox ${id}: ${d.status}`);
    c.out(`  ${d.status === 'denied' ? '✗' : d.status === 'held' ? '▲' : '✓'} ${d.status}: ${d.reason}${item.review_task ? ` (review task ${item.review_task} for ${p.approver})` : ''}`);
    if (!c.apply) c.out('(dry run — add --apply)');
    return;
  }
  if (sub === 'release' || sub === 'deny') {
    const f = findItem(c, arg ?? '');
    if (f.item.status !== 'held') throw new Error(`only a held item can be ${sub}d (this one is ${f.item.status})`);
    const { project: p } = loadProject(c, f.item.project);
    const why = (flag(c, 'why') ?? flag(c, 'reason') ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    // A person (Cockpit, a terminal, a reply code) may always decide. An agent only as the project's approver, for a delegated kind,
    // from inside the review task made for this item, and never for its own request.
    const caller = callerAgent(c);
    let decidedBy = flag(c, 'by') ?? 'human';
    if (caller) {
      if (caller === 'agent-unknown') throw new Error('an agent can decide an outbox item only from inside its review task');
      if (!delegated(p, f.item.kind)) throw new Error(`${f.item.kind} is not delegated to an agent for ${p.id}: it waits for Frank`);
      if (caller.profile !== p.approver) throw new Error(`only ${p.approver} may decide this (you are ${caller.profile})`);
      if (!caller.body.includes(REVIEW_MARK(f.item.id))) throw new Error(`run this from the review task for ${f.item.id}${f.item.review_task ? ` (${f.item.review_task})` : ''}`);
      if (f.item.submitted_by === caller.profile) throw new Error('an approver cannot approve its own request');
      if (why.length < 10) throw new Error('--why: what you checked (it is recorded and shown to Frank)');
      decidedBy = `${caller.profile} (delegated by Frank)`;
    }
    if (sub === 'release' && f.item.kind !== 'merge' && f.item.kind !== 'access') {
      // A human release overrides draft-only/limits, but never the charter's deny rules: re-check as if auto.
      const recheck = decide({ ...p, charter: { ...p.charter, outward: { ...p.charter.outward, publish: { ...p.charter.outward.publish, allowed: p.charter.outward.publish.allowed === 'no' ? 'no' : 'auto', max_per_week: 0 } } } }, f.item, 0);
      if (recheck.status === 'denied') throw new Error(`cannot release: ${recheck.reason}`);
    }
    const next: OutboxItem = { ...f.item, status: sub === 'release' ? 'ready' : 'denied', reason: `${sub === 'release' ? 'released' : 'denied'} by ${decidedBy}${why ? `: ${why}` : ''}`, decided_by: decidedBy, decided_at: nowIso(c), why: why || null };
    writeItem(c, f.path, next, `outbox ${f.item.id}: held → ${next.status}`);
    if (c.apply) {
      fileAudit(c.env.AUDIT_LOG ?? join(dataDir(c.env), 'audit.jsonl')).log({ who: decidedBy, device: caller ? 'agent' : 'cli', action: `outbox.${sub}`, target: f.item.id, ok: true, detail: { kind: f.item.kind, target: f.item.target, why } });
      if (caller) noteDecision(c, { portfolio: p.portfolio, project: p.id, title: `${sub === 'release' ? 'Approved' : 'Refused'} on Frank's behalf: ${f.item.kind} ${f.item.target}`, why: `${why} (${caller.profile}, delegated approval)`, by: caller.profile, source: `task ${caller.task}` });
    }
    if (!c.apply) c.out('(dry run — add --apply)');
    return;
  }
  if (sub === 'run') {
    const cfgPath = c.env.OUTBOX_CONFIG ?? join(root, 'config', 'outbox.json');
    const handlers: Record<string, string[]> = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')).handlers ?? {} : {};
    for (const { path, item } of allOutbox(c).filter((x) => x.item.status === 'held' && !x.item.review_task)) {
      const p = loadProject(c, item.project).project;
      if (!delegated(p, item.kind)) continue;
      c.out(`  ${c.apply ? '+' : '·'} ${item.id}: review task for ${p.approver}`);
      if (!c.apply) continue;
      const t = reviewTask(c, p, item);
      if (t) writeItem(c, path, { ...item, review_task: t }, `outbox ${item.id}: review task ${t}`);
    }
    const ready = allOutbox(c).filter((x) => x.item.status === 'ready');
    if (!ready.length) c.out('nothing ready');
    for (const { path, item } of ready) {
      const found = loadProject(c, item.project);
      // Re-check at execution time: the charter or the delegation may have changed, or the project been paused, since submission.
      const d = decide(found.project, item, 0);
      if (d.status === 'denied') { writeItem(c, path, { ...item, status: 'denied', reason: d.reason }, `outbox ${item.id}: now denied`); continue; }
      if (item.kind === 'merge' || item.kind === 'access') {
        c.out(`  ${c.apply ? '→' : '·'} ${item.id}: ${item.kind} ${item.target}`);
        if (!c.apply) continue;
        try { const res = builtIn(c, found.project, item); writeItem(c, path, { ...item, status: 'done', result: res.slice(0, 500) }, `outbox ${item.id}: done`); }
        catch (e) {
          const msg = (e as Error).message.slice(0, 500);
          // a merge whose checks are still running stays ready and is tried again on the next pass
          if (/still running/.test(msg)) { c.out(`    · ${msg}`); continue; }
          writeItem(c, path, { ...item, status: 'failed', result: msg }, `outbox ${item.id}: failed`);
        }
        continue;
      }
      const h = handlers[item.kind];
      if (!h?.length) { c.out(`  ▲ ${item.id}: no ${item.kind} handler in ${cfgPath.replace(homedir(), '~')}; left ready`); continue; }
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

/** Merges and repository variables are carried out here, not by a configurable command: a merge only when every check is green. */
function builtIn(c: Ctx, p: Project, item: OutboxItem): string {
  const gh = c.env.GH_BIN ?? 'gh';
  if (item.kind === 'merge') {
    const pr = JSON.parse(c.run(gh, ['pr', 'view', item.target, '--json', 'state,baseRefName,statusCheckRollup'])) as { state: string; baseRefName: string; statusCheckRollup?: Array<{ status?: string; conclusion?: string; state?: string; name?: string; context?: string }> };
    if (pr.state !== 'OPEN') throw new Error(`the pull request is ${pr.state.toLowerCase()}`);
    if (pr.baseRefName !== 'main') throw new Error(`it merges into ${pr.baseRefName}, not main`);
    const checks = pr.statusCheckRollup ?? [];
    const pending = checks.filter((x) => (x.status && x.status !== 'COMPLETED') || x.state === 'PENDING');
    if (pending.length) throw new Error(`checks still running: ${pending.map((x) => x.name ?? x.context).join(', ')}`);
    const bad = checks.filter((x) => (x.conclusion && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(x.conclusion)) || (x.state && !['SUCCESS'].includes(x.state) && !x.conclusion));
    if (bad.length) throw new Error(`not merged: checks are not green (${bad.map((x) => x.name ?? x.context).join(', ')})`);
    c.run(gh, ['pr', 'merge', item.target, '--merge', '--delete-branch']);
    return `merged ${item.target}`;
  }
  const name = item.target.slice('github-variable:'.length);
  c.run(gh, ['variable', 'set', name, '--repo', githubRepo(c, p), '--body', item.value ?? '']);
  return `set ${name} on ${githubRepo(c, p)}`;
}
