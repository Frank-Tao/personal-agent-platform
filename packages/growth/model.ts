import { parseYaml, stringifyYaml, type Yaml } from '../work/yaml.ts';

// Agent growth records (docs/design/agent-growth.md). Two kinds of durable knowledge per agent, both plain Markdown with front matter
// so they survive any platform change and can be read, corrected and versioned by a person:
//   About You  : task-related evidence about how Frank works (preferences, constraints, workflow, decision rules), each with a source,
//                support/opposition counts and a confidence that is computed, never asserted.
//   Lessons    : "when X, do Y" cards with their scope and counterexamples, promoted only by observed outcomes.

export const KINDS = ['preference', 'constraint', 'workflow', 'decision-rule'] as const;
export type AboutKind = (typeof KINDS)[number];
export const SOURCES = ['user-said', 'observed', 'correction'] as const;
export type AboutSource = (typeof SOURCES)[number];
export type AboutState = 'active' | 'tentative' | 'retracted' | 'superseded';

export interface AboutEntry {
  id: string;
  text: string;
  kind: AboutKind;
  /** An agent id, or "*" for every agent. */
  scope: string;
  source: AboutSource;
  /** Task id, session or date that this came from. */
  ref: string;
  observed: string;
  support: number;
  oppose: number;
  retracted: boolean;
  superseded_by: string | null;
  updated: string;
  /** Written into the agent's system prompt (SOUL.md) instead of waiting to be asked for; only for what Frank said himself. */
  always?: boolean;
}

export type LessonStatus = 'tentative' | 'local' | 'reused' | 'retired';
export interface Application { task: string; outcome: 'win' | 'loss' | 'neutral'; at: string }
export interface Lesson {
  id: string;
  agent: string;
  title: string;
  /** What to do. */
  lesson: string;
  /** Situations where it applies. */
  when: string;
  /** Counterexamples and limits. */
  not_when: string;
  evidence: string[];
  status: LessonStatus;
  applied: Application[];
  created: string;
  updated: string;
  retired_reason: string | null;
  supersedes: string | null;
}

/* ---------- helpers ---------- */

const obj = (v: Yaml | undefined): { [k: string]: Yaml } => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v: Yaml | undefined): Yaml[] => (Array.isArray(v) ? v : []);
const text = (v: Yaml | undefined, d = ''): string => (v === null || v === undefined ? d : String(v));
const num = (v: Yaml | undefined, d = 0): number => (typeof v === 'number' ? v : d);
const nstr = (v: Yaml | undefined): string | null => (v === null || v === undefined || v === '' ? null : String(v));

export function splitDoc(md: string): { meta: { [k: string]: Yaml }; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { meta: obj(parseYaml(m[1])), body: m[2] } : { meta: {}, body: md };
}
export const joinDoc = (meta: { [k: string]: Yaml }, body = ''): string => `---\n${stringifyYaml(meta)}---\n${body.startsWith('\n') || !body ? '' : '\n'}${body}`;

const daysBetween = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 86_400_000);

/* ---------- About You ---------- */

/**
 * Confidence from evidence. Something Frank said or corrected starts high and does not age; something merely observed starts low,
 * grows with support, falls faster with opposition, and fades 5% per month without new support.
 */
export function aboutConfidence(e: AboutEntry, today: string): number {
  const base = e.source === 'observed' ? 0.4 : 0.9;
  let c = base + 0.15 * e.support - 0.25 * e.oppose;
  if (e.source === 'observed') c -= 0.05 * Math.floor(daysBetween(e.updated, today) / 30);
  return Math.round(Math.min(0.95, Math.max(0.05, c)) * 100) / 100;
}

export function aboutState(e: AboutEntry, today: string): AboutState {
  if (e.retracted) return 'retracted';
  if (e.superseded_by) return 'superseded';
  return aboutConfidence(e, today) >= 0.5 ? 'active' : 'tentative';
}

