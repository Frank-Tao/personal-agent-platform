import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { feedbackPath, list, normalise, type FeedbackItem, type FeedbackOpts } from './feedback.ts';

// Weekly consolidation: group near-duplicate open feedback, rank, write proposals (docs/design/feedback-loop.md §3.2, §4.2, §5, §6).
// Deterministic: no model calls. Thresholds live here, not per run.

export const JACCARD = 0.5, JACCARD_SAME_PAGE = 0.35, MAX_PENDING = 5, FRESH_SINGLE_DAYS = 7, STALE_DAYS = 60, HALF_LIFE_DAYS = 14, MAX_EVIDENCE = 5;
const DAY = 86_400_000;
const STOP = new Set('a an and are as at be but by for from has have i in is it its me my of on or so that the this to was we with you your should would could can not no do does did just it s t'.split(' '));

export interface Evidence { id: string; source: string; time: string; quote: string; }
export interface Proposal {
  v: 1; id: string; week: string; created: string; title: string; items: string[]; evidence: Evidence[];
  count: number; days: number; sources: string[]; pages: string[]; score: number;
  status: 'pending' | 'approved' | 'converted' | 'done' | 'deferred' | 'rejected' | 'superseded';
  decision: unknown; tasks: unknown[]; prior: string | null;
}
export const proposalsPath = (dir: string) => join(dir, 'feedback-proposals.jsonl');

export function readProposals(dir: string): Proposal[] {
  const p = proposalsPath(dir);
  if (!existsSync(p)) return [];
  const m = new Map<string, Proposal>();
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && typeof o.id === 'string' && o.v === 1) m.set(o.id, o); } catch { /* torn line: skipped */ }
  }
  return [...m.values()];
}

export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const y = t.getUTCFullYear();
  const wk = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / DAY + 1) / 7);
  return `${y}-W${String(wk).padStart(2, '0')}`;
}

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (let w of normalise(text).replace(/^urgent\s+/, '').split(' ')) {
    if (!w || STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 3 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('es')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
    if (w) out.add(w);
  }
  return out;
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0; for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}
export function similar(a: FeedbackItem, b: FeedbackItem): boolean {
  const j = jaccard(tokens(a.text), tokens(b.text));
  return j >= JACCARD || (a.page != null && a.page === b.page && j >= JACCARD_SAME_PAGE);
}

/** score = sum of 0.5^(age/14) over items, times (1 + 0.25 x (distinct sources - 1)). */
export function scoreOf(items: FeedbackItem[], now: Date): number {
  const decay = items.reduce((s, i) => s + Math.pow(0.5, Math.max(0, now.getTime() - Date.parse(i.time)) / DAY / HALF_LIFE_DAYS), 0);
  const sources = new Set(items.map((i) => i.source)).size;
  return Math.round(decay * (1 + 0.25 * Math.max(0, sources - 1)) * 100) / 100;
}

const newestFirst = (a: FeedbackItem, b: FeedbackItem) => Date.parse(b.time) - Date.parse(a.time) || (a.id < b.id ? -1 : 1);
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Build or refresh a proposal record from its member items. */
export function buildProposal(items: FeedbackItem[], now: Date, base?: Proposal): Proposal {
  const byNew = [...items].sort(newestFirst);
  const byOld = [...items].sort((a, b) => -newestFirst(a, b));
  const seed = byOld[0].id.split('-').pop()!;
  const week = base?.week ?? isoWeek(now);
  return {
    v: 1, id: base?.id ?? `fp-${week.replace('-', '')}-${seed}`, week, created: base?.created ?? now.toISOString(),
    title: cut(byNew[0].text.replace(/\s+/g, ' '), 100),
    items: byOld.map((i) => i.id),
    evidence: byNew.slice(0, MAX_EVIDENCE).map((i) => ({ id: i.id, source: i.source, time: i.time, quote: cut(i.text.replace(/\s+/g, ' '), 200) })),
    count: items.length, days: new Set(items.map((i) => i.time.slice(0, 10))).size,
    sources: [...new Set(items.map((i) => i.source))].sort(), pages: [...new Set(items.map((i) => i.page).filter((p): p is string => !!p))].sort(),
    score: scoreOf(items, now), status: base?.status ?? 'pending', decision: base?.decision ?? null, tasks: base?.tasks ?? [], prior: base?.prior ?? null,
  };
}

export interface DigestResult {
  proposals: Proposal[];          // new or changed proposal records to append
  itemUpdates: FeedbackItem[];    // item records to append (status/proposal changes)
  created: number; updated: number; staled: number; waiting: number; atCap: boolean; skipped: number; ranked: Proposal[];
}

