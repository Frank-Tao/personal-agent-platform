import type { Rollup, Status } from './types.ts';

const ICON: Record<Status, string> = { ok: '🟢', warn: '🟡', alert: '🔴', unknown: '⚪' };
const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** Markdown brief for Hermes to deliver on Telegram. Built only from the rollup (summary layer). */
export function buildBrief(r: Rollup): string {
  const lines: string[] = [];
  lines.push(`**Portfolio brief** — ${r.generatedAt.slice(0, 10)}`);
  lines.push('');

  if (r.needsYou.length) {
    lines.push(`**Needs you (${r.needsYou.length})**`);
    const names = new Map(r.portfolios.map((p) => [p.id, p.name]));
    for (const n of r.needsYou.slice(0, 10)) {
      const due = n.dueAt ? ` _(due ${n.dueAt})_` : '';
      lines.push(`- [${names.get(n.portfolioId) ?? n.portfolioId}] ${n.title}${due}`);
    }
    if (r.needsYou.length > 10) lines.push(`- …and ${r.needsYou.length - 10} more`);
  } else {
    lines.push('**Needs you:** nothing 🎉');
  }

  lines.push('');
  lines.push('**Portfolios**');
  for (const p of r.portfolios) {
    const m = p.metrics.slice(0, 3).map((x) => `${x.label} ${x.value}`).join(' · ');
    lines.push(`${ICON[p.status]} **${p.name}** — ${p.headline}${m ? ` (${m})` : ''}`);
  }

  lines.push('');
  lines.push(`**Spend this month:** ${money(r.spend.spentCents)} / ${money(r.spend.budgetCents)} (${r.spend.utilizationPercent}%)`);

  if (r.errors.length) {
    lines.push('');
    lines.push(`⚠️ Data issues: ${r.errors.join('; ')}`);
  }
  return lines.join('\n');
}
