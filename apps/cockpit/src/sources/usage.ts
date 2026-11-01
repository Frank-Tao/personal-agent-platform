import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NO_PROJECT, type Bucket, type ProviderLimit, type Source, type UsageDay, type UsageSlice, type UsageStats, type UsageTotals } from '../types.ts';
import type { Runner } from './hermesKanban.ts';

// Atlas' (and every other agent's) traffic and spend. Read-only inputs:
//   <home>/state.db and <home>/profiles/<name>/state.db   `sessions` tables, one DB per Hermes profile
//   `hermes usage --json`                                  the provider's account limits
// Only counts, models and channel/agent names are read — never titles, prompts or message text.

const DAYS = 14;
const LIMITS_TTL_MS = 5 * 60_000;
const CHAT_SOURCES = new Set(['telegram', 'whatsapp', 'discord', 'slack', 'signal', 'api_server', 'webhook']);

export const bucketFor = (source: string): Bucket => (CHAT_SOURCES.has(source) ? 'chat' : source === 'cron' ? 'jobs' : 'other');

interface Opts {
  home: string;
  /** Kanban boards folder (<home>/kanban/boards) and board slug → portfolio id, to tie sessions to projects. */
  boardsDir?: string;
  boardGroups?: Record<string, string>;
  run: Runner;
  now?: () => Date;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sum = (rows: UsageDay[]): UsageTotals => ({ tokens: rows.reduce((n, r) => n + r.chat + r.jobs + r.other, 0), sessions: rows.reduce((n, r) => n + r.sessions, 0), costUsd: 0 });

export function parseLimits(raw: string): ProviderLimit[] {
  const j = JSON.parse(raw);
  return (Array.isArray(j) ? j : [j])
    .filter((p) => p && Array.isArray(p.windows))
    .map((p) => ({
      provider: String(p.provider ?? 'provider'),
      plan: p.plan ? String(p.plan) : null,
      windows: p.windows.map((w: any) => ({
        label: String(w.label ?? 'window'),
        usedPercent: Number(w.used_percent ?? 0),
        resetsAt: w.resets_at ?? null,
      })),
    }));
}

interface RunSpan { profile: string; start: number; end: number | null; portfolio: string | null; project: string }

/**
 * Which project did each agent session work for? A kanban run says "profile P worked on task T from A to B", and T carries its
 * project (tenant) and board (portfolio). A session of profile P that starts inside that window is that run's worker.
 * Read-only; ids and timestamps only. A board that cannot be read just contributes nothing.
 */
export function loadRuns(boardsDir: string, groups: Record<string, string>, errors: string[]): RunSpan[] {
  const out: RunSpan[] = [];
  let boards: string[] = [];
  try { boards = readdirSync(boardsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const b of boards) {
    const path = join(boardsDir, b, 'kanban.db');
    if (!existsSync(path)) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      for (const r of db.prepare(`SELECT r.profile profile, r.started_at s, r.ended_at e, t.tenant tenant FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE r.started_at >= ?`).all(Date.now() / 1000 - 31 * 86_400) as Array<{ profile: string | null; s: number; e: number | null; tenant: string | null }>) {
        out.push({ profile: r.profile ?? 'default', start: r.s, end: r.e, portfolio: groups[b] ?? null, project: r.tenant || `${groups[b] ?? b}:(no project)` });
      }
    } catch (e) {
      errors.push(`usage: cannot read runs of board ${b} (${(e as Error).message})`);
    } finally { db?.close(); }
  }
  return out;
}

const SLACK_BEFORE = 30, SLACK_AFTER = 120;
export function attribute(runs: RunSpan[], profile: string, startedAt: number): RunSpan | null {
  let best: RunSpan | null = null;
  for (const r of runs) {
    if (r.profile !== profile) continue;
    if (startedAt >= r.start - SLACK_BEFORE && startedAt <= (r.end ?? Date.now() / 1000) + SLACK_AFTER && (!best || r.start > best.start)) best = r;
  }
  return best;
}

/** The default profile lives in <home>; every other profile has its own <home>/profiles/<name>/state.db. */
export function ledgers(home: string): Array<{ profile: string; path: string; required: boolean }> {
  const out = [{ profile: 'default', path: join(home, 'state.db'), required: true }];
  try {
    for (const d of readdirSync(join(home, 'profiles'), { withFileTypes: true })) {
      const path = join(home, 'profiles', d.name, 'state.db');
      if (d.isDirectory() && existsSync(path)) out.push({ profile: d.name, path, required: false });
    }
  } catch {
    /* no profiles directory */
  }
  return out;
}

export function usageSource(opts: Opts): Source {
  const now = opts.now ?? (() => new Date());
  let limits: { at: number; value: ProviderLimit[] } | undefined;

  async function getLimits(): Promise<ProviderLimit[]> {
    if (limits && Date.now() - limits.at < LIMITS_TTL_MS) return limits.value;
    let value: ProviderLimit[] = limits?.value ?? []; // keep the last known value if the provider call fails
    try {
      value = parseLimits(await opts.run(['usage', '--json']));
    } catch {
      /* no credential or offline: limits are optional */
    }
    limits = { at: Date.now(), value };
    return value;
  }

  return async () => {
    const t = now();
    const errors: string[] = [];
    const days: UsageDay[] = Array.from({ length: DAYS }, (_, i) => {
      const d = new Date(t.getTime() - (DAYS - 1 - i) * 86_400_000);
      return { date: ymd(d), chat: 0, jobs: 0, other: 0, sessions: 0, bySource: {}, byProfile: {}, byPortfolio: {}, byProject: {} };
    });
    const byDate = new Map(days.map((d) => [d.date, d]));
    const costByDate = new Map<string, number>();
    const models = new Map<string, UsageStats['byModel'][number]>();
    const channels = new Map<string, UsageStats['channels'][number]>();
    const recent: UsageStats['recent'] = [];
    let lastTs = 0;
    const runs = opts.boardsDir ? loadRuns(opts.boardsDir, opts.boardGroups ?? {}, errors) : [];
    const portfolios = new Map<string, UsageSlice>();
    const projects = new Map<string, UsageSlice>();
    const bump = (m: Map<string, UsageSlice>, id: string, portfolio: string | null, tok: number, n: number, cost: number) => {
      const x = m.get(id) ?? { id, portfolio, tokens: 0, sessions: 0, costUsd: 0 };
      x.tokens += tok; x.sessions += n; x.costUsd += cost; m.set(id, x);
    };
    const stats: UsageStats = {
      byPortfolio: [],
      byProject: [],
      today: { tokens: 0, sessions: 0, costUsd: 0 },
      week: { tokens: 0, sessions: 0, costUsd: 0 },
      month: { tokens: 0, sessions: 0, costUsd: 0 },
      days,
      byModel: [],
      lastActivityAt: null,
      channels: [],
      recent,
      limits: await getLimits(),
    };

    const since30 = t.getTime() / 1000 - 30 * 86_400;
    const since7 = t.getTime() / 1000 - 7 * 86_400;
    for (const ledger of ledgers(opts.home)) {
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(ledger.path, { readOnly: true });
        const rows = db
          .prepare(
            `SELECT date(started_at,'unixepoch','localtime') d, source,
                    COALESCE(NULLIF(model,''),'unknown') model, COALESCE(billing_mode,'') billing,
                    COUNT(*) n, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) tok,
                    SUM(COALESCE(actual_cost_usd, estimated_cost_usd, 0)) cost
               FROM sessions WHERE started_at >= ? GROUP BY d, source, model, billing`,
          )
          .all(since30) as Array<{ d: string; source: string; model: string; billing: string; n: number; tok: number; cost: number }>;
        for (const r of rows) {
          const day = byDate.get(r.d);
          if (day) {
            day[bucketFor(r.source)] += r.tok;
            day.sessions += r.n;
            day.bySource[r.source] = (day.bySource[r.source] ?? 0) + r.tok;
            day.byProfile[ledger.profile] = (day.byProfile[ledger.profile] ?? 0) + r.tok;
            costByDate.set(r.d, (costByDate.get(r.d) ?? 0) + r.cost);
          }
          const m = models.get(r.model) ?? { model: r.model, billing: r.billing, sessions: 0, tokens: 0, costUsd: 0 };
          m.sessions += r.n;
          m.tokens += r.tok;
          m.costUsd += r.cost;
          if (r.billing && !m.billing) m.billing = r.billing;
          models.set(r.model, m);
          stats.month.tokens += r.tok;
          stats.month.sessions += r.n;
          stats.month.costUsd += r.cost;
        }

        // Per-session pass for the portfolio/project breakdown (only counts and times; never titles or text).
        for (const r of db
          .prepare(`SELECT started_at ts, date(started_at,'unixepoch','localtime') d, COALESCE(input_tokens,0)+COALESCE(output_tokens,0) tok, COALESCE(actual_cost_usd, estimated_cost_usd, 0) cost FROM sessions WHERE started_at >= ?`)
          .all(since30) as Array<{ ts: number; d: string; tok: number; cost: number }>) {
          const hit = attribute(runs, ledger.profile, r.ts);
          const pid = hit?.portfolio ?? NO_PROJECT, jid = hit ? hit.project : NO_PROJECT;
          bump(portfolios, pid, hit?.portfolio ?? null, r.tok, 1, r.cost);
          bump(projects, jid, hit?.portfolio ?? null, r.tok, 1, r.cost);
          const day = byDate.get(r.d);
          if (day) { day.byPortfolio[pid] = (day.byPortfolio[pid] ?? 0) + r.tok; day.byProject[jid] = (day.byProject[jid] ?? 0) + r.tok; }
        }

        for (const c of db
          .prepare(
            `SELECT source, COUNT(*) n, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) tok,
                    MAX(COALESCE(last_activity_at, started_at)) ts FROM sessions WHERE started_at >= ? GROUP BY source`,
          )
          .all(since7) as Array<{ source: string; n: number; tok: number; ts: number }>) {
          channels.set(`${ledger.profile}\u0000${c.source}`, { profile: ledger.profile, source: c.source, sessions: c.n, tokens: c.tok, lastAt: new Date(c.ts * 1000).toISOString() });
        }

        const last = db.prepare(`SELECT MAX(COALESCE(last_activity_at, started_at)) ts FROM sessions`).get() as { ts: number | null };
        lastTs = Math.max(lastTs, last.ts ?? 0);
        for (const r of db
          .prepare(
            `SELECT COALESCE(last_activity_at, started_at) ts, source, COALESCE(NULLIF(model,''),'unknown') model,
                    COALESCE(input_tokens,0)+COALESCE(output_tokens,0) tok FROM sessions ORDER BY ts DESC LIMIT 8`,
          )
          .all() as Array<{ ts: number; source: string; model: string; tok: number }>) {
          recent.push({ at: new Date(r.ts * 1000).toISOString(), source: r.source, profile: ledger.profile, model: r.model, tokens: r.tok });
        }
      } catch (e) {
        errors.push(`usage: cannot read ${ledger.required ? 'Hermes sessions' : `sessions of profile ${ledger.profile}`} (${(e as Error).message})`);
      } finally {
        db?.close();
      }
    }

    const bySize = (m: Map<string, UsageSlice>) => [...m.values()].sort((a, b) => (a.id === NO_PROJECT ? 1 : b.id === NO_PROJECT ? -1 : b.tokens - a.tokens));
    stats.byPortfolio = bySize(portfolios);
    stats.byProject = bySize(projects);
    stats.byModel = [...models.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 6);
    stats.channels = [...channels.values()];
    stats.lastActivityAt = lastTs ? new Date(lastTs * 1000).toISOString() : null;
    recent.sort((a, b) => b.at.localeCompare(a.at));
    recent.length = Math.min(recent.length, 8);

    // The month figure above covers 30 days; today/week come from the zero-filled day list.
    const today = days.at(-1)!;
    stats.today = { ...sum([today]), costUsd: costByDate.get(today.date) ?? 0 };
    stats.week = { ...sum(days.slice(-7)), costUsd: days.slice(-7).reduce((n, d) => n + (costByDate.get(d.date) ?? 0), 0) };
    return { cards: [], errors, usage: stats };
  };
}
