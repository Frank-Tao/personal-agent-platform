// Keep tasks moving. Pure: the CLI does the actions. Run every ten minutes by launchd (with advance and watch), and on demand by the
// "Nudge now" button in Cockpit. It never does anything the dispatcher would not do, and it retries a blocked task at most once by itself:
// after that the task is reported to the human (Needs you) instead of looping.

export interface NudgeTask {
  id: string;
  status: string;
  /** Parent task ids with their status. */
  parents: Array<{ id: string; status: string }>;
  /** From `kanban show --json`. */
  events: Array<{ kind?: string; created_at?: number; payload?: { reason?: string; kind?: string; author?: string } | null }>;
  comments: Array<{ author?: string; body?: string; text?: string }>;
}

export type NudgeAction =
  | { do: 'promote'; id: string; why: string }
  | { do: 'retry'; id: string; why: string; attempt: number }
  | { do: 'escalate'; id: string; why: string };

export const AUTO_RETRY_MARK = '[auto-retry';
export const MAX_AUTO_RETRIES = 1;
export const BLOCKED_MINUTES = 30;
/** Block kinds only a human or a config change can clear: retrying would just fail again. */
const HUMAN_KINDS = new Set(['capability', 'needs_input']);

const retriesSoFar = (t: NudgeTask): number => t.comments.filter((c) => (c.body ?? c.text ?? '').includes(AUTO_RETRY_MARK)).length;

/** What to do about one task, or null to leave it alone. */
export function nudgeTask(t: NudgeTask, nowSec: number, agents: ReadonlySet<string>): NudgeAction | null {
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
  const kind = last?.payload?.kind;
  if (kind && HUMAN_KINDS.has(kind)) return { do: 'escalate', id: t.id, why: `blocked (${kind}): ${(last?.payload?.reason ?? '').slice(0, 160)}` };
  // Spawn failures and give-ups: one automatic retry after a pause, then hand over to the human.
  const ageMin = since ? (nowSec - since) / 60 : Infinity;
  if (retriesSoFar(t) >= MAX_AUTO_RETRIES) return { do: 'escalate', id: t.id, why: `still blocked after ${retriesSoFar(t)} automatic retr${retriesSoFar(t) === 1 ? 'y' : 'ies'}` };
  if (ageMin >= BLOCKED_MINUTES) return { do: 'retry', id: t.id, why: `blocked for ${Math.round(ageMin)} min with no one touching it`, attempt: retriesSoFar(t) + 1 };
  return null;
}
