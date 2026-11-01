import { GROUPS, type Rollup, type Status } from './types.ts';

const ICON: Record<Status, string> = { ok: '🟢', warn: '🟡', alert: '🔴', unknown: '⚪' };
const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** Markdown brief for Atlas to deliver on Telegram. Built only from the rollup (summary layer). */
export function buildBrief(r: Rollup): string {
  const lines: string[] = [];
  lines.push(`**Atlas brief** — ${r.generatedAt.slice(0, 10)}`);
  lines.push('');

  if (r.atlas) {
    const a = r.atlas;
    const failing = a.jobs.filter((j) => j.enabled && j.lastStatus === 'error').length;
    const lanes = a.lanes.filter((l) => !l.available).map((l) => l.name);
    lines.push(
      `${ICON[a.status]} **Atlas** — gateway ${a.gateway.state} · ${a.workersRunning} worker(s) running · ` +
        `${a.jobs.filter((j) => j.enabled).length} jobs${failing ? `, ${failing} failing` : ''}` +
        (lanes.length ? ` · lanes missing: ${lanes.join(', ')}` : ''),
    );
    if (r.usage) {
      const u = r.usage;
      const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
      lines.push(`Tokens: ${k(u.today.tokens)} today · ${k(u.week.tokens)} this week · cost $${u.month.costUsd.toFixed(2)} (30d)`);
    }
    for (const reason of a.reasons) lines.push(`${reason.severity === 'alert' ? '🔴' : '🟡'} ${reason.text}`);
    lines.push('');
  }

  if (r.earned.sources) lines.push(`**Earned this month:** ${money(r.earned.monthCents)}`, '');

  if (r.needsYou.length) {
    lines.push(`**Needs you (${r.needsYou.length})**`);
    const names = new Map(r.portfolios.map((p) => [p.id, p.name]));
    names.set('atlas', 'Atlas');
    for (const n of r.needsYou.slice(0, 10)) {
      const due = n.dueAt ? ` _(due ${n.dueAt})_` : '';
      lines.push(`- [${names.get(n.portfolioId) ?? n.portfolioId}] ${n.title}${due}`);
    }
    if (r.needsYou.length > 10) lines.push(`- …and ${r.needsYou.length - 10} more`);
  } else {
    lines.push('**Needs you:** nothing 🎉');
  }

  for (const g of GROUPS) {
    const cards = r.portfolios.filter((p) => (p.group ?? 'micropace') === g.id);
    if (!cards.length) continue;
    lines.push('');
    lines.push(`**${g.name}**`);
    for (const p of cards) {
      const m = p.metrics.slice(0, 3).map((x) => `${x.label} ${x.value}`).join(' · ');
      lines.push(`${ICON[p.status]} **${p.name}** — ${p.headline}${m ? ` (${m})` : ''}`);
    }
  }

  if (r.spend.budgetCents) {
    lines.push('');
    lines.push(`**Spend this month:** ${money(r.spend.spentCents)} / ${money(r.spend.budgetCents)} (${r.spend.utilizationPercent}%)`);
  }

  if (r.errors.length) {
    lines.push('');
    lines.push(`⚠️ Data issues: ${r.errors.join('; ')}`);
  }
  return lines.join('\n');
}
