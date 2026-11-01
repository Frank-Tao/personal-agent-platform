import { access, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import type { Layout } from '../config.ts';
import type { AgentStatus, GroupId, Job, NeedsYou, PortfolioCard, ProviderLimit, Reason, Source, Status } from '../types.ts';
import type { Runner } from './hermesKanban.ts';

// Atlas = the Hermes gateway acting as chief of staff. Read-only view of:
//   <home>/gateway_state.json               gateway state, heartbeat, chat platforms, served profiles
//   <home>/cron/jobs.json, <home>/profiles/<p>/cron/jobs.json   scheduled jobs per profile
//   hermes kanban boards list --json        workers running right now
// Job errors are reported by status only — their text can contain anything the job touched.

const STALE_SECONDS = 600;

interface Opts {
  home: string;
  run: Runner;
  layout: Pick<Layout, 'cron' | 'lanes'> & Partial<Pick<Layout, 'channels'>>;
  hasCommand?: (name: string) => Promise<boolean>;
  now?: () => Date;
}

interface RawJob {
  id?: string;
  name?: string;
  enabled?: boolean;
  last_status?: string | null;
  last_run_at?: string | null;
  next_run_at?: string | null;
  schedule_display?: string;
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf8'));
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** launchd starts us with a bare PATH, so also look where these CLIs are usually installed. */
export async function findOnPath(name: string): Promise<string | null> {
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.openclaw', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  for (const d of dirs) {
    try {
      await access(join(d, name), constants.X_OK);
      return join(d, name);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export const onPath = async (name: string): Promise<boolean> => (await findOnPath(name)) !== null;

export function groupForJob(name: string, rules: Layout['cron']): GroupId | undefined {
  return rules.find((r) => new RegExp(r.match, 'i').test(name))?.group;
}

async function loadJobs(home: string, rules: Layout['cron']): Promise<Job[]> {
  const files: Array<[string, string]> = [['default', join(home, 'cron', 'jobs.json')]];
  try {
    for (const p of await readdir(join(home, 'profiles'))) files.push([p, join(home, 'profiles', p, 'cron', 'jobs.json')]);
  } catch {
    /* no profiles */
  }
  const jobs: Job[] = [];
  for (const [profile, file] of files) {
    let raw: any;
    try {
      raw = await readJson(file);
    } catch {
      continue; // profile without cron jobs
    }
    for (const j of (Array.isArray(raw) ? raw : raw.jobs ?? []) as RawJob[]) {
      const name = j.name ?? j.id ?? 'unnamed job';
      jobs.push({
        name,
        profile,
        group: groupForJob(name, rules),
        enabled: j.enabled !== false,
        lastStatus: j.last_status === 'ok' ? 'ok' : j.last_status ? 'error' : null,
        lastRunAt: j.last_run_at ?? null,
        nextRunAt: j.next_run_at ?? null,
        schedule: j.schedule_display ?? '',
      });
    }
  }
  return jobs;
}

function jobCard(j: Job, now: string): PortfolioCard {
  const id = `cron:${j.profile}:${j.name}`;
  const status: Status = !j.enabled ? 'unknown' : j.lastStatus === 'error' ? 'alert' : j.lastStatus === 'ok' ? 'ok' : 'unknown';
  const needsYou: NeedsYou[] =
    j.enabled && j.lastStatus === 'error' ? [{ portfolioId: id, kind: 'alert', title: `Job failed: ${j.name}`, severity: 'alert' }] : [];
  return {
    id,
    name: j.name,
    group: j.group!,
    source: 'cron',
    status,
    headline: j.enabled ? `${j.schedule || 'scheduled'} · ${j.profile}` : `paused · ${j.profile}`,
    metrics: [
      { label: 'Last run', value: day(j.lastRunAt) },
      { label: 'Next run', value: j.enabled ? day(j.nextRunAt) : '—' },
    ],
    needsYou,
    updatedAt: now,
  };
}

const PROVIDER_NAMES: Record<string, string> = { 'openai-codex': 'Codex', anthropic: 'Claude', openrouter: 'OpenRouter' };
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const channelLabel = (n: string) => (n === 'telegram' ? 'Telegram' : n.replace(/:telegram$/, ' Telegram').split(' ').map(cap).join(' '));
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

/** Why Atlas is not green, worst first. Gateway/channel problems are alerts; failing jobs and busy limits warn. */
export function assessAtlas(a: Omit<AgentStatus, 'status' | 'reasons'>, shown: string[], limits: ProviderLimit[] = []): { status: Status; reasons: Reason[] } {
  const reasons: Reason[] = [];
  if (a.gateway.state !== 'running') {
    // A restart passes through these states for a few seconds; anything else means it is down.
    const transient = ['starting', 'restarting', 'draining', 'stopping'].includes(a.gateway.state);
    reasons.push({ severity: transient ? 'warn' : 'alert', text: `Atlas gateway is ${a.gateway.state}` });
  } else if ((a.gateway.ageSeconds ?? Infinity) > STALE_SECONDS) {
    reasons.push({ severity: 'alert', text: 'Atlas gateway heartbeat is stale' });
  }
  for (const p of a.platforms.filter((x) => shown.includes(x.name) && x.state !== 'connected')) {
    // The main Telegram bot is Atlas itself; the others (coding, diane) are secondary.
    reasons.push({ severity: p.name === 'telegram' ? 'alert' : 'warn', text: `${channelLabel(p.name)} is ${p.state}` });
  }
  for (const l of limits) {
    for (const w of l.windows) {
      if (w.usedPercent < 85) continue;
      const name = PROVIDER_NAMES[l.provider] ?? l.provider;
      const resets = w.resetsAt ? ` — resets ${day(w.resetsAt)}` : '';
      reasons.push({ severity: w.usedPercent >= 100 ? 'alert' : 'warn', text: `${name} ${w.label.toLowerCase()} limit ${Math.round(w.usedPercent)}% used${resets}` });
    }
  }
  const failing = a.jobs.filter((j) => j.enabled && j.lastStatus === 'error').length;
  if (failing) reasons.push({ severity: 'warn', text: `${failing} scheduled job${failing === 1 ? '' : 's'} failing` });
  reasons.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'alert' ? -1 : 1));
  const status: Status = reasons.some((r) => r.severity === 'alert') ? 'alert' : reasons.length ? 'warn' : 'ok';
  return { status, reasons };
}

/** Re-assess once the provider limits are known (they come from the usage source). */
export function withLimits(a: AgentStatus, shown: string[], limits: ProviderLimit[]): AgentStatus {
  return { ...a, ...assessAtlas(a, shown, limits) };
}

/** Needs-you items about Atlas itself. Failing jobs without a section are only visible here. */
export function atlasNeeds(a: AgentStatus): NeedsYou[] {
  const out: NeedsYou[] = a.reasons
    .filter((r) => r.severity === 'alert')
    .map((r) => ({ portfolioId: 'atlas', kind: 'alert' as const, title: r.text, severity: 'alert' as const }));
  for (const j of a.jobs) {
    if (j.enabled && j.lastStatus === 'error' && !j.group) {
      out.push({ portfolioId: 'atlas', kind: 'alert', title: `Job failed: ${j.name}`, severity: 'warn' });
    }
  }
  return out;
}

export function atlasSource(opts: Opts): Source {
  const now = opts.now ?? (() => new Date());
  const hasCommand = opts.hasCommand ?? onPath;

  return async () => {
    const errors: string[] = [];
    const t = now();

    let gs: any = {};
    try {
      gs = await readJson(join(opts.home, 'gateway_state.json'));
    } catch (e) {
      errors.push(`atlas: cannot read gateway state (${(e as Error).message})`);
    }
    const updatedAt: string | null = gs.updated_at ?? null;
    const alive = pidAlive(gs.pid);
    const state = !gs.gateway_state ? 'unknown' : gs.gateway_state === 'running' && !alive ? 'dead' : String(gs.gateway_state);

    let workersRunning = 0;
    try {
      const boards: Array<{ counts?: Record<string, number> }> = JSON.parse(await opts.run(['kanban', 'boards', 'list', '--json']));
      workersRunning = boards.reduce((n, b) => n + (b.counts?.running ?? 0), 0);
    } catch (e) {
      errors.push(`atlas: cannot read kanban (${(e as Error).message})`);
    }

    const jobs = await loadJobs(opts.home, opts.layout.cron);
    const lanes = await Promise.all(opts.layout.lanes.map(async (name) => ({ name, available: await hasCommand(name) })));

    const shown = opts.layout.channels?.length ? opts.layout.channels : Object.keys(gs.platforms ?? {});
    const base: Omit<AgentStatus, 'status' | 'reasons'> = {
      name: 'Atlas',
      gateway: {
        state,
        updatedAt,
        ageSeconds: updatedAt ? Math.max(0, Math.round((t.getTime() - Date.parse(updatedAt)) / 1000)) : null,
        activeAgents: Number(gs.active_agents ?? 0),
      },
      // Only the channels you care about (config/cockpit.json `channels`); others count nowhere.
      // A configured channel the gateway does not report is down, so it still gets a (red) chip.
      platforms: shown.map((name) => {
        const p = gs.platforms?.[name];
        // error_message is short gateway text ("failed to reconnect"); capped, no message content involved.
        return { name, state: String(p?.state ?? 'not running'), since: p?.updated_at ?? null, error: p?.error_message ? String(p.error_message).slice(0, 120) : null };
      }),
      profiles: Array.isArray(gs.served_profiles) ? gs.served_profiles.map(String) : [],
      workersRunning,
      jobs,
      lanes,
    };
    const atlas: AgentStatus = { ...base, ...assessAtlas(base, shown) };
    // Paused jobs stay in Atlas' job list but don't take up a card in their section.
    const cards = jobs.filter((j) => j.group && j.enabled).map((j) => jobCard(j, t.toISOString()));
    return { cards, errors, atlas };
  };
}
