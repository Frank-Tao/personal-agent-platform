import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privacyCheck } from '../redact/topics.ts';

// The decision ledger: what was decided, why, by whom, and where it came from, kept as plain markdown in the knowledge base so that it
// outlives any one app, is readable in Obsidian, is covered by the KB's git history and backup, and can be read by an agent with a
// file tool. One file per project (and one for decisions that belong to a whole portfolio):
//
//   ~/PortfolioKB/<portfolio>/decisions/<project>.md
//   ~/PortfolioKB/<portfolio>/decisions/_portfolio.md
//
//   ## D3 · 2026-11-15 · Use SwiftUI for the player view
//   - status: active                  proposed | active | superseded | rejected | reverted
//   - kind: decision                  decision | question (an open question stays `active` until it is answered or superseded)
//   - by: Frank
//   - source: task t_ab12cd34         task <id> | session <id> | approval | feedback <id> | manual
//   - supersedes: D1
//   - why: Faster to ship; no UIKit bridge needed.
//
// `proposed` entries are drafts (an agent's hand-off, a model's reading of a transcript): they are never treated as settled until the
// owner confirms them. Older one-line entries in <portfolio>/decisions.md are read too (as legacy, read-only).

export type DecisionStatus = 'proposed' | 'active' | 'superseded' | 'rejected' | 'reverted';
export type DecisionKind = 'decision' | 'question';
export const STATUSES: DecisionStatus[] = ['proposed', 'active', 'superseded', 'rejected', 'reverted'];
export const PORTFOLIO_SCOPE = '_portfolio';

export interface Decision {
  /** portfolio/scope/D3 */
  ref: string;
  portfolio: string;
  /** A project id, or `_portfolio`. */
  scope: string;
  n: number;
  date: string;
  title: string;
  status: DecisionStatus;
  kind: DecisionKind;
  by: string;
  source: string | null;
  supersedes: string | null;
  why: string;
  notes: string;
  /** From the old one-line decisions.md: shown, never edited. */
  legacy?: boolean;
}

export class DecisionError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const HEADING = /^##\s+D(\d+)\s+·\s+(\d{4}-\d{2}-\d{2})\s+·\s+(.+?)\s*$/;
const FIELD = /^-\s+(status|kind|by|source|supersedes|why):\s*(.*)$/;
const SCOPE = /^(_portfolio|[a-z][a-z0-9-]{0,47})$/;
const one = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export const decisionsDir = (kb: string, portfolio: string) => join(kb, portfolio, 'decisions');
export const ledgerPath = (kb: string, portfolio: string, scope: string) => join(decisionsDir(kb, portfolio), `${scope}.md`);

/** Entries of one ledger file, plus the text before the first entry (kept as it is when the file is rewritten). */
export function parseLedger(text: string, portfolio: string, scope: string): { preface: string; entries: Decision[] } {
  const entries: Decision[] = [];
  const preface: string[] = [];
  let cur: Decision | null = null;
  for (const raw of text.split('\n')) {
    const h = raw.match(HEADING);
    if (h) {
      cur = { ref: `${portfolio}/${scope}/D${h[1]}`, portfolio, scope, n: Number(h[1]), date: h[2], title: h[3], status: 'active', kind: 'decision', by: '', source: null, supersedes: null, why: '', notes: '' };
      entries.push(cur);
      continue;
    }
    if (!cur) { preface.push(raw); continue; }
    const f = raw.match(FIELD);
    if (f) {
      const v = f[2].trim();
      if (f[1] === 'status') cur.status = (STATUSES as string[]).includes(v) ? (v as DecisionStatus) : 'active';
      else if (f[1] === 'kind') cur.kind = v === 'question' ? 'question' : 'decision';
      else if (f[1] === 'by') cur.by = v;
      else if (f[1] === 'source') cur.source = v || null;
      else if (f[1] === 'supersedes') cur.supersedes = v || null;
      else cur.why = v;
    } else if (raw.trim()) cur.notes += (cur.notes ? '\n' : '') + raw.trimEnd();
  }
  return { preface: preface.join('\n').replace(/\s+$/, ''), entries };
}

