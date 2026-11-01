import { atlasNeeds, withLimits } from './sources/atlas.ts';
import { finalizeAgents } from './sources/agents.ts';
import type { AgentInfo, AgentStatus, LaneInfo, NeedsYou, PortfolioCard, Rollup, RunDay, Source, UsageStats } from './types.ts';
import { laneStatus } from './sources/lanes.ts';
import { GROUPS, type StaffingItem } from './types.ts';
import { evaluateStaffing } from '../../../packages/roster/staffing.ts';
import type { CatalogEntry } from '../../../packages/roster/catalog.ts';

const SEVERITY_RANK = { alert: 0, warn: 1, info: 2 } as const;

export interface RollupExtras {
  usage?: UsageStats;
  agents?: AgentInfo[];
  lanes?: LaneInfo[];
  ui?: Rollup['ui'];
  /** Channels shown in the UI; used to judge Atlas' health together with the provider limits. */
  channels?: string[];
  /** Needs-you items from the work model. */
  needs?: NeedsYou[];
}

export function buildRollup(cards: PortfolioCard[], errors: string[], atlasIn?: AgentStatus, extras: RollupExtras = {}, now = new Date()): Rollup {
  const { usage } = extras;
  const lanes = withSharedLimits(extras.lanes ?? [], usage);
  const agents = finalizeAgents(extras.agents ?? [], usage, cards);
  const staffing = staffingFor(cards, agents, extras.catalog ?? []);
  let atlas = atlasIn && usage ? withLimits(atlasIn, extras.channels ?? atlasIn.platforms.map((p) => p.name), usage.limits) : atlasIn;
  if (atlas) atlas = withLaneReasons(atlas, lanes);
  const portfolios = [...cards].sort((a, b) => a.name.localeCompare(b.name));

  const needsYou: NeedsYou[] = [...(atlas ? atlasNeeds(atlas) : []), ...portfolios.flatMap((p) => p.needsYou), ...staffing.map(staffingNeed), ...(extras.needs ?? [])].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'),
  );

  let spentCents = 0;
  let budgetCents = 0;
  let earnedCents = 0;
  let earnedSources = 0;
  const byDate = new Map<string, RunDay>();
  for (const p of portfolios) {
    spentCents += p.spend?.spentCents ?? 0;
    budgetCents += p.spend?.budgetCents ?? 0;
    if (p.earnings) {
      earnedCents += p.earnings.monthCents;
      earnedSources++;
    }
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
    atlas,
    usage,
    lanes,
    agents,
    staffing,
    earned: { monthCents: earnedCents, sources: earnedSources },
    ui: extras.ui ?? { channels: [], lanes: [], dashboardUrl: '', writeToken: false, groups: GROUPS },
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

/** Staffing check for every unassigned task on every board (cheap and deterministic: no model tokens). */
export function staffingFor(cards: PortfolioCard[], agents: AgentInfo[], catalog: CatalogEntry[]): StaffingItem[] {
  const team = agents.map((a) => ({ id: a.id, name: a.name, role: a.role, profile: a.profile, state: a.state, portfolios: a.portfolios, allPortfolios: a.allPortfolios, personaName: null, personaSlug: a.personaSlug, division: a.division }));
  return cards.flatMap((c) => (c.unassigned ?? []).map((t) => ({
    taskId: t.id, board: c.id, portfolio: c.group, title: t.title, status: t.status,
    result: evaluateStaffing({ title: t.title, body: t.body, portfolio: c.group }, team, catalog),
  })));
}

function staffingNeed(s: StaffingItem): NeedsYou {
  const top = s.result.candidates[0];
  const title = s.result.verdict === 'covered'
    ? `Needs an owner: "${s.title}" — looks like a job for ${s.result.best[0].name}`
    : `Needs an owner: "${s.title}" — no agent on the team fits${top ? `; consider ${top.name}` : ''}`;
  return { portfolioId: s.board, kind: 'staffing', title, severity: s.result.verdict === 'covered' ? 'info' : 'warn', task: { id: s.taskId, board: s.board, portfolio: s.portfolio } };
}

/**
 * The codex CLI signs in with the same ChatGPT plan Hermes uses (confirmed: a lane run hit the plan's
 * limit), so the plan's window from `hermes usage` is the codex lane's limit too.
 */
export function withSharedLimits(lanes: LaneInfo[], usage?: UsageStats): LaneInfo[] {
  const codex = usage?.limits.find((l) => l.provider === 'openai-codex');
  return lanes.map((l) => {
    if (l.name !== 'codex' || !codex || l.limits.length) return l;
    const next: LaneInfo = {
      ...l,
      plan: l.plan ?? codex.plan,
      limits: codex.windows.map((w) => ({ label: w.label, usedPercent: w.usedPercent, resets: w.resetsAt })),
      limitsSource: "ChatGPT plan, via Hermes' Codex login (same account as the codex CLI)",
    };
    return { ...next, status: laneStatus(next) };
  });
}

/** Lane problems surface as Atlas reasons (amber: Atlas runs, but that lane cannot do its work). */
export function withLaneReasons(a: AgentStatus, lanes: LaneInfo[]): AgentStatus {
  const extra = lanes
    .filter((l) => l.status === 'alert' || l.status === 'warn')
    .map((l) => {
      const hot = l.limits.find((x) => x.usedPercent >= 85);
      const why = !l.installed ? 'not installed' : l.login === 'no' ? 'not logged in' : hot ? `${hot.label.toLowerCase()} limit ${Math.round(hot.usedPercent)}% used` : l.runs.lastStatus === 'failed' ? 'last run failed' : 'degraded';
      return { severity: 'warn' as const, text: `${l.name} lane: ${why}` };
    });
  if (!extra.length) return a;
  const reasons = [...a.reasons, ...extra].sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'alert' ? -1 : 1));
  return { ...a, reasons, status: a.status === 'ok' ? 'warn' : a.status };
}

/** Run every source; one failing source degrades the dashboard instead of breaking it. */
export async function collect(sources: Source[]): Promise<{ cards: PortfolioCard[]; errors: string[]; atlas?: AgentStatus; usage?: UsageStats; lanes?: LaneInfo[]; agents?: AgentInfo[]; needs: NeedsYou[] }> {
  const settled = await Promise.allSettled(sources.map((s) => s()));
  const cards: PortfolioCard[] = [];
  const errors: string[] = [];
  let atlas: AgentStatus | undefined;
  let usage: UsageStats | undefined;
  let lanes: LaneInfo[] | undefined;
  let agents: AgentInfo[] | undefined;
  const needs: NeedsYou[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      cards.push(...r.value.cards);
      errors.push(...r.value.errors);
      atlas ??= r.value.atlas;
      usage ??= r.value.usage;
      lanes ??= r.value.lanes;
      agents ??= r.value.agents;
      needs.push(...(r.value.needs ?? []));
    } else {
      errors.push(`source failed: ${(r.reason as Error).message}`);
    }
  }
  return { cards, errors, atlas, usage, lanes, agents, needs };
}
