import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OUTBOX_ID, decide, newItemId, type OutboxItem } from '../../packages/work/outbox.ts';

import { allProjects, flag, hoursSince, loadProject, portfolioDir, root, save, show, type Ctx } from '../shared.ts';

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