export function planDigest(opts: FeedbackOpts = {}): DigestResult {
  const dir = opts.dir ?? join(process.cwd(), 'data');
  const now = (opts.now ?? (() => new Date()))();
  const all = list({ dir });
  const byId = new Map(all.map((i) => [i.id, i]));
  const open = all.filter((i) => i.status === 'open').sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || (a.id < b.id ? -1 : 1));
  const existing = readProposals(dir);
  const pending = existing.filter((p) => p.status === 'pending');
  const proposals = new Map<string, Proposal>(), itemUpdates = new Map<string, FeedbackItem>();
  const touch = (i: FeedbackItem, status: FeedbackItem['status'], proposal: string | null, note = '') => itemUpdates.set(i.id, { ...i, status, proposal, note: note || i.note });

  // 1. Open items that match a pending proposal join it (never in two proposals).
  const rest: FeedbackItem[] = [];
  const members = new Map(pending.map((p) => [p.id, p.items.map((id) => byId.get(id)).filter((x): x is FeedbackItem => !!x)]));
  for (const it of open) {
    const hit = pending.find((p) => members.get(p.id)!.some((m) => similar(it, m)));
    if (hit) { members.get(hit.id)!.push(it); touch(it, 'proposed', hit.id); } else rest.push(it);
  }
  let updated = 0;
  for (const p of pending) {
    const m = members.get(p.id)!;
    if (m.length === p.items.length || !m.length) continue;
    proposals.set(p.id, buildProposal(m, now, p)); updated++;
  }

  // 2. Group the rest: single-link, oldest first.
  const groups: FeedbackItem[][] = [];
  for (const it of rest) {
    const hits = groups.filter((g) => g.some((m) => similar(it, m)));
    if (!hits.length) { groups.push([it]); continue; }
    const merged = [...hits.flat(), it];
    for (const h of hits) groups.splice(groups.indexOf(h), 1);
    groups.push(merged);
  }

  // 3. Eligibility: >= 2 items, or one older than 7 days, or tagged urgent.
  const eligible = (g: FeedbackItem[]) => g.length >= 2 || now.getTime() - Date.parse(g[0].time) > FRESH_SINGLE_DAYS * DAY || /^\s*urgent\s*:/i.test(g[0].text);
  const candidates = groups.filter(eligible).map((g) => buildProposal(g, now))
    .sort((a, b) => b.score - a.score || Date.parse(b.evidence[0].time) - Date.parse(a.evidence[0].time) || (a.id < b.id ? -1 : 1));

  // 4. Cap: at most 5 pending at once; the rest stay open and keep accumulating.
  const room = Math.max(0, MAX_PENDING - pending.length);
  const taken = candidates.slice(0, room);
  for (const p of taken) { proposals.set(p.id, p); for (const id of p.items) touch(byId.get(id)!, 'proposed', p.id); }
  const takenIds = new Set(taken.flatMap((p) => p.items));

  // 5. Singletons that nobody repeated within 60 days go stale (kept, hidden by default).
  let staled = 0;
  for (const g of groups) {
    if (g.length !== 1 || takenIds.has(g[0].id)) continue;
    if (now.getTime() - Date.parse(g[0].time) > STALE_DAYS * DAY) { touch(g[0], 'stale', null, 'stale after 60 days'); staled++; }
  }
  const waiting = groups.filter((g) => !g.some((i) => takenIds.has(i.id)) && !(g.length === 1 && itemUpdates.get(g[0].id)?.status === 'stale')).length;
  const ranked = [...pending.map((p) => proposals.get(p.id) ?? p), ...taken].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return {
    proposals: [...proposals.values()], itemUpdates: [...itemUpdates.values()], created: taken.length, updated, staled, waiting,
    atCap: pending.length + taken.length >= MAX_PENDING && candidates.length > room, skipped: 0, ranked,
  };
}

/** Appends the plan under a lock file so two digests never run at once. */
export function applyDigest(r: DigestResult, opts: FeedbackOpts = {}): void {
  const dir = opts.dir ?? join(process.cwd(), 'data');
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'feedback.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx'); } catch { throw new Error('another feedback digest is running (data/feedback.lock exists)'); }
  try {
    for (const p of r.proposals) appendFileSync(proposalsPath(dir), JSON.stringify(p) + '\n');
    for (const i of r.itemUpdates) appendFileSync(feedbackPath(dir), JSON.stringify(i) + '\n');
  } finally { closeSync(fd); unlinkSync(lock); }
}
