// Agents end a task with a hand-off. The task body asks them to include a `Decisions:` section (one line per decision others need to know,
// what and why) and an `Open questions:` section. This reads those sections out of the hand-off, so decisions are captured by code from what
// the agent already wrote, whichever model wrote it, with no second model call. What comes out is only ever a *proposal*: the owner confirms.

export interface HandoffItem { title: string; why: string }
export interface Handoff { decisions: HandoffItem[]; questions: HandoffItem[] }

const HEAD = /^\s*(?:#{1,4}\s*)?(?:\*\*|__)?\s*(Decisions?(?:\s+(?:made|taken|to note))?|Open\s+questions?)\s*(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*(.*)$/i;
const OTHER_HEAD = /^\s*(?:#{1,4}\s+\S|(?:\*\*|__)[^*_\n]{2,40}(?:\*\*|__):?\s*$|[A-Z][A-Za-z ]{2,30}:\s*$)/;
const BULLET = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*)$/;
const NONE = /^(none|n\/a|nothing|no decisions?|no open questions?|-)\.?$/i;

const clean = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

function split(raw: string): HandoffItem {
  const t = clean(raw);
  const m = t.match(/^(.+?)\s+(?:—|–|-|because|\(why:|why:)\s+(.+?)\)?$/i);
  return m ? { title: m[1].replace(/[.:;]$/, '').trim(), why: m[2].trim() } : { title: t.replace(/[.:;]$/, ''), why: '' };
}

export function parseHandoff(text: string, max = 6): Handoff {
  const out: Handoff = { decisions: [], questions: [] };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(HEAD);
    if (!h) continue;
    const target = /^open/i.test(h[1]) ? out.questions : out.decisions;
    const add = (s: string) => { const c = clean(s); if (c && !NONE.test(c) && target.length < max) { const it = split(c); if (it.title.length >= 6) target.push(it); } };
    if (h[2].trim()) add(h[2]);
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) { if (j + 1 < lines.length && BULLET.test(lines[j + 1])) continue; break; }   // a blank line ends the section unless the list goes on
      const b = l.match(BULLET);
      if (b) { add(b[1]); continue; }
      if (HEAD.test(l) || OTHER_HEAD.test(l)) break;
      add(l);                                                                                      // a plain line under the heading counts as one item
    }
  }
  return out;
}
