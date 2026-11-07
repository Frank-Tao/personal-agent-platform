export type Status = 'ok' | 'warn' | 'alert' | 'unknown';

/** Cockpit sections (portfolios), in display order. Which card lands where is set in config/cockpit.json. */
export const GROUPS = [
  { id: 'ai-thrival', name: 'AI Thrival', blurb: 'Content & brand: iOS apps, Udemy courses',
    hint: 'Board <code>ai-thrival</code>; or a <code>data/portfolio/*.json</code> card with <code>"group": "ai-thrival"</code>.' },
  { id: 'micropace', name: 'MicroPace', blurb: 'Greenfield projects, not yet ready for consumers',
    hint: 'Board <code>micropace-labs</code>; new boards land here unless <code>config/cockpit.json</code> says otherwise.' },
  { id: 'investments', name: 'Investments', blurb: 'Research and monitoring only, never trades',
    hint: 'Board <code>investments</code>, or <code>data/portfolio/investments.json</code> with <code>"group": "investments"</code>.' },
  { id: 'research', name: 'Research', blurb: 'Learning and recurring analyses',
    hint: 'Scheduled jobs matching a <code>cron</code> rule in <code>config/cockpit.json</code>, or a <code>research</code> board.' },
  { id: 'family', name: 'Family', blurb: 'Household, family and personal finance summaries',
    hint: 'Board <code>family</code>; household finance summaries from the private pipeline (<code>~/PrivateSummaries</code>, local model only) also land here.' },
] as const;
export type GroupId = (typeof GROUPS)[number]['id'];
export const DEFAULT_GROUP: GroupId = 'micropace';

export interface Metric {
  label: string;
  value: string;
  trend?: 'up' | 'down' | 'flat';
}

export interface NeedsYou {
  portfolioId: string;
  kind: 'approval' | 'blocker' | 'alert' | 'deadline' | 'staffing';
  title: string;
  severity: 'info' | 'warn' | 'alert';
  dueAt?: string;
  /** The kanban task this item is about (staffing items), so the UI can offer actions on it. */
  task?: { id: string; board: string; portfolio: string };
}

export interface Spend {
  spentCents: number;
  budgetCents: number;
}

export interface RunDay {
  date: string;
  succeeded: number;
  failed: number;
  total: number;
}

export interface TaskCounts {
  running: number;
  ready: number;
  review: number;
  blocked: number;
  done: number;
}

export interface PortfolioCard {
  id: string;
  name: string;
  group: GroupId;
  source: 'hermes' | 'cron' | 'private' | 'manual' | 'demo';
  status: Status;
  headline: string;
  metrics: Metric[];
  agents?: { active: number; running: number; paused: number; error: number };
  tasks?: { open: number; inProgress: number; blocked: number; done: number };
  /** Kanban boards: tasks nobody owns yet (capped), for the staffing check. */
  /** Open board tasks that carry no [work:<project>] marker, i.e. belong to no project. */
  strays?: number;
  unassigned?: Array<{ id: string; title: string; body: string; status: string }>;
  /** Kanban boards: task counts per assignee (Hermes profile name; 'unassigned' when nobody owns it). */
  team?: Array<{ assignee: string } & TaskCounts>;
  spend?: Spend;
  /** What this portfolio earned this month (from a manual KPI file); absent = not connected. */
  earnings?: { monthCents: number };
  runs?: RunDay[];
  needsYou: NeedsYou[];
  updatedAt: string;
}

/** An agent = a Hermes profile, as listed in config/agents.json and as Hermes actually has it. */
export interface AgentInfo {
  id: string;
  profile: string;
  name: string;
  role: string;
  emoji: string | null;
  division: string | null;
  personaSlug: string | null;
  /** active = the Hermes profile exists; proposed = in the roster, not created yet; unlisted = a profile the roster doesn't know. */
  state: 'active' | 'proposed' | 'unlisted';
  managed: boolean;
  status: Status;
  lanes: string[];
  model: string | null;
  provider: string | null;
  /** Portfolio ids this agent serves ('*' already expanded). */
  portfolios: string[];
  allPortfolios: boolean;
  tokens7d: number;
  sessions7d: number;
  lastAt: string | null;
  tasks: TaskCounts;
  byPortfolio: Record<string, TaskCounts>;
}

/** A scheduled Hermes job (cron), as Atlas runs it. */
export interface Job {
  name: string;
  profile: string;
  group?: GroupId;
  enabled: boolean;
  lastStatus: 'ok' | 'error' | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  schedule: string;
}

/** Why a status is not green; `alert` reasons also become Needs-you items. */
export interface Reason {
  severity: 'warn' | 'alert';
  text: string;
}

/** Health of Atlas itself: the Hermes gateway, its chat channels, workers and jobs. */
export interface AgentStatus {
  name: string;
  status: Status;
  reasons: Reason[];
  gateway: { state: string; updatedAt: string | null; ageSeconds: number | null; activeAgents: number };
  platforms: Array<{ name: string; state: string; since: string | null; error: string | null }>;
  profiles: string[];
  workersRunning: number;
  jobs: Job[];
  lanes: Array<{ name: string; available: boolean }>;
}

