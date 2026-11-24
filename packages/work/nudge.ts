// Keep tasks moving. Pure: the CLI does the actions. Run every ten minutes by launchd (with advance and watch), and on demand by the
// "Nudge now" button in Cockpit. It never does anything the dispatcher would not do, and it retries a blocked task at most once by itself:
// after that it climbs a ladder of agents before it is ever reported to the human (Needs you):
//   1. retry by the same agent (once, after 30 min)
//   2. triage: a task for the agent who delegated it (its creator, else the project's pm) to read what went wrong and either comment + unblock
//      (retry with better instructions), reassign it, or split it. Up to MAX_TRIAGES times.
//   3. stand-in: code picks another agent that is safe for the task (same portfolio, same kind of work, never a cloud lane for a local-only agent's task)
//   4. the human, with the whole history in the report.

export interface NudgeTask {
  id: string;
  status: string;
  /** Parent task ids with their status. */
  parents: Array<{ id: string; status: string }>;
  /** From `kanban show --json`. */
  events: Array<{ kind?: string; created_at?: number; payload?: { reason?: string; kind?: string; author?: string } | null }>;
  comments: Array<{ author?: string; body?: string; text?: string }>;
  assignee?: string | null;
  /** Who made the task (an agent id, `work`, `auto-decomposer`, a person). */
  createdBy?: string | null;
  /** Status of the triage tasks named in this task's `[auto-triage …]` comments, by id. Missing = not found. */
  triageStatus?: Record<string, string>;
  /** Status of the fix tasks named in this task's `[auto-fix …]` comments, by id. */
  fixStatus?: Record<string, string>;
}

export type NudgeAction =
  | { do: 'promote'; id: string; why: string }
  | { do: 'retry'; id: string; why: string; attempt: number }
  | { do: 'triage'; id: string; why: string; round: number }
  | { do: 'swap'; id: string; why: string }
  | { do: 'fix'; id: string; why: string; round: number }
  | { do: 'escalate'; id: string; why: string };

export const AUTO_RETRY_MARK = '[auto-retry';
export const MAX_AUTO_RETRIES = 1;
/** Failed runs of one task, all agents together, after which the agents stop trying and it waits for the human. */
export const MAX_FAILURES = 5;
const FAIL_KINDS = new Set(['crashed', 'spawn_failed', 'timed_out']);
/** Distinct failed runs in the task's events (one run can log several failure events). */
export function failedRuns(events: NudgeTask['events']): number {
  const ids = new Set<string>(); let anon = 0;
  for (const e of events as Array<{ kind?: string; run_id?: number | null }>) if (FAIL_KINDS.has(String(e.kind))) { if (e.run_id == null) anon++; else ids.add(String(e.run_id)); }
  return ids.size + anon;
}
export const BLOCKED_MINUTES = 30;
/** Block kinds a blind retry cannot clear: the delegator (or a different agent) has to answer, re-scope or change who does it. */
const HUMAN_KINDS = new Set(['capability', 'needs_input']);
export const TRIAGE_MARK = '[auto-triage';
export const NEEDS_HUMAN_MARK = '[needs-human]';
export const SWAP_MARK = '[auto-swap';
export const MAX_TRIAGES = 2;
/** A check (QA verify task) that blocked with a FAIL verdict is a product defect, not a stuck worker: the platform makes a fix task, the check waits for it
 *  and runs again. After this many fix rounds that still fail, or at once for a critical failure, it waits for the human. */
export const FIX_MARK = '[auto-fix';
export const MAX_FIXES = 2;
export const isVerdictFail = (reason: string): boolean => /\bFAIL(ED)?\b/.test(reason);
/** Failures an agent must not loop on: real personal data, secrets, money, deployment. A person looks at these first. */
export const CRITICAL_FAIL = /real (holdings|data|statements?|personal|private|financial)|private[- ]finance|credential|password|secret|payment|money[- ]movement|\bdeploy|production/i;
export const MAX_SWAPS = 1;
/** A triage task still in one of these states is being worked on: do not pile on. */
const LIVE = new Set(['todo', 'ready', 'running', 'review', 'triage']);

const retriesSoFar = (t: NudgeTask): number => t.comments.filter((c) => (c.body ?? c.text ?? '').includes(AUTO_RETRY_MARK)).length;

const marks = (t: NudgeTask, mark: string): string[] => t.comments.map((c) => c.body ?? c.text ?? '').filter((b) => b.includes(mark));
/** Agents already tried on this task, from the `[auto-swap from=a to=b]` comments plus the current assignee. */
export const triedAgents = (t: NudgeTask): Set<string> => new Set([...(t.assignee ? [t.assignee] : []), ...marks(t, SWAP_MARK).flatMap((b) => [...b.matchAll(/(?:from|to)=([\w-]+)/g)].map((m) => m[1]))]);

const LOCAL_LANES = new Set(['ollama']);
const isLocalOnly = (a: { lanes?: string[] }): boolean => !!a.lanes?.length && a.lanes.every((l) => LOCAL_LANES.has(l));
export interface Standin { id: string; state: string; portfolios: string[]; allPortfolios?: boolean; lanes?: string[]; engineering?: boolean }

