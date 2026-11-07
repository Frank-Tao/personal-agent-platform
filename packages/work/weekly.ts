import { spawnSync } from 'node:child_process';
import { applyDigest, planDigest, readProposals } from './digest.ts';
import type { FeedbackOpts } from './feedback.ts';

// Weekly job: run the digest, then say in ONE line that proposals are waiting.
// Dry run unless enabled (FEEDBACK_WEEKLY=1 and --apply). Telegram goes only to TELEGRAM_CHAT_ID from infra/env; no chat id, no send.

export interface WeeklyResult { pending: number; line: string | null; sent: boolean; note: string; wrote: boolean; }
export type Send = (text: string) => void;

export function weeklyLine(pending: { title: string }[]): string | null {
  if (!pending.length) return null;
  const n = pending.length;
  const top = pending[0].title.replace(/\s+/g, ' ').replace(/["\\]/g, '').slice(0, 60);
  return `Cockpit: ${n} feedback proposal${n === 1 ? '' : 's'} waiting for your decision (top: "${top}"). Open Cockpit > Feedback.`;
}

export function telegramSend(env: Record<string, string | undefined>): Send | null {
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return null;
  return (text) => {
    // the token goes to the HTTP client on stdin, not argv, so it never shows in `ps`
    const cfg = `url = "https://api.telegram.org/bot${token}/sendMessage"\ndata-urlencode = "chat_id=${chat}"\ndata-urlencode = "text=${text.replace(/["\\]/g, '')}"\n`;
    const r = spawnSync('curl', ['-sS', '--fail', '--max-time', '20', '-K', '-'], { input: cfg, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`telegram send failed: ${(r.stderr || '').split(token).join('***').trim()}`);
  };
}

export function runWeekly(opts: FeedbackOpts & { enabled: boolean; send?: Send | null }): WeeklyResult {
  const r = planDigest(opts);
  const wrote = opts.enabled && (r.proposals.length > 0 || r.itemUpdates.length > 0);
  if (wrote) applyDigest(r, opts);
  // pending = stored pending proposals, overlaid with what this run would write
  const m = new Map(readProposals(opts.dir ?? '').map((p) => [p.id, p]));
  for (const p of r.proposals) m.set(p.id, p);
  const pending = [...m.values()].filter((p) => p.status === 'pending').sort((a, b) => b.score - a.score);
  const line = weeklyLine(pending);
  if (!line) return { pending: 0, line: null, sent: false, note: 'no proposals waiting; nothing to send', wrote };
  if (!opts.enabled) return { pending: pending.length, line, sent: false, note: 'dry run: would send the line above', wrote };
  if (!opts.send) return { pending: pending.length, line, sent: false, note: 'enabled, but TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set: not sent', wrote };
  opts.send(line);
  return { pending: pending.length, line, sent: true, note: 'sent to Telegram', wrote };
}
