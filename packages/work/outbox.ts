import type { DelegateKind, OutwardKind, Project } from './model.ts';

// The outbox: every outward action (publish, deploy, spend) is submitted here instead of being done by an agent.
// `decide` is the guardrail, in code, not in a prompt: it reads the approved charter and says release, hold or deny.

export type OutboxStatus = 'ready' | 'held' | 'denied' | 'done' | 'failed';

/** merge = a pull request into main (its CI must be green); access = a non-secret repository setting, as `github-variable:NAME`. */
export type OutboxKind = OutwardKind | 'merge' | 'access';
export const OUTBOX_KINDS: OutboxKind[] = ['deploy', 'publish', 'spend', 'merge', 'access'];

export interface OutboxItem {
  id: string;
  project: string;
  portfolio: string;
  kind: OutboxKind;
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
  /** access: the value to set. */
  value?: string | null;
  /** Who asked (an agent's profile, or a person). */
  submitted_by?: string | null;
  /** The review task made for the approver agent. */
  review_task?: string | null;
  decided_at?: string | null;
  why?: string | null;
}

/** Is this kind handed to the project's approver agent? */
export const delegated = (p: Project, kind: OutboxKind): boolean => !!p.approver && (p.delegate ?? []).includes(kind as DelegateKind);
export const ACCESS_TARGET = /^github-variable:[A-Z][A-Z0-9_]{1,60}$/;

export interface Decision { status: 'ready' | 'held' | 'denied'; reason: string }

export const OUTBOX_ID = /^[a-z0-9][a-z0-9-]{3,63}$/;

/** `sentThisWeek`: items of the same kind+project that reached `done` in the last 7 days (for publish rate limits). */
export function decide(p: Project, item: Pick<OutboxItem, 'kind' | 'target' | 'usd'>, sentThisWeek = 0): Decision {
  const o = p.charter.outward;
  const deny = (reason: string): Decision => ({ status: 'denied', reason });
  if (!['active', 'review'].includes(p.status) || (p.status === 'review' && !['merge', 'access'].includes(item.kind))) return deny(`project is ${p.status}, not active`);
  const waits = (what: string): Decision => ({ status: 'held', reason: delegated(p, item.kind) ? `${what}: waits for ${p.approver}'s review (delegated by Frank)` : `${what}: waits for your yes` });
  if (item.kind === 'merge') {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(item.target)) return deny('target must be a GitHub pull request URL');
    return waits('a merge into main');
  }
  if (item.kind === 'access') {
    if (/secret/i.test(item.target)) return deny('secrets are set by Frank only, never through the outbox');
    if (!ACCESS_TARGET.test(item.target)) return deny('target must be github-variable:NAME (a non-secret repository variable)');
    return waits(`setting ${item.target.slice(16)}`);
  }
  if (item.kind === 'deploy') {
    if (!o.deploy.allowed) return delegated(p, 'deploy') ? waits(`a deploy to ${item.target}`) : deny('the charter does not allow deploys');
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
