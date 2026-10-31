import type { NeedsYou, PortfolioCard, Rollup, RunDay, Source } from './types.ts';

const SEVERITY_RANK = { alert: 0, warn: 1, info: 2 } as const;

export function buildRollup(cards: PortfolioCard[], errors: string[], now = new Date()): Rollup {
  const portfolios = [...cards].sort((a, b) => a.name.localeCompare(b.name));

  const needsYou: NeedsYou[] = portfolios
    .flatMap((p) => p.needsYou)
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'),
    );

  let spentCents = 0;
  let budgetCents = 0;
  const byDate = new Map<string, RunDay>();
  for (const p of portfolios) {
    spentCents += p.spend?.spentCents ?? 0;
    budgetCents += p.spend?.budgetCents ?? 0;
    for (const r of p.runs ?? []) {
      const cur = byDate.get(r.date) ?? { date: r.date, succeeded: 0, failed: 0, total: 0 };
      cur.succeeded += r.succeeded;
      cur.failed += r.failed;
      cur.total += r.total;
      byDate.set(r.date, cur);
    }
  }

  return {
    generatedAt: now.toISOString(),
    portfolios,
    needsYou,
    spend: {
      spentCents,
      budgetCents,
      utilizationPercent: budgetCents > 0 ? Math.round((spentCents / budgetCents) * 100) : 0,
    },
    runs: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    errors,
  };
}

/** Run every source; one failing source degrades the dashboard instead of breaking it. */
export async function collect(sources: Source[]): Promise<{ cards: PortfolioCard[]; errors: string[] }> {
  const settled = await Promise.allSettled(sources.map((s) => s()));
  const cards: PortfolioCard[] = [];
  const errors: string[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      cards.push(...r.value.cards);
      errors.push(...r.value.errors);
    } else {
      errors.push(`source failed: ${(r.reason as Error).message}`);
    }
  }
  return { cards, errors };
}
