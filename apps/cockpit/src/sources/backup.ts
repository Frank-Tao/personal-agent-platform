import { readFile } from 'node:fs/promises';
import type { NeedsYou, Source } from '../types.ts';

// Is the nightly backup (infra/bin/backup.sh) actually running? It writes data/backup-status.json after every run. No file, an old
// file or a failed step becomes a Needs-you item: a backup that silently never ran is found the day it is needed.

export const STALE_HOURS = 36;

export interface BackupStatus { at: string; ok: boolean; dest?: string; steps?: Array<{ name: string; result: string; detail?: string }> }

export function backupNeeds(status: BackupStatus | null, now = Date.now()): NeedsYou[] {
  const item = (title: string, severity: NeedsYou['severity'] = 'warn'): NeedsYou[] => [{ portfolioId: 'atlas', kind: 'alert', severity, title }];
  if (!status) return item('Backups have never run: install the nightly job (infra/bin/install-launchd.sh --apply) or run infra/bin/backup.sh once');
  const age = (now - Date.parse(status.at)) / 3_600_000;
  if (!Number.isFinite(age)) return item('Backup status is unreadable: run infra/bin/backup.sh and check its output');
  const failed = (status.steps ?? []).filter((s) => s.result === 'failed');
  if (!status.ok || failed.length) return item(`Last backup failed: ${failed.map((s) => `${s.name} (${s.detail || 'no detail'})`).join('; ') || 'see ~/Library/Logs/pap/backup.log'}`, 'alert');
  if (age > STALE_HOURS) return item(`No backup for ${Math.round(age / 24)} day${Math.round(age / 24) === 1 ? '' : 's'}: the nightly job is not running (launchctl list | grep pap.backup)`);
  return [];
}

export function backupSource(statusPath: string): Source {
  return async () => {
    let status: BackupStatus | null = null;
    try { status = JSON.parse(await readFile(statusPath, 'utf8')) as BackupStatus; } catch { /* never ran, or half-written */ }
    return { cards: [], errors: [], needs: backupNeeds(status) };
  };
}