/** A different agent that may safely take over, or null. Deterministic. Never Atlas, never someone already tried, never a stand-in that
 *  would move a local-only agent's work (finances, identity, health) onto a cloud lane. Same kind of work: engineering for engineering. */
export function pickStandin(current: string | null | undefined, portfolio: string, tried: ReadonlySet<string>, roster: readonly Standin[]): string | null {
  const cur = roster.find((a) => a.id === current);
  if (!cur) return null;                          // unknown current agent: we cannot tell what is safe
  const ok = roster.filter((a) =>
    a.state === 'active' && !tried.has(a.id) && a.id !== 'atlas' && a.id !== 'qa' && a.id !== 'pm' && a.id !== 'support'
    && (a.allPortfolios || a.portfolios.includes(portfolio))
    && isLocalOnly(a) === isLocalOnly(cur)
    && !!a.engineering === !!cur.engineering
    && (!(a.lanes?.length) || !(cur.lanes?.length) || a.lanes.some((l) => cur.lanes!.includes(l))));
  return ok.sort((a, b) => a.id.localeCompare(b.id))[0]?.id ?? null;
}

/** Who gets the triage task: the agent that created the stuck task, else the project's lead. Never the stuck agent itself. */
export function delegatorOf(t: NudgeTask, lead: string | null, agents: ReadonlySet<string>): string | null {
  const c = t.createdBy ?? '';
  if (c && agents.has(c) && c !== t.assignee && c !== 'atlas') return c;
  return lead && lead !== t.assignee ? lead : null;
}

export const REASSIGN_MARK = '[auto-reassign';
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
/** Hermes holds a ready task back ("respawn_guarded: active_pr") for 24 h after a PR URL is in a comment, so a worker is not started on top of
 *  an open PR. When that PR has since been merged or closed the guard only delays the next step: a reassign to the same agent is the handoff
 *  Hermes accepts. True when the task has been held back for this reason for a while. */
export function heldByPrGuard(t: NudgeTask, nowSec: number): { prs: string[] } | null {
  if (t.status !== 'ready' || t.comments.some((c) => (c.body ?? c.text ?? '').includes(REASSIGN_MARK))) return null;
  const guards = t.events.filter((e) => e.kind === 'respawn_guarded' && e.payload?.reason === 'active_pr');
  if (guards.length < 5 || nowSec - (guards.at(-1)?.created_at ?? 0) > 300) return null;     // still being held right now, for a while
  const prs = [...new Set(t.comments.flatMap((c) => (c.body ?? c.text ?? '').match(PR_URL) ?? []))];
  return prs.length ? { prs } : null;
}

