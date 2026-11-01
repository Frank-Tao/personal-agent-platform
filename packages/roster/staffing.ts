import { type CatalogEntry, scoreFields, tokens } from './catalog.ts';

// Does the current team cover a task? A cheap, deterministic first look — NOT the final judgement.
// It exists so Cockpit can flag "this unassigned task may need a specialist we don't have" without spending
// a single model token; Atlas then applies real judgement (agent-roster / agent-staffing skills) and asks you
// before creating anything.

export interface StaffingAgent {
  id: string;
  name: string;
  role: string;
  profile: string;
  state: 'active' | 'proposed' | 'unlisted';
  portfolios: string[];
  allPortfolios: boolean;
  personaName?: string | null;
  personaSlug?: string | null;
  division?: string | null;
}

export interface StaffingInput {
  title: string;
  body?: string | null;
  portfolio: string;
}

export interface StaffingResult {
  /** covered = an agent on this portfolio's team matches the task; gap = the team exists but nothing matches; no-team = nobody serves it. */
  verdict: 'covered' | 'gap' | 'no-team';
  confidence: 'low' | 'medium';
  best: Array<{ id: string; name: string; state: StaffingAgent['state']; score: number; matched: string[] }>;
  candidates: Array<{ slug: string; name: string; emoji: string; division: string; description: string; score: number; matched: string[]; bytes: number }>;
  note: string;
}

/** Weighted word hits (and 2+ distinct words) needed before an agent counts as covering a task (a role word is 1, a name word 2). */
export const COVER_MIN = 3;
const CANDIDATE_MIN = 3;

function agentFields(a: StaffingAgent) {
  const name = a.name.trim().toLowerCase();
  // The persona's own name often equals the agent's name: count it once.
  return [{ text: a.name, weight: 2 }, ...(a.personaName && a.personaName.trim().toLowerCase() !== name ? [{ text: a.personaName, weight: 2 }] : []), { text: a.role, weight: 1 }, { text: a.division ?? '', weight: 1 }];
}

const taskText = (i: StaffingInput) => `${i.title} ${i.body ?? ''}`;

export function evaluateStaffing(input: StaffingInput, agents: StaffingAgent[], catalog: CatalogEntry[], opts: { candidates?: number } = {}): StaffingResult {
  const q = new Set(tokens(taskText(input)));
  // Atlas (the router) and profiles outside the roster never count as coverage; proposed agents do, but are labelled.
  const team = agents.filter((a) => a.profile !== 'default' && a.state !== 'unlisted' && (a.allPortfolios || a.portfolios.includes(input.portfolio)));

  const best = team
    .map((a) => ({ a, ...scoreFields(q, agentFields(a)) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || x.a.id.localeCompare(y.a.id))
    .slice(0, 3)
    .map((x) => ({ id: x.a.id, name: x.a.name, state: x.a.state, score: x.score, matched: x.matched }));

  // One shared word is not coverage ("store" is in both "App Store" and "data we store"): need two distinct words.
  const covered = !!best[0] && best[0].score >= COVER_MIN && best[0].matched.length >= 2;
  const verdict: StaffingResult['verdict'] = covered ? 'covered' : team.length ? 'gap' : 'no-team';

  const taken = new Set(agents.map((a) => a.personaSlug).filter(Boolean));
  const candidates = covered
    ? []
    : catalog
        .filter((e) => !taken.has(e.slug))
        .map((e) => ({ e, ...scoreFields(q, [{ text: e.name, weight: 3 }, { text: e.slug.replace(/[-/]/g, ' '), weight: 1 }, { text: e.description, weight: 1 }, { text: e.vibe, weight: 1 }]) }))
        .filter((x) => x.score >= CANDIDATE_MIN && x.matched.length >= 2) // one stray shared word is not a match
        .sort((x, y) => y.score - x.score || x.e.slug.localeCompare(y.e.slug))
        .slice(0, opts.candidates ?? 3)
        .map((x) => ({ slug: x.e.slug, name: x.e.name, emoji: x.e.emoji, division: x.e.division, description: x.e.description, score: x.score, matched: x.matched, bytes: x.e.bytes }));

  const note = covered
    ? `${best[0].name} matches (${best[0].matched.join(', ')})${best[0].state === 'proposed' ? ' — but that agent has not been created yet' : ''}.`
    : team.length
      ? `No agent on this portfolio's team matches the task's wording${candidates.length ? '; catalog specialists that do are listed' : ' and the catalog has no close match either'}.`
      : 'Nobody is linked to this portfolio yet.';
  return { verdict, confidence: q.size >= 4 ? 'medium' : 'low', best, candidates, note };
}
