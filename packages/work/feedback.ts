import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Feedback store: data/feedback.jsonl, append-only, last line per id wins (docs/design/feedback-loop.md §3.1, §4.1).

export const SOURCES = ['cockpit', 'telegram', 'cli'] as const;
export type FeedbackSource = (typeof SOURCES)[number];
export interface FeedbackItem {
  v: 1; id: string; time: string; source: FeedbackSource; by: string; text: string; page: string | null;
  ref: string | null; key: string; status: 'open' | 'proposed' | 'accepted' | 'done' | 'deferred' | 'rejected' | 'stale';
  proposal: string | null; note: string;
}
export class FeedbackError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface FeedbackOpts { dir?: string; now?: () => Date; }
export interface AddInput { text: unknown; source?: unknown; by?: unknown; page?: unknown; ref?: unknown; }

export const MIN_TEXT = 3, MAX_TEXT = 2000, DEDUPE_MS = 24 * 3600_000, RATE_PER_HOUR = 30;
const defaultDir = () => join(process.cwd(), 'data');
export const feedbackPath = (dir = defaultDir()) => join(dir, 'feedback.jsonl');

export const normalise = (t: string): string =>
  t.normalize('NFKC').toLowerCase().replace(/^\s*(#feedback|feedback\s*:)\s*/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
export const keyOf = (t: string): string => createHash('sha256').update(normalise(t)).digest('hex').slice(0, 12);

/** Every record in file order, plus the number of unparseable lines skipped. */
export function readAll(opts: FeedbackOpts = {}): { items: FeedbackItem[]; skipped: number } {
  const p = feedbackPath(opts.dir);
  if (!existsSync(p)) return { items: [], skipped: 0 };
  const items: FeedbackItem[] = []; let skipped = 0;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && typeof o.id === 'string' && o.v === 1) items.push(o); else skipped++; } catch { skipped++; }
  }
  return { items, skipped };
}
/** Current state of each item: the last line for an id wins. */
export function fold(items: FeedbackItem[]): FeedbackItem[] {
  const m = new Map<string, FeedbackItem>();
  for (const i of items) m.set(i.id, i);
  return [...m.values()];
}
export const list = (opts: FeedbackOpts = {}): FeedbackItem[] => fold(readAll(opts).items);

const clip = (v: unknown, n: number): string => String(v ?? '').trim().slice(0, n);

/** Validates and appends one item. Returns the stored (or already-stored duplicate) item. */
export function addFeedback(input: AddInput, opts: FeedbackOpts = {}): { item: FeedbackItem; duplicate: boolean } {
  const now = (opts.now ?? (() => new Date()))();
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text.length < MIN_TEXT) throw new FeedbackError(400, `feedback needs at least ${MIN_TEXT} characters`);
  if (text.length > MAX_TEXT) throw new FeedbackError(400, `feedback is limited to ${MAX_TEXT} characters`);
  const source = (input.source ?? 'cockpit') as FeedbackSource;
  if (!SOURCES.includes(source)) throw new FeedbackError(400, `source must be one of ${SOURCES.join(', ')}`);
  const by = clip(input.by, 64) || 'unknown';
  const page = input.page == null || input.page === '' ? null : clip(input.page, 200);
  const ref = input.ref == null || input.ref === '' ? null : clip(input.ref, 120);
  const key = keyOf(text);

  const all = list(opts);
  const dup = all.find((i) => (ref && i.source === source && i.ref === ref) || (i.key === key && i.by === by && now.getTime() - Date.parse(i.time) < DEDUPE_MS));
  if (dup) return { item: dup, duplicate: true };
  const recent = all.filter((i) => i.source === source && now.getTime() - Date.parse(i.time) < 3600_000).length;
  if (recent >= RATE_PER_HOUR) throw new FeedbackError(429, `too much feedback from ${source} in the last hour (limit ${RATE_PER_HOUR})`);

  const stamp = now.toISOString();
  const item: FeedbackItem = {
    v: 1, id: `fb-${stamp.slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`, time: stamp, source, by, text, page, ref, key,
    status: 'open', proposal: null, note: '',
  };
  mkdirSync(opts.dir ?? defaultDir(), { recursive: true });
  appendFileSync(feedbackPath(opts.dir), JSON.stringify(item) + '\n');
  return { item, duplicate: false };
}
