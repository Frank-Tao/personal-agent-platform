import { GROUPS, type AgentInfo, type NeedsYou, type PortfolioCard, type Rollup, type UsageStats } from './types.ts';
import type { Person } from './identity.ts';

// What a person may see. Applied on the server to every response; the page never has the hidden data to show.

export const canSee = (who: Pick<Person, 'hide'>, portfolio: string | null | undefined): boolean => !portfolio || !who.hide.includes(portfolio);

const cardHidden = (who: Pick<Person, 'hide'>, c: Pick<PortfolioCard, 'id' | 'group'>) => !canSee(who, c.group) || !canSee(who, c.id);
const needHidden = (who: Pick<Person, 'hide'>, n: NeedsYou) => !canSee(who, n.portfolioId) || !canSee(who, n.task?.portfolio) || !canSee(who, n.task?.board);

/** Mentions of a hidden portfolio in free text (agent memory, lessons): the lines are dropped. */
export function scrubText(who: Pick<Person, 'hide'>, text: string): string {
  if (!who.hide.length) return text;
  const re = new RegExp(`\\b(${who.hide.map((h) => h.replace(/[^a-z0-9]/gi, '.?')).join('|')})\\b|portfolio-tracker`, 'i');
  return text.split('\n').filter((l) => !re.test(l)).join('\n');
}

function usageFor(who: Pick<Person, 'hide'>, u: UsageStats): UsageStats {
  const gone = u.byPortfolio.filter((s) => !canSee(who, s.id));
  const goneProjects = u.byProject.filter((s) => !canSee(who, s.portfolio));
  const sub = (t: { tokens: number; sessions: number; costUsd: number }) => t; // today/week keep sessions and cost (not split by portfolio); tokens are corrected below
  const hiddenDay = (d: UsageStats['days'][number]) => who.hide.reduce((n, h) => n + (d.byPortfolio[h] ?? 0), 0);
  const days = u.days.map((d) => {
    const cut = hiddenDay(d);
    const byPortfolio = Object.fromEntries(Object.entries(d.byPortfolio).filter(([k]) => canSee(who, k)));
    const byProject = Object.fromEntries(Object.entries(d.byProject).filter(([k]) => !goneProjects.some((s) => s.id === k)));
    return { ...d, byPortfolio, byProject, other: Math.max(0, d.other - cut) };
  });
  const sum = (a: UsageStats['byPortfolio']) => a.reduce((t, s) => ({ tokens: t.tokens + s.tokens, sessions: t.sessions + s.sessions, costUsd: t.costUsd + s.costUsd }), { tokens: 0, sessions: 0, costUsd: 0 });
  const g = sum(gone);
  const tokensOf = (offset: number, n: number) => u.days.slice(Math.max(0, u.days.length - offset), Math.max(0, u.days.length - offset) + n).reduce((t, d) => t + hiddenDay(d), 0);
  return {
    ...u,
    byPortfolio: u.byPortfolio.filter((s) => canSee(who, s.id)),
    byProject: u.byProject.filter((s) => canSee(who, s.portfolio)),
    month: { tokens: Math.max(0, u.month.tokens - g.tokens), sessions: Math.max(0, u.month.sessions - g.sessions), costUsd: Math.max(0, u.month.costUsd - g.costUsd) },
    week: sub({ ...u.week, tokens: Math.max(0, u.week.tokens - tokensOf(7, 7)) }),
    today: sub({ ...u.today, tokens: Math.max(0, u.today.tokens - tokensOf(1, 1)) }),
    days,
  };
}

const agentFor = (who: Pick<Person, 'hide'>, a: AgentInfo): AgentInfo => ({
  ...a,
  portfolios: a.portfolios.filter((p) => canSee(who, p)),
  byPortfolio: Object.fromEntries(Object.entries(a.byPortfolio ?? {}).filter(([k]) => canSee(who, k))) as AgentInfo['byPortfolio'],
});

