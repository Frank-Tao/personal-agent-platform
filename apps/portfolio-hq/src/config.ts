import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');

export interface Config {
  port: number;
  host: string;
  demo: boolean;
  refreshSeconds: number;
  dbPath: string;
  paperclipUrl: string;
  paperclipToken?: string;
  /** Output of the private pipeline — summaries only, PII-checked on read. */
  privateSummariesDir: string;
  /** Hand-maintained or exported KPI files (holdings, MRR, followers...). */
  manualKpiDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.HQ_PORT ?? 3200),
    // Loopback by default; expose to the tailnet with `tailscale serve`, never 0.0.0.0.
    host: env.HQ_HOST ?? '127.0.0.1',
    demo: env.HQ_DEMO === '1',
    refreshSeconds: Number(env.HQ_REFRESH_SECONDS ?? 300),
    dbPath: env.HQ_DB ?? join(root, 'data', 'hq.sqlite'),
    paperclipUrl: (env.PAPERCLIP_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, ''),
    paperclipToken: env.PAPERCLIP_API_KEY || undefined,
    privateSummariesDir: env.PRIVATE_SUMMARIES_DIR ?? join(homedir(), 'PrivateSummaries'),
    manualKpiDir: env.MANUAL_KPI_DIR ?? join(root, 'data', 'portfolio'),
  };
}