export function readAbout(md: string): AboutEntry[] {
  return arr(splitDoc(md).meta.entries).map((x) => {
    const e = obj(x);
    return { id: text(e.id), text: text(e.text), kind: (KINDS as readonly string[]).includes(text(e.kind)) ? (text(e.kind) as AboutKind) : 'preference', scope: text(e.scope, '*'),
      source: (SOURCES as readonly string[]).includes(text(e.source)) ? (text(e.source) as AboutSource) : 'observed', ref: text(e.ref), observed: text(e.observed), support: num(e.support), oppose: num(e.oppose),
      retracted: e.retracted === true, superseded_by: nstr(e.superseded_by), updated: text(e.updated), ...(e.always === true ? { always: true } : {}) };
  });
}

export function writeAbout(agent: string, entries: AboutEntry[], today: string): string {
  const body = `# About you — as known by ${agent}\n\nEvidence about how Frank works, written by agents and correctable by Frank (Cockpit → agent → About You). Confidence is computed from support and opposition; nothing here is a personality label.\n`;
  return joinDoc({ agent, updated: today, entries: entries.map((e) => (e.always ? e : (({ always: _a, ...rest }) => rest)(e))) as unknown as Yaml }, body);
}

export const aboutId = (agentOrScope: string, t: string): string => `a-${hash(agentOrScope + '|' + t.toLowerCase().trim()).slice(0, 6)}`;

function hash(s: string): string { let h = 5381; for (const ch of s) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0; return h.toString(16).padStart(8, '0') + (h ^ 0x9e3779b9).toString(16).padStart(8, '0').slice(-8); }

/* ---------- Lessons ---------- */

export function readLesson(md: string): Lesson {
  const m = splitDoc(md).meta;
  const status = text(m.status, 'tentative');
  return { id: text(m.id), agent: text(m.agent), title: text(m.title), lesson: text(m.lesson), when: text(m.when), not_when: text(m.not_when), evidence: arr(m.evidence).map((x) => String(x)),
    status: (['tentative', 'local', 'reused', 'retired'].includes(status) ? status : 'tentative') as LessonStatus,
    applied: arr(m.applied).map((x) => { const a = obj(x); return { task: text(a.task), outcome: (['win', 'loss', 'neutral'].includes(text(a.outcome)) ? text(a.outcome) : 'neutral') as Application['outcome'], at: text(a.at) }; }),
    created: text(m.created), updated: text(m.updated), retired_reason: nstr(m.retired_reason), supersedes: nstr(m.supersedes) };
}

export function writeLesson(l: Lesson): string {
  const body = `# ${l.title}\n\n**Do:** ${l.lesson}\n\n**Applies when:** ${l.when}\n\n**Not when:** ${l.not_when || '—'}\n`;
  return joinDoc({ id: l.id, agent: l.agent, title: l.title, lesson: l.lesson, when: l.when, not_when: l.not_when, evidence: l.evidence, status: l.status, applied: l.applied as unknown as Yaml,
    created: l.created, updated: l.updated, retired_reason: l.retired_reason, supersedes: l.supersedes }, body);
}

export const wins = (l: Lesson) => l.applied.filter((a) => a.outcome === 'win').length;
export const losses = (l: Lesson) => l.applied.filter((a) => a.outcome === 'loss').length;

/**
 * Promotion rules, from outcomes only. A first verified win makes a tentative lesson "local"; wins on two different tasks make it
 * "reused". Two losses that outnumber the wins retire it (kept, with the reason). A lesson is never promoted by being repeated.
 */
export function settle(l: Lesson): Lesson {
  if (l.status === 'retired') return l;
  const w = new Set(l.applied.filter((a) => a.outcome === 'win').map((a) => a.task)).size, lo = losses(l);
  if (lo >= 2 && lo > wins(l)) return { ...l, status: 'retired', retired_reason: `lost ${lo} of ${l.applied.length} applications` };
  return { ...l, status: w >= 2 ? 'reused' : w >= 1 ? 'local' : 'tentative' };
}

export const lessonId = (today: string, title: string): string => `l-${today.replace(/-/g, '')}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'lesson'}`;
