import { listHeld, readLog } from '../../../../packages/mail/mail.ts';
import type { NeedsYou, Source } from '../types.ts';

// Email an agent wanted to send but that waits for a person (work mail send held it): one Needs-you item each, with Send / Deny in Cockpit.
// A send that failed in the last day is shown too.
export function mailSource(data: string, now = () => Date.now()): Source {
  return async () => {
    const needs: NeedsYou[] = listHeld(data).map((m) => ({
      portfolioId: 'atlas', kind: 'approval', severity: 'warn', act: { kind: 'mail' as const, id: m.id },
      title: `Send email from ${m.by}${m.project ? ` (${m.project})` : ''} to ${m.to.join(', ')}: "${m.subject}"? Held because ${m.reasons.join('; ')}`,
      mail: { id: m.id, to: m.to, subject: m.subject, body: m.body.slice(0, 4000), by: m.by, reasons: m.reasons },
    }));
    const day = now() - 86_400_000;
    const failed = readLog(data).filter((e) => e.status === 'failed' && Date.parse(e.at) >= day);
    if (failed.length) needs.push({ portfolioId: 'atlas', kind: 'alert', severity: 'warn', title: `${failed.length} agent email${failed.length === 1 ? '' : 's'} could not be sent today: ${failed[failed.length - 1].reason ?? 'send failed'}` });
    return { cards: [], errors: [], needs };
  };
}
