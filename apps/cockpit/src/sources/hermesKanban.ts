import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GroupId, NeedsYou, PortfolioCard, Source, Status } from '../types.ts';

// Hermes kanban is the task system of record: one board per portfolio.
//   hermes kanban boards list --json            -> [{ slug, name, counts: {status: n}, total, archived }]
//   hermes kanban --board <slug> list --json    -> [{ id, title, assignee, status, last_failure_error, ... }]
// Read through the CLI rather than kanban.db so schema changes stay Hermes' problem.

export type Runner = (args: string[]) => Promise<string>;

interface Opts {
  bin?: string;
  run?: Runner;
  /** Board slug → Cockpit section; unlisted boards go to `fallback`. */
  groups?: Record<string, GroupId>;
  fallback?: GroupId;
}

interface Board {
  slug: string;
  name?: string;
  archived?: boolean;
  counts?: Record<string, number>;
  total?: number;
}

interface Task {
  body?: string | null;
  id: string;
  title?: string;
  status?: string;
  assignee?: string | null;
  last_failure_error?: string | null;
}

const OPEN = ['triage', 'todo', 'scheduled', 'ready'];

export function defaultRunner(bin: string): Runner {
  const exec = promisify(execFile);
  return async (args) => (await exec(bin, args, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

/** Task counts per assignee. queued/todo/scheduled/triage all count as "ready" (work waiting to start). */
export function teamOf(tasks: Task[]): NonNullable<PortfolioCard['team']> {
  const by = new Map<string, { assignee: string; running: number; ready: number; review: number; blocked: number; done: number }>();
  for (const t of tasks) {
    const key = t.assignee || 'unassigned';
    const cur = by.get(key) ?? { assignee: key, running: 0, ready: 0, review: 0, blocked: 0, done: 0 };
    const st = t.status ?? '';
    if (st === 'running') cur.running++;
    else if (st === 'review') cur.review++;
    else if (st === 'blocked') cur.blocked++;
    else if (st === 'done') cur.done++;
    else if (st !== 'archived') cur.ready++;
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => a.assignee.localeCompare(b.assignee));
}

export function statusFor(counts: Record<string, number>, failing: number): Status {
  if (failing > 0) return 'alert';
  if ((counts.blocked ?? 0) > 0 || (counts.review ?? 0) > 0) return 'warn';
  return 'ok';
}

export function hermesKanbanSource(opts: Opts = {}): Source {
  const run = opts.run ?? defaultRunner(opts.bin ?? 'hermes');

  return async () => {
    const cards: PortfolioCard[] = [];
    const errors: string[] = [];

    let boards: Board[];
    try {
      boards = JSON.parse(await run(['kanban', 'boards', 'list', '--json']));
    } catch (e) {
      return { cards, errors: [`hermes: cannot list kanban boards (${(e as Error).message})`] };
    }

    // The built-in default board only counts once something is on it.
    const live = boards.filter((b) => !b.archived && !(b.slug === 'default' && !b.total));
    await Promise.all(
      live.map(async (b) => {
        const name = b.name || b.slug;
        try {
          const tasks: Task[] = JSON.parse(await run(['kanban', '--board', b.slug, 'list', '--json']));
          const counts: Record<string, number> = {};
          for (const t of tasks) counts[t.status ?? 'unknown'] = (counts[t.status ?? 'unknown'] ?? 0) + 1;

          const needsYou: NeedsYou[] = [];
          const failing = tasks.filter((t) => t.last_failure_error && t.status !== 'done');
          for (const t of tasks) {
            const title = t.title ?? t.id;
            if (t.status === 'review') {
              needsYou.push({ portfolioId: b.slug, kind: 'approval', title: `Review: ${title}`, severity: 'warn' });
            } else if (t.status === 'blocked' && t.assignee) {
              // (a blocked task with no owner is a staffing question, reported by the rollup instead)
              needsYou.push({ portfolioId: b.slug, kind: 'blocker', title: `Blocked: ${title}`, severity: 'warn' });
            }
          }
          for (const t of failing) {
            needsYou.push({ portfolioId: b.slug, kind: 'alert', title: `Failing: ${t.title ?? t.id}`, severity: 'alert' });
          }

          const open = OPEN.reduce((n, s) => n + (counts[s] ?? 0), 0);
          const running = counts.running ?? 0;
          const done = counts.done ?? 0;
          cards.push({
            id: b.slug,
            name,
            group: opts.groups?.[b.slug] ?? opts.fallback ?? 'micropace',
            source: 'hermes',
            status: statusFor(counts, failing.length),
            headline: `${running} running · ${open} open · ${counts.review ?? 0} in review · ${done} done`,
            metrics: [],
            tasks: { open, inProgress: running + (counts.review ?? 0), blocked: counts.blocked ?? 0, done },
            team: teamOf(tasks),
            strays: tasks.filter((t) => !['done', 'archived'].includes(t.status ?? '') && !/^\[(work|plan-for):/.test(t.body ?? '') && !/^Plan project /.test(t.title ?? '')).length,
            unassigned: tasks.filter((t) => !t.assignee && ['blocked', 'ready', 'todo', 'triage'].includes(t.status ?? '')).slice(0, 10).map((t) => ({ id: t.id, title: t.title ?? t.id, body: (t.body ?? '').slice(0, 600), status: t.status ?? '' })),
            needsYou,
            updatedAt: new Date().toISOString(),
          });
        } catch (e) {
          errors.push(`hermes: board "${name}" failed (${(e as Error).message})`);
        }
      }),
    );

    cards.sort((a, b) => a.name.localeCompare(b.name));
    return { cards, errors };
  };
}
