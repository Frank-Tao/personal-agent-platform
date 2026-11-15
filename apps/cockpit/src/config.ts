import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadHermesApiKey } from './chat.ts';
import { DEFAULT_GROUP, GROUPS, type GroupId } from './types.ts';
import { DEFAULT_PEOPLE, type PersonConfig } from './identity.ts';
import { dataDir, liveConfig } from '../../../packages/paths/paths.ts';

const root = resolve(import.meta.dirname, '../../..');

/** config/cockpit.json: which section each board / cron job lands in. */
export interface Layout {
  boards: Record<string, GroupId>;
  /** Section for boards and manual cards that don't say (default: micropace). */
  defaultGroup: GroupId;
  cron: Array<{ match: string; group: GroupId }>;
  lanes: string[];
  /** Chat channels worth showing (gateway platform keys); empty = show all. */
  channels: string[];
  /** Hermes dashboard, linked from the header. `{host}` = the page's hostname (for browsers not on this Mac). */
  dashboardUrl: string;
  /** Other tools linked from the sidebar; each opens in a new tab. `{host}` = the page's hostname. */
  links: Array<{ name: string; url: string; group?: string; note?: string }>;
  /** The Utility Portal app: its tools are discovered from its home page and listed in the sidebar under `group`. Absent = off. */
  utilityPortal?: { url: string; publicUrl: string; group: string };
  /** Hostnames Cockpit may be reached by, besides loopback (e.g. the tailnet name). */
  allowedHosts: string[];
  /** People with their own view: their devices, known tailnet addresses and hidden portfolios. Unlisted tailnet devices are Frank. */
  people: PersonConfig[];
}

export interface Config {
  port: number;
  host: string;
  demo: boolean;
  refreshSeconds: number;
  dbPath: string;
  /** Hermes CLI; Cockpit reads the kanban boards through it (one board per portfolio). */
  hermesBin: string;
  /** Hermes home: gateway state and cron jobs are read from here, read-only. */
  hermesHome: string;
  layout: Layout;
  /** Hermes API server (chat with Atlas) and the key for it; the key stays on the server. */
  hermesApiUrl: string;
  hermesApiKey?: string;
  /** Optional shared secret required on writes (chat, tasks). */
  writeToken?: string;
  /** One JSON line per real lanes/lane.sh run. */
  lanesLedger: string;
  /** config/agents.json: the roster (agents, their personas, the portfolios they serve). */
  agentsRegistry: string;
  /** lanes/models.conf: default model per lane. */
  lanesModels: string;
  /** Output of the private pipeline — summaries only, PII-checked on read. */
  privateSummariesDir: string;
  /** Hand-maintained or exported KPI files (holdings, MRR, followers...). */
  manualKpiDir: string;
}

const isGroup = (g: unknown): g is GroupId => GROUPS.some((x) => x.id === g);

export function loadLayout(path: string): Layout {
  let raw: Partial<Layout> = {};
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    /* no layout file: everything defaults to work, jobs stay under Atlas */
  }
  return {
    boards: Object.fromEntries(Object.entries(raw.boards ?? {}).filter(([, g]) => isGroup(g))),
    defaultGroup: isGroup(raw.defaultGroup) ? raw.defaultGroup : DEFAULT_GROUP,
    cron: (raw.cron ?? []).filter((r) => r.match && isGroup(r.group)),
    lanes: raw.lanes ?? ['claude', 'codex', 'opencode-zen', 'openrouter', 'openai', 'ollama'],
    channels: raw.channels ?? [],
    dashboardUrl: raw.dashboardUrl ?? 'https://{host}:9443',
    links: (Array.isArray(raw.links) ? raw.links : []).filter((l) => l && typeof l.name === 'string' && typeof l.url === 'string' && /^https?:\/\//.test(l.url)).map((l) => ({ name: l.name, url: l.url, ...(typeof l.group === 'string' && l.group ? { group: l.group } : {}), ...(typeof l.note === 'string' && l.note ? { note: l.note } : {}) })),
    utilityPortal: raw.utilityPortal && typeof raw.utilityPortal.url === 'string' && /^https?:\/\//.test(raw.utilityPortal.url)
      ? { url: raw.utilityPortal.url, publicUrl: typeof raw.utilityPortal.publicUrl === 'string' ? raw.utilityPortal.publicUrl : raw.utilityPortal.url, group: typeof raw.utilityPortal.group === 'string' && raw.utilityPortal.group ? raw.utilityPortal.group : 'Utility Portal' }
      : undefined,
    allowedHosts: Array.isArray(raw.allowedHosts) ? raw.allowedHosts.map(String) : [],
    people: loadPeople((raw as { people?: unknown }).people),
  };
}

/** `people` from the layout file. An entry that is not well formed is dropped whole (never half-applied); a hidden portfolio must be a
 *  real one, so a typo cannot silently show someone a portfolio they should not see: that entry is dropped and the default list is used. */
export function loadPeople(raw: unknown): PersonConfig[] {
  if (!Array.isArray(raw)) return [...DEFAULT_PEOPLE];
  const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim()) ? v.map((x) => String(x).trim()) : null);
  const out: PersonConfig[] = [];
  for (const e of raw as Array<Record<string, unknown>>) {
    const devices = strs(e?.devices), addresses = strs(e?.addresses ?? []), hide = strs(e?.hide ?? []);
    const ok = e && typeof e.name === 'string' && /^[\p{L}][\p{L} .'-]{0,30}$/u.test(e.name) && devices?.length && addresses && hide && hide.every(isGroup) && devices.every((d) => /^[a-z0-9][a-z0-9-]{0,62}$/i.test(d));
    if (!ok) { console.error(`config/cockpit.json: a people entry is not valid (${JSON.stringify(e)?.slice(0, 120)}); using the built-in list`); return [...DEFAULT_PEOPLE]; }
    out.push({ name: e.name as string, devices: devices!.map((d) => d.toLowerCase()), addresses: addresses!, hide: hide! });
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.COCKPIT_PORT ?? 3200),
    // Loopback by default; expose to the tailnet with `tailscale serve`, never 0.0.0.0.
    host: env.COCKPIT_HOST ?? '127.0.0.1',
    demo: env.COCKPIT_DEMO === '1',
    refreshSeconds: Number(env.COCKPIT_REFRESH_SECONDS ?? 120),
    dbPath: env.COCKPIT_DB ?? join(dataDir(env), 'cockpit.sqlite'),
    hermesBin: env.HERMES_BIN ?? join(homedir(), '.local', 'bin', 'hermes'),
    hermesHome: env.HERMES_HOME ?? join(homedir(), '.hermes'),
    lanesLedger: env.LANE_LEDGER ?? join(dataDir(env), 'lanes.jsonl'),
    lanesModels: env.LANE_MODELS ?? join(root, 'lanes', 'models.conf'),
    agentsRegistry: env.AGENTS_REGISTRY ?? liveConfig('agents.json', env),
    hermesApiUrl: env.HERMES_API_URL ?? 'http://127.0.0.1:8642',
    hermesApiKey: loadHermesApiKey(env, env.HERMES_HOME ?? join(homedir(), '.hermes')),
    writeToken: env.COCKPIT_TOKEN || undefined,
    layout: loadLayout(env.COCKPIT_LAYOUT ?? join(root, 'config', 'cockpit.json')),
    privateSummariesDir: env.PRIVATE_SUMMARIES_DIR ?? join(homedir(), 'PrivateSummaries'),
    manualKpiDir: env.MANUAL_KPI_DIR ?? join(dataDir(env), 'portfolio'),
  };
}
