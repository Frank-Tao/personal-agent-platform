import { appendFileSync, closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { FeedbackError, feedbackPath, list, type FeedbackItem, type FeedbackOpts } from './feedback.ts';
import { proposalsPath, readProposals, type Proposal } from './digest.ts';

// Decisions on a proposal (docs/design/feedback-loop.md §7.1): approve, defer or reject. Conversion into tasks is a later step.

export const ACTIONS = ['approve', 'defer', 'reject'] as const;
export type Action = (typeof ACTIONS)[number];
export const DEFER_DAYS = 28, MAX_REASON = 500;
export interface Decision { action: Action; reason: string; by: string; time: string; until: string | null; }

/** Proposals as the Feedback view shows them: pending first (best score first), then the decided ones, newest first. */
export function listProposals(opts: FeedbackOpts = {}): Proposal[] {
  const dir = opts.dir ?? join(process.cwd(), 'data');
  const all = readProposals(dir);
  const at = (p: Proposal) => (p.decision as Decision | null)?.time ?? '';
  const pending = all.filter((p) => p.status === 'pending').sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const rest = all.filter((p) => p.status !== 'pending').sort((a, b) => at(b).localeCompare(at(a)));
  return [...pending, ...rest];
}
export const pendingCount = (opts: FeedbackOpts = {}): number => listProposals(opts).filter((p) => p.status === 'pending').length;

export function decide(input: { id: unknown; action: unknown; reason?: unknown; by?: unknown }, opts: FeedbackOpts = {}): Proposal {
  const dir = opts.dir ?? join(process.cwd(), 'data');
  const now = (opts.now ?? (() => new Date()))();
  const action = input.action as Action;
  if (!ACTIONS.includes(action)) throw new FeedbackError(400, `action must be one of ${ACTIONS.join(', ')}`);
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, MAX_REASON) : '';
  if (action !== 'approve' && !reason) throw new FeedbackError(400, `${action} needs a reason`);
  const p = readProposals(dir).find((x) => x.id === input.id);
  if (!p) throw new FeedbackError(404, 'no such proposal');
  if (p.status !== 'pending') throw new FeedbackError(409, `that proposal is already ${p.status}`);

  const decision: Decision = {
    action, reason, by: String(input.by ?? 'unknown').slice(0, 64), time: now.toISOString(),
    until: action === 'defer' ? new Date(now.getTime() + DEFER_DAYS * 86_400_000).toISOString().slice(0, 10) : null,
  };
  const status = { approve: 'approved', defer: 'deferred', reject: 'rejected' }[action] as Proposal['status'];
  const itemStatus = { approve: 'accepted', defer: 'deferred', reject: 'rejected' }[action] as FeedbackItem['status'];
  const next: Proposal = { ...p, status, decision };
  const members = new Set(p.items);
  const updates = list({ dir }).filter((i) => members.has(i.id)).map((i) => ({ ...i, status: itemStatus, proposal: p.id, note: reason || i.note }));

  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'feedback.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx'); } catch { throw new FeedbackError(409, 'feedback is being updated, try again in a moment'); }
  try {
    appendFileSync(proposalsPath(dir), JSON.stringify(next) + '\n');
    for (const i of updates) appendFileSync(feedbackPath(dir), JSON.stringify(i) + '\n');
  } finally { closeSync(fd); unlinkSync(lock); }
  return next;
}

/** Record that an approved proposal became a task (design §7.3). Idempotent: a proposal already converted is returned as is. */
export function markConverted(id: string, task: { project: string; key: string }, opts: FeedbackOpts = {}): Proposal {
  const dir = opts.dir ?? join(process.cwd(), 'data');
  const p = readProposals(dir).find((x) => x.id === id);
  if (!p) throw new FeedbackError(404, 'no such proposal');
  if (p.status === 'converted') return p;
  if (p.status !== 'approved') throw new FeedbackError(409, `that proposal is ${p.status}, not approved`);
  const next: Proposal = { ...p, status: 'converted', tasks: [...p.tasks, task] };
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'feedback.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx'); } catch { throw new FeedbackError(409, 'feedback is being updated, try again in a moment'); }
  try { appendFileSync(proposalsPath(dir), JSON.stringify(next) + '\n'); } finally { closeSync(fd); unlinkSync(lock); }
  return next;
}