export function serializeLedger(preface: string, entries: Decision[]): string {
  const blocks = entries.map((d) => [
    `## D${d.n} · ${d.date} · ${d.title}`,
    `- status: ${d.status}`,
    ...(d.kind === 'question' ? ['- kind: question'] : []),
    `- by: ${d.by}`,
    ...(d.source ? [`- source: ${d.source}`] : []),
    ...(d.supersedes ? [`- supersedes: ${d.supersedes}`] : []),
    `- why: ${d.why}`,
    ...(d.notes ? [d.notes] : []),
  ].join('\n'));
  return `${preface ? preface + '\n\n' : ''}${blocks.join('\n\n')}${blocks.length ? '\n' : ''}`;
}

const portfolios = (kb: string): string[] => { try { return readdirSync(kb, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch { return []; } };

/** The old one-line format: `2026-11-01 — decision — why` (optionally a list item). */
function legacyEntries(kb: string, portfolio: string): Decision[] {
  let text = '';
  try { text = readFileSync(join(kb, portfolio, 'decisions.md'), 'utf8'); } catch { return []; }
  const out: Decision[] = [];
  for (const line of text.split('\n')) {
    const m = line.replace(/^\s*[-*]\s*/, '').match(/^(\d{4}-\d{2}-\d{2})\s+[—–-]\s+(.+?)(?:\s+[—–]\s+(.+))?$/);
    if (!m || line.trim().startsWith('<!--')) continue;
    const n = out.length + 1;
    out.push({ ref: `${portfolio}/_legacy/L${n}`, portfolio, scope: PORTFOLIO_SCOPE, n, date: m[1], title: m[2].trim(), status: 'active', kind: 'decision', by: '', source: 'decisions.md', supersedes: null, why: (m[3] ?? '').trim(), notes: '', legacy: true });
  }
  return out;
}

export interface ListFilter { portfolio?: string; project?: string; status?: DecisionStatus | DecisionStatus[]; kind?: DecisionKind; includeLegacy?: boolean }

/** Newest first. */
export function readDecisions(kb: string, f: ListFilter = {}): Decision[] {
  const out: Decision[] = [];
  const want = f.status ? (Array.isArray(f.status) ? f.status : [f.status]) : null;
  for (const p of f.portfolio ? [f.portfolio] : portfolios(kb)) {
    const dir = decisionsDir(kb, p);
    let files: string[] = [];
    try { files = readdirSync(dir).filter((x) => x.endsWith('.md')); } catch { /* none yet */ }
    for (const file of files) {
      const scope = file.slice(0, -3);
      if (!SCOPE.test(scope) || (f.project && scope !== f.project)) continue;
      try { out.push(...parseLedger(readFileSync(join(dir, file), 'utf8'), p, scope).entries); } catch { /* an unreadable file is skipped */ }
    }
    if (f.includeLegacy && !f.project) out.push(...legacyEntries(kb, p));
  }
  return out
    .filter((d) => (!want || want.includes(d.status)) && (!f.kind || d.kind === f.kind))
    .sort((a, b) => (a.date === b.date ? b.n - a.n : b.date.localeCompare(a.date)));
}

export function findDecision(kb: string, ref: string): Decision | null {
  const m = ref.match(/^([a-z][a-z0-9-]*)\/(_portfolio|[a-z][a-z0-9-]{0,47})\/D(\d+)$/);
  if (!m) return null;
  return readDecisions(kb, { portfolio: m[1], project: m[2] }).find((d) => d.n === Number(m[3])) ?? null;
}

function withLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.lock');
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { /* it just went away */ }
      if (i > 100) throw new DecisionError('the decision ledger is busy; try again', 503);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

const load = (kb: string, portfolio: string, scope: string) => {
  const path = ledgerPath(kb, portfolio, scope);
  return { path, ...(existsSync(path) ? parseLedger(readFileSync(path, 'utf8'), portfolio, scope) : { preface: `# Decisions — ${scope === PORTFOLIO_SCOPE ? portfolio : scope}\n\n<!-- One entry per decision: what, why, who, where it came from. Written by \`work decision\`, Cockpit and agents; safe to edit by hand. -->`, entries: [] as Decision[] }) };
};
const store = (path: string, preface: string, entries: Decision[]) => { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, serializeLedger(preface, entries)); renameSync(tmp, path); };

export interface AddInput {
  portfolio: string;
  /** A project id; omit for a decision about the whole portfolio. */
  project?: string;
  title: string;
  why?: string;
  by?: string;
  source?: string;
  status?: 'proposed' | 'active';
  kind?: DecisionKind;
  /** Ref or `D<n>` of an entry in the same file that this replaces; it is marked superseded. */
  supersedes?: string;
  date: string;
}

/** Adds an entry. The same title from the same source in the same file is not added twice (so approvals and harvests can be re-run). */
export function addDecision(kb: string, i: AddInput): { decision: Decision; duplicate: boolean } {
  const scope = i.project ?? PORTFOLIO_SCOPE;
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(i.portfolio)) throw new DecisionError('bad portfolio');
  if (!SCOPE.test(scope)) throw new DecisionError('bad project id');
  const title = one(i.title, 200), why = one(i.why, 1000), by = one(i.by || 'unknown', 60), source = one(i.source, 120) || null;
  if (title.length < 6) throw new DecisionError('say what was decided (at least a few words)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.date)) throw new DecisionError('bad date');
  if (source && !/^(task t_[0-9a-f]{4,16}|session \S{4,80}|approval|feedback \S{3,40}|manual|harvest t_[0-9a-f]{4,16}|chat \S{3,80})$/.test(source)) throw new DecisionError(`unknown source "${source}"`);
  const verdict = privacyCheck(`${title}\n${why}`);
  if (verdict.private) throw new DecisionError(`this looks private (${verdict.reasons.join(', ')}); the ledger is not for that, so it was not saved`, 422);
  return withLock(decisionsDir(kb, i.portfolio), () => {
    const { path, preface, entries } = load(kb, i.portfolio, scope);
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const dup = entries.find((d) => key(d.title) === key(title) && (d.source ?? '') === (source ?? '') && d.kind === (i.kind ?? 'decision') && d.status !== 'rejected');
    if (dup) return { decision: dup, duplicate: true };
    const n = entries.reduce((m, d) => Math.max(m, d.n), 0) + 1;
    let supersedes: string | null = null;
    if (i.supersedes) {
      const num = Number((i.supersedes.match(/D(\d+)$/) ?? [])[1]);
      const old = entries.find((d) => d.n === num);
      if (!old) throw new DecisionError(`${i.supersedes} is not in this ledger`, 404);
      old.status = 'superseded'; supersedes = `D${old.n}`;
    }
    const decision: Decision = { ref: `${i.portfolio}/${scope}/D${n}`, portfolio: i.portfolio, scope, n, date: i.date, title, status: i.status ?? 'active', kind: i.kind ?? 'decision', by, source, supersedes, why, notes: '' };
    entries.push(decision);
    store(path, preface, entries);
    return { decision, duplicate: false };
  });
}

/** Changes the status of one entry: confirm a proposal (active), reject it, mark a decision reverted, or answer a question. */
export function setStatus(kb: string, ref: string, status: DecisionStatus, by: string, reason?: string): Decision {
  const m = ref.match(/^([a-z][a-z0-9-]*)\/(_portfolio|[a-z][a-z0-9-]{0,47})\/D(\d+)$/);
  if (!m) throw new DecisionError('bad decision reference (portfolio/project/D3)');
  if (!(STATUSES as string[]).includes(status)) throw new DecisionError('bad status');
  return withLock(decisionsDir(kb, m[1]), () => {
    const { path, preface, entries } = load(kb, m[1], m[2]);
    const d = entries.find((x) => x.n === Number(m[3]));
    if (!d) throw new DecisionError(`no such decision ${ref}`, 404);
    if (status === 'active' && d.status !== 'proposed' && d.status !== 'reverted') throw new DecisionError(`${ref} is ${d.status}; only a proposed or reverted entry can be made active`, 409);
    if (status === 'rejected' && d.status !== 'proposed') throw new DecisionError(`${ref} is ${d.status}; only a proposal can be rejected`, 409);
    d.status = status;
    const note = `${status} by ${one(by, 60) || 'unknown'}${reason ? `: ${one(reason, 300)}` : ''}`;
    d.notes += (d.notes ? '\n' : '') + `- ${note}`;
    store(path, preface, entries);
    return d;
  });
}