/** What to do about one task, or null to leave it alone. */
export function nudgeTask(t: NudgeTask, nowSec: number, agents: ReadonlySet<string>, rungs: { delegator?: boolean; standin?: boolean; fix?: boolean } = {}): NudgeAction | null {
  if (t.status === 'todo' && t.parents.length > 0 && t.parents.every((p) => p.status === 'done')) {
    return { do: 'promote', id: t.id, why: 'every task it waits for is done' };
  }
  if (t.status !== 'blocked') return null;
  const blocks = t.events.filter((e) => e.kind === 'blocked' || e.kind === 'gave_up');
  const last = blocks.at(-1);
  const since = last?.created_at ?? 0;
  // A person reworded the task or commented after it blocked: run it again so the agent reads the new wording.
  const touched = t.events.some((e) => (e.created_at ?? 0) > since && (e.kind === 'edited' || (e.kind === 'commented' && e.payload?.author && !agents.has(e.payload.author) && e.payload.author !== 'work')));
  if (touched && retriesSoFar(t) < MAX_AUTO_RETRIES + 2) return { do: 'retry', id: t.id, why: 'it was edited or commented on after it blocked', attempt: retriesSoFar(t) + 1 };
  // A QA check that FAILED a real item is a defect to fix, not a worker to retry or triage: make a fix task, wait for it, run the check again.
  const reason = String(last?.payload?.reason ?? '');
  if (rungs.fix && isVerdictFail(reason)) {
    if (CRITICAL_FAIL.test(reason) || t.comments.some((c) => c.author && agents.has(c.author) && (c.body ?? c.text ?? '').includes(NEEDS_HUMAN_MARK))) return { do: 'escalate', id: t.id, why: `a critical failure waits for you: ${reason.slice(0, 200)}` };
    const fixIds = marks(t, FIX_MARK).map((b) => /(t_[0-9a-f]+)/.exec(b)?.[1]).filter((x): x is string => !!x);
    if (fixIds.some((id) => LIVE.has(t.fixStatus?.[id] ?? ''))) return null;
    if (fixIds.length >= MAX_FIXES) return { do: 'escalate', id: t.id, why: `still failing after ${fixIds.length} automatic fix${fixIds.length === 1 ? '' : 'es'}: ${reason.slice(0, 200)}` };
    return { do: 'fix', id: t.id, why: reason.slice(0, 300), round: fixIds.length + 1 };
  }
  // The hard stop: five failed runs and the agents have had their go. Wait for the human (who can still reword it, which re-runs it above).
  const failed = failedRuns(t.events);
  if (failed >= MAX_FAILURES) return { do: 'escalate', id: t.id, why: `failed ${failed} times (limit ${MAX_FAILURES}); agents stop here and it waits for you` };
  const kind = last?.payload?.kind;
  const ageMin = since ? (nowSec - since) / 60 : Infinity;
  const needsMoreThanRetry = !!(kind && HUMAN_KINDS.has(kind));
  // 1. Spawn failures and give-ups: one automatic retry after a pause.
  if (!needsMoreThanRetry && retriesSoFar(t) < MAX_AUTO_RETRIES) return ageMin >= BLOCKED_MINUTES ? { do: 'retry', id: t.id, why: `blocked for ${Math.round(ageMin)} min with no one touching it`, attempt: retriesSoFar(t) + 1 } : null;
  const what = needsMoreThanRetry ? `blocked (${kind}): ${(last?.payload?.reason ?? '').slice(0, 160)}` : `still blocked after ${retriesSoFar(t)} automatic retr${retriesSoFar(t) === 1 ? 'y' : 'ies'}`;
  // 2. A triage task is out with the delegator: wait for it. (A triage that finished or itself got stuck without fixing this one counts as spent.)
  const triageIds = marks(t, TRIAGE_MARK).map((b) => /(t_[0-9a-f]+)/.exec(b)?.[1]).filter((x): x is string => !!x);
  if (triageIds.some((id) => LIVE.has(t.triageStatus?.[id] ?? ''))) return null;
  // The delegator may say a person is genuinely needed (a secret, a payment, a decision only Frank can make): believe it, do not loop.
  if (t.comments.some((c) => c.author && agents.has(c.author) && (c.body ?? c.text ?? '').includes(NEEDS_HUMAN_MARK))) return { do: 'escalate', id: t.id, why: `an agent says a person is needed: ${what}` };
  const triages = marks(t, TRIAGE_MARK).length, swaps = marks(t, SWAP_MARK).length;
  // 3. The delegator first; then a different agent (once); then the delegator again with that history; only then the human.
  // A rung nobody can run (no delegator known, no safe stand-in) is skipped, not waited on.
  if (triages === 0 && rungs.delegator) return { do: 'triage', id: t.id, why: what, round: 1 };
  if (swaps < MAX_SWAPS && rungs.standin) return { do: 'swap', id: t.id, why: what };
  if (triages < MAX_TRIAGES && rungs.delegator) return { do: 'triage', id: t.id, why: what, round: triages + 1 };
  return { do: 'escalate', id: t.id, why: `${what}; tried ${retriesSoFar(t)} retr${retriesSoFar(t) === 1 ? 'y' : 'ies'}, ${triages} triage${triages === 1 ? '' : 's'}, ${swaps} stand-in${swaps === 1 ? '' : 's'}` };
}

/** The brief the delegator gets: what went wrong, what has been tried, and the exact moves it has. Plain text, no personal data. */
export function triageBody(o: { board: string; project: string; id: string; title: string; assignee: string | null; round: number; error: string; summary: string; recent: string[]; tried: string[]; standin: string | null }): string {
  const k = `hermes kanban --board ${o.board}`;
  return [
    `[triage-for: ${o.id}]`,
    `Task ${o.id} "${o.title}" (project ${o.project}) is stuck with ${o.assignee ?? 'no one'}. You delegated it, or lead the project, so you decide what happens next. Nobody else is going to look at it, and Frank should not have to. Triage round ${o.round}.`,
    '',
    `What went wrong: ${o.error || '(no error recorded)'}`,
    o.summary ? `Its last summary: ${o.summary}` : '',
    o.recent.length ? `Recent comments:\n${o.recent.map((r) => `- ${r}`).join('\n')}` : '',
    `Already tried: automatic retry; agents so far: ${o.tried.join(', ') || o.assignee || 'none'}.${o.standin ? ` If you do nothing, the platform will hand it to ${o.standin} next.` : ''}`,
    '',
    'Read it first: `' + `${k} show ${o.id}` + '` and `' + `${k} log ${o.id}` + '`. Then do ONE of these, and finish this task with a one-line outcome:',
    `1. Retry with better instructions: \`${k} comment ${o.id} "<what to do differently, what you decided, the answer to its question>"\` then \`${k} unblock ${o.id} --reason "retry with guidance"\`.`,
    `2. Give it to a better-suited agent: \`${k} reassign ${o.id} <agent> --reason "<why>"\` then unblock it. Check the agent exists and serves this portfolio; never move personal data to an agent that uses a cloud model.`,
    `3. Make it smaller: edit its body (\`${k} edit ${o.id} --body-file …\`) or create narrower tasks, then unblock or archive it.`,
    `4. Only if it truly needs Frank (a password, a payment, a decision only he can make): \`${k} comment ${o.id} "${NEEDS_HUMAN_MARK} <what exactly he must do>"\`. Use this rarely; it ends the automatic attempts.`,
    'Do not deploy, spend or publish. Do not paste private data into comments.',
  ].filter(Boolean).join('\n');
}
