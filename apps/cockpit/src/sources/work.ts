import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fullAutoBlockers, parseProject } from '../../../../packages/work/model.ts';
import type { OutboxItem } from '../../../../packages/work/outbox.ts';
import { readDecisions } from '../../../../packages/work/decisions.ts';
import type { NeedsYou, Source } from '../types.ts';

// What the work model needs from the human, read straight from ~/PortfolioKB (no Hermes call):
//   • a project charter waiting for approval          (the high-level gate)
//   • a project the watchdog paused                   (over scope, time or budget)
//   • an outbox item held for release                 (publish draft, spend, over a limit)
// Everything else is decided by Atlas and pm and never shows up here.

const ls = (dir: string) => readdir(dir).catch(() => [] as string[]);

export function workSource(opts: { kb: string; portfolios: string[]; /** kinds that have an executor in config/outbox.json; absent = not checked */ outboxHandlers?: () => string[] }): Source {
  return async () => {
    const handled = opts.outboxHandlers?.();
    const needs: NeedsYou[] = [];
    const errors: string[] = [];
    for (const portfolio of opts.portfolios) {
      const dir = join(opts.kb, portfolio, 'projects');
      for (const f of (await ls(dir)).filter((x) => x.endsWith('.md'))) {
        let project;
        try { project = parseProject(await readFile(join(dir, f), 'utf8')).project; } catch (e) { errors.push(`work: ${f}: ${(e as Error).message}`); continue; }
                if (project.status === 'proposed' && project.autonomy === 'full' && !fullAutoBlockers(project).length && project.auto_start_after)
          needs.push({ portfolioId: portfolio, kind: 'approval', severity: 'info', title: `Starts by itself at ${new Date(project.auto_start_after).toLocaleString("en-AU", { weekday: "short", hour: "2-digit", minute: "2-digit" })} (full automation): ${project.id} — ${project.charter.outcome || 'no outcome'}. Stop it by switching the project to semi.` });
        else if (project.status === 'proposed') needs.push({ portfolioId: portfolio, kind: 'approval', severity: 'warn', title: `Approve project charter: ${project.id} — ${project.charter.outcome || 'no outcome'} (work project approve ${project.id} --apply)` });
        if (project.status === 'review') needs.push({ portfolioId: portfolio, kind: 'approval', severity: 'info', title: `Review finished project: ${project.id} — every task is done; check the result, then mark it done` });
        if (project.status === 'paused' && project.paused_reason) needs.push({ portfolioId: portfolio, kind: 'blocker', severity: 'warn', title: `Project paused by the watchdog: ${project.id} — ${project.paused_reason}` });
        const box = join(opts.kb, portfolio, 'outbox', project.id);
        for (const o of (await ls(box)).filter((x) => x.endsWith('.json'))) {
          try {
            const item = JSON.parse(await readFile(join(box, o), 'utf8')) as OutboxItem;
            // Approved and ready, but nothing is configured to carry it out: without this line it would wait forever, unseen.
            if (item.status === 'ready' && handled && !handled.includes(item.kind)) needs.push({ portfolioId: portfolio, kind: 'blocker', severity: 'warn', title: `Ready to ${item.kind} to ${item.target}, but no ${item.kind} handler is set up: do it by hand, or add one to config/outbox.json (${item.summary})` });
            if (item.status === 'held') needs.push({ portfolioId: portfolio, kind: 'approval', severity: 'warn', title: `Release ${item.kind} to ${item.target}? ${item.summary} — ${item.reason} (work outbox release ${item.id} --apply)` });
          } catch { /* unreadable item */ }
        }
      }
    }
    // Decisions an agent or a model drafted: they stay drafts until the owner confirms or rejects them.
    for (const portfolio of opts.portfolios) {
      const byScope = new Map<string, ReturnType<typeof readDecisions>>();
      for (const x of readDecisions(opts.kb, { portfolio, status: 'proposed' })) byScope.set(x.scope, [...(byScope.get(x.scope) ?? []), x]);
      for (const [scope, list] of byScope) needs.push({ portfolioId: portfolio, kind: 'approval', severity: 'info', title: `Confirm ${list.length} proposed decision${list.length === 1 ? '' : 's'} for ${scope === '_portfolio' ? portfolio : scope}: "${list[0].title.slice(0, 90)}"${list.length > 1 ? ' and more' : ''}` });
    }
    return { cards: [], errors, needs };
  };
}
