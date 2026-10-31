export type Status = 'ok' | 'warn' | 'alert' | 'unknown';

export interface Metric {
  label: string;
  value: string;
  trend?: 'up' | 'down' | 'flat';
}

export interface NeedsYou {
  portfolioId: string;
  kind: 'approval' | 'blocker' | 'alert' | 'deadline';
  title: string;
  severity: 'info' | 'warn' | 'alert';
  dueAt?: string;
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

export interface PortfolioCard {
  id: string;
  name: string;
  source: 'paperclip' | 'private' | 'manual' | 'demo';
  status: Status;
  headline: string;
  metrics: Metric[];
  agents?: { active: number; running: number; paused: number; error: number };
  tasks?: { open: number; inProgress: number; blocked: number; done: number };
  spend?: Spend;
  runs?: RunDay[];
  needsYou: NeedsYou[];
  updatedAt: string;
}

export interface Rollup {
  generatedAt: string;
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
}

export type Source = () => Promise<SourceResult>;
