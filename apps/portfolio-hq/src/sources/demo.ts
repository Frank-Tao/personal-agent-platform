import type { PortfolioCard, RunDay, Source } from '../types.ts';

function runs(seed: number): RunDay[] {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86_400_000).toISOString().slice(0, 10);
    const total = 4 + ((i * seed) % 9);
    const failed = (i * seed) % 5 === 0 ? 1 : 0;
    return { date: d, succeeded: total - failed, failed, total };
  });
}

/** Fake data so the dashboard can be developed and demoed with nothing else running. */
export const demoSource: Source = async () => {
  const now = new Date().toISOString();
  const cards: PortfolioCard[] = [
    {
      id: 'software', name: 'Software', source: 'demo', status: 'warn',
      headline: '3 in progress · 8 open · 41 done',
      metrics: [{ label: 'PRs ready', value: '2' }, { label: 'MRR', value: '$1,840', trend: 'up' }],
      agents: { active: 3, running: 1, paused: 0, error: 0 },
      tasks: { open: 8, inProgress: 3, blocked: 1, done: 41 },
      spend: { spentCents: 6400, budgetCents: 15000 }, runs: runs(3),
      needsYou: [
        { portfolioId: 'software', kind: 'approval', title: 'Approve deploy of billing-service v1.4', severity: 'warn' },
        { portfolioId: 'software', kind: 'blocker', title: '1 blocked task', severity: 'warn' },
      ],
      updatedAt: now,
    },
    {
      id: 'content', name: 'Content & Brand', source: 'demo', status: 'ok',
      headline: '4 drafts awaiting review',
      metrics: [{ label: 'Followers', value: '12.4k', trend: 'up' }, { label: 'Posts / wk', value: '3' }],
      agents: { active: 2, running: 0, paused: 0, error: 0 },
      tasks: { open: 5, inProgress: 2, blocked: 0, done: 19 },
      spend: { spentCents: 2100, budgetCents: 8000 }, runs: runs(5),
      needsYou: [{ portfolioId: 'content', kind: 'approval', title: 'Approve LinkedIn post: "What I learned shipping agents"', severity: 'warn' }],
      updatedAt: now,
    },
    {
      id: 'investments', name: 'Investments', source: 'demo', status: 'ok',
      headline: 'Read-only monitoring',
      metrics: [{ label: 'Value', value: '$412k' }, { label: 'MTD', value: '+2.1%', trend: 'up' }],
      agents: { active: 1, running: 0, paused: 0, error: 0 },
      tasks: { open: 2, inProgress: 1, blocked: 0, done: 12 },
      spend: { spentCents: 900, budgetCents: 5000 }, runs: runs(2),
      needsYou: [{ portfolioId: 'investments', kind: 'alert', title: 'NVDA moved -6% — review thesis note', severity: 'info' }],
      updatedAt: now,
    },
    {
      id: 'ventures', name: 'Ventures & Ops', source: 'demo', status: 'alert',
      headline: '1 agent in error',
      metrics: [{ label: 'Leads', value: '17' }, { label: 'Replies', value: '4' }],
      agents: { active: 2, running: 0, paused: 0, error: 1 },
      tasks: { open: 6, inProgress: 0, blocked: 2, done: 7 },
      spend: { spentCents: 7400, budgetCents: 8000 }, runs: runs(4),
      needsYou: [{ portfolioId: 'ventures', kind: 'alert', title: '1 agent(s) in error', severity: 'alert' }],
      updatedAt: now,
    },
    {
      id: 'personal', name: 'Personal', source: 'demo', status: 'ok',
      headline: 'Cash runway 7.2 months',
      metrics: [{ label: 'Runway', value: '7.2 mo' }, { label: 'Bills this week', value: '3' }],
      needsYou: [{ portfolioId: 'personal', kind: 'deadline', title: 'Q4 estimated tax due', severity: 'info', dueAt: '2027-01-15' }],
      updatedAt: now,
    },
  ];
  return { cards, errors: [] };
};
