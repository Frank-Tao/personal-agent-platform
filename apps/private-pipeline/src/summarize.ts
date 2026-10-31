import type { Extraction } from './extract.ts';

// Pure function: validated numbers in, summary-layer card out. All text is generated here.

export interface Summary {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'alert' | 'unknown';
  headline: string;
  metrics: Array<{ label: string; value: string; trend?: 'up' | 'down' | 'flat' }>;
  alerts: Array<{ title: string; dueAt?: string; severity: 'info' | 'warn' | 'alert' }>;
  updatedAt: string;
}

export interface Tax {
  /** ISO date of the next estimated-tax deadline, set by the user in config (not read from documents). */
  nextEstimatedTaxDue?: string;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** `byAccount`: alias (from the file name) -> extractions, any order. */
export function summarize(byAccount: Record<string, Extraction[]>, tax: Tax = {}, now = new Date()): Summary {
  const aliases = Object.keys(byAccount).filter((a) => byAccount[a].length > 0);
  if (aliases.length === 0) {
    return {
      id: 'personal', name: 'Personal', status: 'unknown', headline: 'No statements processed yet',
      metrics: [], alerts: [], updatedAt: now.toISOString(),
    };
  }

  let cash = 0;
  let billsCount = 0;
  let billsTotal = 0;
  const monthly = new Map<string, number>(); // period -> net outflow across accounts

  for (const a of aliases) {
    const sorted = [...byAccount[a]].sort((x, y) => x.periodEnd.localeCompare(y.periodEnd));
    const latest = sorted[sorted.length - 1];
    cash += latest.endingBalance;
    billsCount += latest.upcomingBillsCount;
    billsTotal += latest.upcomingBillsTotal;
    for (const e of sorted) monthly.set(e.periodEnd, (monthly.get(e.periodEnd) ?? 0) + (e.totalOut - e.totalIn));
  }

  const recent = [...monthly.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-3).map(([, v]) => v);
  const burn = recent.length ? recent.reduce((s, v) => s + v, 0) / recent.length : 0;

  const metrics: Summary['metrics'] = [{ label: 'Cash', value: `$${fmt(cash)}` }];
  let runwayMonths: number | undefined;
  if (burn > 0) {
    runwayMonths = cash / burn;
    metrics.push({ label: 'Runway', value: `${runwayMonths.toFixed(1)} mo` });
    metrics.push({ label: 'Net burn / mo', value: `$${fmt(burn)}`, trend: 'down' });
  } else {
    metrics.push({ label: 'Net flow / mo', value: `+$${fmt(-burn)}`, trend: 'up' });
  }
  if (billsCount > 0) metrics.push({ label: 'Upcoming bills', value: `${billsCount} · $${fmt(billsTotal)}` });

  const alerts: Summary['alerts'] = [];
  if (cash < 0) alerts.push({ title: 'Net cash is negative', severity: 'alert' });
  else if (runwayMonths !== undefined && runwayMonths < 3) alerts.push({ title: 'Cash runway under 3 months', severity: 'alert' });
  else if (runwayMonths !== undefined && runwayMonths < 6) alerts.push({ title: 'Cash runway under 6 months', severity: 'warn' });
  if (tax.nextEstimatedTaxDue) alerts.push({ title: 'Estimated tax due', dueAt: tax.nextEstimatedTaxDue, severity: 'info' });

  const status = alerts.some((a) => a.severity === 'alert') ? 'alert' : alerts.some((a) => a.severity === 'warn') ? 'warn' : 'ok';
  const headline =
    runwayMonths !== undefined ? `Cash runway ${runwayMonths.toFixed(1)} months` : `Cash $${fmt(cash)}, positive net flow`;

  return { id: 'personal', name: 'Personal', status, headline, metrics, alerts, updatedAt: now.toISOString() };
}