/** A worker lane (claude / codex / opencode-zen / openrouter / openai / ollama) as Cockpit can verify it. */
export interface LaneInfo {
  name: string;
  /** cli = a subscription CLI, api = a pay-per-token API reached through the opencode CLI, local = Ollama. */
  kind: 'cli' | 'api' | 'local';
  status: Status;
  installed: boolean;
  /** ok = signed in / key present, no = signed out, none = never set up, unknown = the CLI cannot say. */
  login: 'ok' | 'no' | 'none' | 'unknown';
  plan: string | null;
  detail: string;
  limits: Array<{ label: string; usedPercent: number; resets: string | null }>;
  /** Where the limits came from, so the UI can say how far to trust them. */
  limitsSource: string | null;
  /** The model this lane runs by default (lanes/models.conf), the one in memory now (ollama), the last one used. */
  model: string | null;
  modelsNow: string[];
  lastModel: string | null;
  /** Spend the lane's own CLI has recorded over the last 30 days (opencode lanes). */
  spend: { costUsd: number; messages: number } | null;
  runs: { total: number; failed: number; lastAt: string | null; lastStatus: 'ok' | 'failed' | null; lastNote: string | null };
}

/** Token buckets: chat = Telegram/WhatsApp/Discord/API, jobs = scheduled runs, other = CLI/one-shot. */
export type Bucket = 'chat' | 'jobs' | 'other';

export interface UsageDay {
  date: string;
  chat: number;
  jobs: number;
  other: number;
  sessions: number;
  /** Tokens that day by channel (session source) and by agent (Hermes profile). */
  bySource: Record<string, number>;
  byProfile: Record<string, number>;
  /** Tokens that day by portfolio and by project (id); work not tied to a project is under NO_PROJECT. */
  byPortfolio: Record<string, number>;
  byProject: Record<string, number>;
}

export interface UsageTotals {
  tokens: number;
  sessions: number;
  costUsd: number;
}

export interface ProviderLimit {
  provider: string;
  plan: string | null;
  windows: Array<{ label: string; usedPercent: number; resetsAt: string | null }>;
}

/** Atlas' traffic and spend, read from Hermes' session ledger (tokens = input + output). */
/** Key for sessions that belong to no project: Atlas chat, scheduled jobs, one-off CLI use. */
export const NO_PROJECT = '_none';

export interface UsageSlice { id: string; portfolio: string | null; tokens: number; sessions: number; costUsd: number }

export interface UsageStats {
  /** Last 30 days, biggest first. */
  byPortfolio: UsageSlice[];
  byProject: UsageSlice[];
  today: UsageTotals;
  week: UsageTotals;
  month: UsageTotals;
  days: UsageDay[];
  byModel: Array<{ model: string; billing: string; sessions: number; tokens: number; costUsd: number }>;
  lastActivityAt: string | null;
  /** Last 7 days per agent + channel, for channel hover details. */
  channels: Array<{ profile: string; source: string; sessions: number; tokens: number; lastAt: string | null }>;
  recent: Array<{ at: string; source: string; profile: string; model: string; tokens: number }>;
  limits: ProviderLimit[];
}

/** The staffing check for one unassigned task (a keyword heuristic; Atlas applies the real judgement). */
export interface StaffingItem {
  taskId: string;
  board: string;
  portfolio: string;
  title: string;
  status: string;
  result: import('../../../packages/roster/staffing.ts').StaffingResult;
}

export interface Rollup {
  generatedAt: string;
  atlas?: AgentStatus;
  usage?: UsageStats;
  lanes: LaneInfo[];
  agents: AgentInfo[];
  staffing: StaffingItem[];
  earned: { monthCents: number; sources: number };
  ui: { channels: string[]; lanes: string[]; dashboardUrl: string; links?: Array<{ name: string; url: string; group?: string; note?: string }>; writeToken: boolean; groups: ReadonlyArray<{ id: string; name: string; blurb: string; hint: string }> };
  portfolios: PortfolioCard[];
  needsYou: NeedsYou[];
  spend: Spend & { utilizationPercent: number };
  runs: RunDay[];
  errors: string[];
}

/** A source returns cards; it must never throw for a single bad portfolio — use `errors`. */
export interface SourceResult {
  cards: PortfolioCard[];
  errors: string[];
  atlas?: AgentStatus;
  usage?: UsageStats;
  lanes?: LaneInfo[];
  /** Roster agents as Hermes has them; the rollup adds usage and task counts. */
  agents?: AgentInfo[];
  /** Extra Needs-you items (the work model: charters to approve, paused projects, held outbox items). */
  needs?: NeedsYou[];
}

export type Source = () => Promise<SourceResult>;
