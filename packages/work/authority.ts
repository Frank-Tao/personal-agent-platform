import type { Decision } from './decisions.ts';

// Who may decide an agent's proposal or answer an agent's question? Most of what agents write down is their own planning (how a table is laid
// out, how files are handed over, a risk they noticed): the project's steward (its approver agent, else the project manager) can settle that.
// Only a few things are the owner's, and those are the ones this finds. Deterministic and deliberately conservative: when a rule matches, it is the owner's.

export interface Authority { owner: boolean; why: string }

const SECRETS = /\b(secrets?|credentials?|passwords?|passphrases?|api[- ]?keys?|access tokens?)\b/i;
const MONEY_OUTWARD = /\b(spend(ing)?|budget|payments?|pay for|purchase|subscription|deploy(ing|ment)?|publish(ing)?|go live|send(ing)? (an )?e-?mail|external (post|message))\b/i;
const OWNER_SCOPE = /\b(charter|done[- ]when|outcome of the project|scope of the project|timebox|team members?|change the team)\b/i;
const PERSONAL_DATA = /\b(personal (data|statements?|information)|real[- ](files?|statements?|pdfs?|holdings|transactions)|private[- ]finance)\b/i;
const ASKS_OWNER = /\b(frank (must|needs to|has to|should decide|to decide|to approve|approves?)|needs frank|ask(s|ing)? frank|frank'?s (decision|approval|call)|owner (decides|decision|approval))\b/i;
const CHANGES = /\b(replac(e|es|ed)|supersed(e|es)|overrid(e|es)|instead of|amend(s|ed)?|chang(e|es|ing)|contradict(s)?|relax(es)?|drop(s)?)\b/i;

/** `byNumber` looks up a decision of the same ledger, so a proposal that changes something Frank decided can be recognised. */
export function authorityOf(d: Pick<Decision, 'title' | 'why' | 'notes' | 'by'>, byNumber: (n: number) => Pick<Decision, 'by' | 'n'> | undefined = () => undefined): Authority {
  const text = `${d.title} ${d.why}`;
  if (/\bescalated by\b/i.test(d.notes ?? '')) return { owner: true, why: 'an agent escalated it to you' };
  if (SECRETS.test(text)) return { owner: true, why: 'it touches a secret or a credential' };
  if (MONEY_OUTWARD.test(text)) return { owner: true, why: 'it is about spending, publishing or deploying' };
  if (OWNER_SCOPE.test(text)) return { owner: true, why: 'it changes the charter, scope or team' };
  if (PERSONAL_DATA.test(text)) return { owner: true, why: 'it concerns your real or personal data' };
  if (ASKS_OWNER.test(text)) return { owner: true, why: 'it asks for your decision' };
  if (CHANGES.test(text)) {
    for (const m of text.matchAll(/\bD(\d{1,4})\b/g)) {
      const old = byNumber(Number(m[1]));
      if (old && /^(frank|owner|you)$/i.test(old.by.trim())) return { owner: true, why: `it changes D${old.n}, which you decided` };
    }
  }
  return { owner: false, why: 'the project manager can settle this' };
}

/** An item waits this long for its steward before it is shown to the owner after all: nothing an agent could not settle may disappear. */
export const STEWARD_PATIENCE_HOURS = 36;

/**
 * Does this item go to the owner? By rule (authorityOf), or because there is nobody to settle it (no steward), or because the steward has not
 * settled it in STEWARD_PATIENCE_HOURS. `date` is the day it was recorded.
 */
export function ownerSees(d: Pick<Decision, 'title' | 'why' | 'notes' | 'by' | 'date'>, byNumber: (n: number) => Pick<Decision, 'by' | 'n'> | undefined, hasSteward: boolean, now = Date.now()): Authority {
  const a = authorityOf(d, byNumber);
  if (a.owner) return a;
  if (!hasSteward) return { owner: true, why: 'this project has no steward to settle it' };
  const age = (now - Date.parse(d.date)) / 3_600_000;
  if (Number.isFinite(age) && age > STEWARD_PATIENCE_HOURS) return { owner: true, why: `the steward has not settled it in ${STEWARD_PATIENCE_HOURS} hours` };
  return a;
}
