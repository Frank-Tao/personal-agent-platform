import type { OutwardKind, Project } from './model.ts';

// The outbox: every outward action (publish, deploy, spend) is submitted here instead of being done by an agent.
// `decide` is the guardrail, in code, not in a prompt: it reads the approved charter and says release, hold or deny.

export type OutboxStatus = 'ready' | 'held' | 'denied' | 'done' | 'failed';

export interface OutboxItem {
  id: string;
  project: string;
  portfolio: string;
  kind: OutwardKind;
  /** Deploy target host, publish channel, or spend payee. */
  target: string;
  summary: string;
  /** Publish: path of the drafted content. */
  payload: string | null;
  usd: number;
  task: string | null;
  created: string;
  status: OutboxStatus;
  reason: string;
  /** Who moved it out of `held`/`ready`: "charter", or "human". */
  decided_by: string;
  result: string | null;
}

export interface Decision { status: 'ready' | 'held' | 'denied'; reason: string }

export const OUTBOX_ID = /^[a-z0-9][a-z0-9-]{3,63}$/;

/** `sentThisWeek`: items of the same kind+project that reached `done` in the last 7 days (for publish rate limits). */
export function decide(p: Project, item: Pick<OutboxItem, 'kind' | 'target' | 'usd'>, sentThisWeek = 0): Decision {
  const o = p.charter.outward;
  const deny = (reason: string): Decision => ({ status: 'denied', reason });
  if (p.status !== 'active') return deny(`project is ${p.status}, not active`);
  if (item.kind === 'deploy') {
    if (!o.deploy.allowed) return deny('the charter does not allow deploys');
    if (!o.deploy.targets.includes(item.target)) return deny(`"${item.target}" is not a charter deploy target (${o.deploy.targets.join(', ') || 'none'})`);
    return { status: 'ready', reason: `deploy to ${item.target} is in the charter` };
  }
  if (item.kind === 'spend') {
    if (!o.spend.allowed) return deny('the charter does not allow spending');
    if (item.usd > o.spend.max_usd) return { status: 'held', reason: `$${item.usd} is over the charter limit of $${o.spend.max_usd}; needs your yes` };
    return { status: 'held', reason: `spend of $${item.usd} is within the limit but spending always waits for a human release` };
  }
  // publish
  if (o.publish.allowed === 'no') return deny('the charter does not allow publishing');
  if (!o.publish.channels.includes(item.target)) return deny(`"${item.target}" is not an approved channel (${o.publish.channels.join(', ') || 'none'})`);
  if (o.publish.allowed === 'draft-only') return { status: 'held', reason: 'publishing is draft-only: a human releases it' };
  if (o.publish.max_per_week > 0 && sentThisWeek >= o.publish.max_per_week) return { status: 'held', reason: `already ${sentThisWeek} sent this week (limit ${o.publish.max_per_week})` };
  return { status: 'ready', reason: `auto-publish to ${item.target} is in the charter` };
}

export function newItemId(project: string, today: string, n: number): string {
  return `${project}-${today.replace(/-/g, '')}-${String(n).padStart(3, '0')}`.slice(0, 64);
}
