import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { NeedsYou, Source } from '../types.ts';

// Prod updates itself (infra/bin/deploy.sh): a launchd job checks GitHub every few minutes, tests the new main in a scratch copy and only
// then switches prod over and restarts it. The script leaves two files per target in the data folder:
//   deploy-status-<target>.json     the last deploy: ok or failed, from which commit to which, and why
//   deploy-heartbeat-<target>       touched on every check, so "the checker stopped running" is visible too

export const TARGETS = ['platform', 'utility-portal'] as const;
export const HEARTBEAT_STALE_MINUTES = 20;

export interface DeployStatus { target: string; at: string; ok: boolean; from?: string; to?: string; message?: string; failedSha?: string | null }

export function deployNeeds(target: string, status: DeployStatus | null, heartbeatAgeMin: number | null): NeedsYou[] {
  const out: NeedsYou[] = [];
  const item = (title: string, severity: NeedsYou['severity'] = 'warn'): void => { out.push({ portfolioId: 'atlas', kind: 'alert', severity, title }); };
  if (status && !status.ok) {
    item(`Deploy of ${target} ${status.to ?? ''} failed: ${status.message ?? 'see ~/Library/Logs/pap/deploy.log'}. Prod is still running ${status.from ?? 'the previous version'}. Fix it on a branch and merge again, or run infra/bin/deploy.sh ${target} --force`.replace(/\s+/g, ' '), 'alert');
  }
  if (heartbeatAgeMin === null) item(`Auto-deploy has never run for ${target}: install it with infra/bin/install-launchd.sh --apply deploy`);
  else if (heartbeatAgeMin > HEARTBEAT_STALE_MINUTES) item(`Auto-deploy has not checked ${target} for ${Math.round(heartbeatAgeMin)} minutes (launchctl list | grep pap.deploy; log ~/Library/Logs/pap/deploy.log)`);
  return out;
}

export function deploySource(dataDir: string, targets: readonly string[] = TARGETS, now: () => number = Date.now): Source {
  return async () => {
    const needs: NeedsYou[] = [];
    for (const t of targets) {
      let status: DeployStatus | null = null;
      try { status = JSON.parse(await readFile(join(dataDir, `deploy-status-${t}.json`), 'utf8')) as DeployStatus; } catch { /* none yet */ }
      let age: number | null = null;
      try { age = (now() - (await stat(join(dataDir, `deploy-heartbeat-${t}`))).mtimeMs) / 60_000; } catch { /* never */ }
      needs.push(...deployNeeds(t, status, age));
    }
    return { cards: [], errors: [], needs };
  };
}
