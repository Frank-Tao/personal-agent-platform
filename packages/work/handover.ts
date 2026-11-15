import type { Decision } from './decisions.ts';

// The handover brief: what a model (or a person) needs to pick a project up cold, built by code from the stores that outlive any session:
// the charter, the decision ledger and the recent results. The same text goes to every model, so changing the model changes nothing about
// what is known. It is sized for the model that will read it (a small local model gets less than a large cloud one) and always says what was
// left out and how to ask for more.

export interface BriefProject {
  id: string; portfolio: string; status: string; priority: number; outcome: string; done_when: string[]; repo: string | null; team: string[];
}
export interface BriefResult { title: string; status: string; assignee: string | null; completed: string | null; summary: string }
export interface BriefInput { project: BriefProject; today: string; decisions: Decision[]; results: BriefResult[]; budget?: number }

export const DEFAULT_BUDGET = 6000;
export const LOCAL_BUDGET = 2500;

/** Characters of brief for a model: from its context window when known (about 2% of it, as 4 characters a token), 2500 for a model that
 *  runs locally, else 6000. Never below 2000 or above 12000. */
export function briefBudget(model?: { private?: boolean; context?: number | null } | null): number {
  const raw = model?.context ? Math.round(model.context * 4 * 0.02) : model?.private ? LOCAL_BUDGET : DEFAULT_BUDGET;
  return Math.max(2000, Math.min(12_000, raw));
}

const cut = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const line = (d: Decision) => `- ${d.legacy ? 'note' : `D${d.n}`} · ${d.date}${d.by ? ` · ${d.by}` : ''}${d.scope === '_portfolio' ? ' · [whole portfolio]' : ''} — ${cut(d.title, 160)}${d.why ? `. Why: ${cut(d.why, 220)}` : ''}  (${d.ref})`;

export function buildBrief(i: BriefInput): { text: string; omitted: number } {
  const budget = i.budget ?? DEFAULT_BUDGET;
  const p = i.project;
  const head = [
    `PROJECT BRIEF · ${p.id} (${p.portfolio}) · ${i.today}`,
    `Outcome: ${cut(p.outcome, 300)}`,
    ...(p.done_when.length ? ['Done when:', ...p.done_when.slice(0, 6).map((x) => `- ${cut(x, 200)}`)] : []),
    `State: ${p.status} · priority ${p.priority} · ${p.repo ? `repo ${p.repo}` : 'no repo'} · team ${p.team.join(', ') || 'none'}`,
  ];
  const tail = [`More: npm run work -- decision list ${p.id} · record one: npm run work -- decision add ${p.id} --title "…" --why "…" --by <you> --source "task <id>" --apply`];
  const sorted = [...i.decisions].sort((a, b) => (a.date === b.date ? b.n - a.n : b.date.localeCompare(a.date)));   // newest first, whatever order we were given
  const inForce = sorted.filter((d) => d.status === 'active' && d.kind === 'decision');
  const questions = sorted.filter((d) => d.status === 'active' && d.kind === 'question');
  const proposed = sorted.filter((d) => d.status === 'proposed');
  const replaced = sorted.filter((d) => d.status === 'superseded' || d.status === 'reverted');

  type Section = { title: string; items: string[] };
  const sections: Section[] = [
    { title: 'Decisions in force (newest first; follow these):', items: inForce.map(line) },
    { title: 'Open questions (not decided yet; do not assume an answer):', items: questions.map(line) },
    { title: 'Proposed, NOT confirmed (do not treat as settled; mention them if relevant):', items: proposed.map(line) },
    { title: 'Recent results:', items: i.results.slice(0, 6).map((r) => `- [${r.status}${r.completed ? ` ${r.completed.slice(0, 10)}` : ''}${r.assignee ? ` · ${r.assignee}` : ''}] ${cut(r.title, 100)}${r.summary ? ` — ${cut(r.summary, 300)}` : ''}`) },
    { title: 'Replaced or reverted (do not follow):', items: replaced.slice(0, 8).map((d) => `- D${d.n} ${cut(d.title, 100)}  (${d.ref})`) },
  ];
  const out = [...head];
  let omitted = 0;
  const reserve = tail.join('\n').length + 40;
  let used = out.join('\n').length + reserve;
  for (const s of sections) {
    if (!s.items.length) continue;
    const kept: string[] = [];
    for (const it of s.items) {
      if (used + it.length + 1 + (kept.length ? 0 : s.title.length + 2) > budget) { omitted++; continue; }
      kept.push(it); used += it.length + 1 + (kept.length === 1 ? s.title.length + 2 : 0);
    }
    if (kept.length) out.push('', s.title, ...kept);
  }
  if (omitted) out.push('', `(${omitted} more item${omitted === 1 ? '' : 's'} left out to fit; the list command shows everything)`);
  out.push('', ...tail);
  return { text: out.join('\n'), omitted };
}
