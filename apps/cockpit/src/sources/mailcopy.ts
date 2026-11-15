import { readFile } from 'node:fs/promises';
import type { NeedsYou, Source } from '../types.ts';

// Email copies of Hermes job messages (work mailcopy, run by the work-watch job) leave data/mailcopy-status.json after every pass.
// A copy that cannot be sent, or a pass that stopped running, is shown in Needs-you. No file = the feature is not set up: nothing to say.

export const STALE_MINUTES = 60;
export interface MailcopyStatus { at: string; sent: number; failed: number; pending: number; unmapped?: string[]; lastError?: string | null }

export function mailcopyNeeds(s: MailcopyStatus | null, now = Date.now()): NeedsYou[] {
  if (!s) return [];
  const item = (title: string): NeedsYou => ({ portfolioId: 'atlas', kind: 'alert', severity: 'warn', title });
  const out: NeedsYou[] = [];
  const age = (now - Date.parse(s.at)) / 60_000;
  if (Number.isFinite(age) && age > STALE_MINUTES) out.push(item(`Email copies of job messages have not run for ${Math.round(age)} minutes (the work-watch job: launchctl list | grep work-watch)`));
  const n = s.failed || s.pending;
  if (n > 0) out.push(item(`${n} email ${n === 1 ? 'copy' : 'copies'} of Hermes job messages could not be sent${s.lastError ? `: ${s.lastError}` : ''}`));
  if (s.unmapped?.length) out.push(item(`Job messages go to a Telegram chat with no email address mapped: ${s.unmapped.slice(0, 2).join('; ')} (config/mailcopy.json in the data folder)`));
  return out;
}

export function mailcopySource(statusPath: string): Source {
  return async () => {
    let s: MailcopyStatus | null = null;
    try { s = JSON.parse(await readFile(statusPath, 'utf8')) as MailcopyStatus; } catch { /* not set up */ }
    return { cards: [], errors: [], needs: mailcopyNeeds(s) };
  };
}
