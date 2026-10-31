import type { NeedsYou, PortfolioCard, RunDay, Source, Status } from '../types.ts';

// Paperclip API (docs.paperclip.ing/reference/api):
//   GET /api/companies                              -> companies the caller can access
//   GET /api/companies/:id/dashboard                -> agents/tasks/costs/pendingApprovals/runActivity
//   GET /api/companies/:id/approvals?status=pending -> pending approvals
// Auth: local_trusted needs no token; otherwise `Authorization: Bearer pcp_board_...`.
// The list envelopes aren't documented, so they are parsed defensively.

type Fetch = typeof fetch;

interface Opts {
  baseUrl: string;
  token?: string;
  fetch?: Fetch;
}

interface Dashboard {
  agents?: { active?: number; running?: number; paused?: number; error?: number };
  tasks?: { open?: number; inProgress?: number; blocked?: number; done?: number };
  costs?: { monthSpendCents?: number; monthBudgetCents?: number; monthUtilizationPercent?: number };
  pendingApprovals?: number;
  budgets?: { activeIncidents?: number; pausedAgents?: number; pausedProjects?: number };
  runActivity?: Array<{ date: string; succeeded?: number; failed?: number; total?: number }>;
}

function list(body: unknown): any[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    for (const key of ['companies', 'approvals', 'items', 'data']) {
      const v = (body as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

export function statusFor(d: Dashboard): Status {
  const util = d.costs?.monthUtilizationPercent ?? 0;
  if ((d.agents?.error ?? 0) > 0 || util >= 90 || (d.budgets?.activeIncidents ?? 0) > 0) return 'alert';
  if ((d.tasks?.blocked ?? 0) > 0 || (d.pendingApprovals ?? 0) > 0 || util >= 75) return 'warn';
  return 'ok';
}

export function paperclipSource(opts: Opts): Source {
  const doFetch = opts.fetch ?? fetch;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  async function get(path: string): Promise<unknown> {
    const res = await doFetch(`${opts.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  }

  return async () => {
    const cards: PortfolioCard[] = [];
    const errors: string[] = [];

    let companies: any[];
    try {
      companies = list(await get('/api/companies'));
    } catch (e) {
      return { cards, errors: [`paperclip: cannot list companies (${(e as Error).message})`] };
    }

    await Promise.all(
      companies.map(async (c) => {
        const id = String(c.id);
        const name = String(c.name ?? id);
        try {
          const d = (await get(`/api/companies/${id}/dashboard`)) as Dashboard;
          let approvals: any[] = [];
          if ((d.pendingApprovals ?? 0) > 0) {
            try {
              approvals = list(await get(`/api/companies/${id}/approvals?status=pending`));
            } catch {
              /* count from dashboard is enough */
            }
          }

          const needsYou: NeedsYou[] = approvals.map((a) => ({
            portfolioId: id,
            kind: 'approval' as const,
            title: String(a.payload?.title ?? a.payload?.summary ?? a.type ?? 'Approval requested'),
            severity: 'warn' as const,
          }));
          // Dashboard count may exceed what the list returned (redaction/pagination).
          for (let i = needsYou.length; i < (d.pendingApprovals ?? 0); i++) {
            needsYou.push({ portfolioId: id, kind: 'approval', title: 'Approval requested', severity: 'warn' });
          }
          if ((d.tasks?.blocked ?? 0) > 0) {
            needsYou.push({
              portfolioId: id,
              kind: 'blocker',
              title: `${d.tasks!.blocked} blocked task(s)`,
              severity: 'warn',
            });
          }
          if ((d.agents?.error ?? 0) > 0) {
            needsYou.push({
              portfolioId: id,
              kind: 'alert',
              title: `${d.agents!.error} agent(s) in error`,
              severity: 'alert',
            });
          }

          const runs: RunDay[] = (d.runActivity ?? []).map((r) => ({
            date: r.date,
            succeeded: r.succeeded ?? 0,
            failed: r.failed ?? 0,
            total: r.total ?? 0,
          }));
          const t = d.tasks ?? {};
          cards.push({
            id,
            name,
            source: 'paperclip',
            status: statusFor(d),
            headline: `${t.inProgress ?? 0} in progress · ${t.open ?? 0} open · ${t.done ?? 0} done`,
            metrics: [],
            agents: {
              active: d.agents?.active ?? 0,
              running: d.agents?.running ?? 0,
              paused: d.agents?.paused ?? 0,
              error: d.agents?.error ?? 0,
            },
            tasks: { open: t.open ?? 0, inProgress: t.inProgress ?? 0, blocked: t.blocked ?? 0, done: t.done ?? 0 },
            spend: { spentCents: d.costs?.monthSpendCents ?? 0, budgetCents: d.costs?.monthBudgetCents ?? 0 },
            runs,
            needsYou,
            updatedAt: new Date().toISOString(),
          });
        } catch (e) {
          errors.push(`paperclip: company "${name}" failed (${(e as Error).message})`);
        }
      }),
    );

    cards.sort((a, b) => a.name.localeCompare(b.name));
    return { cards, errors };
  };
}