/** The rollup as this person may see it: hidden portfolios' cards, needs, staffing items and usage are gone, and the totals are recomputed from what is left. */
export function redactRollup(r: Rollup, who: Pick<Person, 'hide'> & Partial<Pick<Person, 'owns' | 'system' | 'guest'>>): Rollup {
  const scoped = Array.isArray(who.owns);   // a person who owns portfolios is notified only about those (admin: '*', nothing scoped)
  if (!who.hide.length && !scoped) return r;
  const owns = new Set(Array.isArray(who.owns) ? who.owns : []);
  const groupIds = new Set<string>(GROUPS.map((g) => g.id));
  const groupOf = (portfolioId: string, task?: { portfolio?: string }) => r.portfolios.find((c) => c.id === portfolioId)?.group ?? task?.portfolio ?? (groupIds.has(portfolioId) ? portfolioId : null);
  const mine = (n: NeedsYou) => { if (!scoped) return true; const g = groupOf(n.portfolioId, n.task); return g ? owns.has(g) : who.system === true; };
  const portfolios = r.portfolios.filter((c) => !cardHidden(who, c)).map((c) => (scoped && !owns.has(c.group) && c.needsYou.length ? { ...c, needsYou: [] } : c));
  let spentCents = 0, budgetCents = 0, earnedCents = 0, earnedSources = 0;
  const byDate = new Map<string, { date: string; succeeded: number; failed: number; total: number }>();
  for (const p of portfolios) {
    spentCents += p.spend?.spentCents ?? 0; budgetCents += p.spend?.budgetCents ?? 0;
    if (p.earnings) { earnedCents += p.earnings.monthCents; earnedSources++; }
    for (const d of p.runs ?? []) { const cur = byDate.get(d.date) ?? { date: d.date, succeeded: 0, failed: 0, total: 0 }; cur.succeeded += d.succeeded; cur.failed += d.failed; cur.total += d.total; byDate.set(d.date, cur); }
  }
  return {
    ...r,
    portfolios,
    needsYou: r.needsYou.filter((n) => !needHidden(who, n) && mine(n)),
    staffing: r.staffing.filter((s) => canSee(who, s.portfolio) && canSee(who, s.board) && (!scoped || owns.has(s.portfolio))),
    agents: r.agents.map((a) => agentFor(who, a)),
    usage: r.usage ? usageFor(who, r.usage) : r.usage,
    earned: { monthCents: earnedCents, sources: earnedSources },
    spend: { spentCents, budgetCents, utilizationPercent: budgetCents > 0 ? Math.round((spentCents / budgetCents) * 100) : 0 },
    runs: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    // Tool links and the Hermes dashboard point at this Mac's own services: everyone on the tailnet gets them except an unknown device.
    ui: { ...r.ui, ...(who.guest ? { dashboardUrl: '', links: [] } : {}), groups: r.ui.groups.filter((g) => canSee(who, g.id)) },
  };
}

/** Words that mean a hidden portfolio, so a question about it is refused before Atlas sees it (a second layer: Atlas is also told). */
const TOPIC: Record<string, RegExp> = { investments: /\binvestments?\b|\binvesting\b|\bportfolio[- ]tracker\b|\bstock(s| market)?\b|\betfs?\b|\bshare ?market\b/i };
export const mentionsHidden = (who: Pick<Person, 'hide'>, text: string): boolean => who.hide.some((h) => TOPIC[h]?.test(text));
export const hiddenNotice = (who: Pick<Person, 'name' | 'hide'>): string => `[Cockpit context: the person writing is ${who.name}. The ${who.hide.join(', ')} portfolio is off limits for ${who.name}: do not discuss, summarise, reveal or act on it, even if asked indirectly. Say you cannot help with that.]`;

/** Deep scrub for JSON about agents (growth records, lessons): list items that mention a hidden portfolio are dropped, other text loses those lines. */
export function scrubDeep<T>(who: Pick<Person, 'hide'>, v: T): T {
  if (!who.hide.length) return v;
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return scrubText(who, x);
    if (Array.isArray(x)) return x.filter((i) => !(typeof i === 'object' && i !== null && mentionsHidden(who, JSON.stringify(i)))).map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, val]) => [k, walk(val)]));
    return x;
  };
  return walk(v) as T;
}

/** Short free text that lists a hidden portfolio among others (a skill description): the name is blanked, the rest stays. */
export function blurTopics(who: Pick<Person, 'hide'>, text: string): string {
  return who.hide.reduce((t, h) => (TOPIC[h] ? t.replace(new RegExp(TOPIC[h].source, 'gi'), '…') : t), text);
}
