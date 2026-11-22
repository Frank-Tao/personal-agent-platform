import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { privacyCheck } from '../redact/topics.ts';

// What a project actually delivered, in the words of whoever handed it over: a summary, where to open it, how to start it, and the documents to read.
// One small JSON file per project under <kb>/<portfolio>/delivery/. Cockpit's "Delivered" panel shows it next to the evidence it finds by itself
// (task attachments such as screenshots and reports). Closing a project asks for it, so "done" always comes with something to look at.

export interface Delivery {
  summary: string;
  /** Where to open the result, when it is a web page or app (http or https). */
  url: string | null;
  /** How to start it if it does not run by itself. */
  start: string | null;
  docs: Array<{ title: string; url: string }>;
  notes: string | null;
  by: string;
  at: string;
}

export class DeliveryError extends Error {}

export const deliveryPath = (kb: string, portfolio: string, project: string): string => join(kb, portfolio, 'delivery', `${project}.json`);

const one = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const HTTP = /^https?:\/\/[^\s]+$/i;

/** https://github.com/owner/repo/blob/main/<path> from a remote URL (https or ssh form) and a path inside the repo; null when it is not a GitHub remote. */
export function repoFileUrl(remote: string, path: string, branch = 'main'): string | null {
  const m = remote.trim().match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/blob/${branch}/${path.replace(/^\/+/, '')}`;
}

export interface DeliveryInput { summary: string; url?: string; start?: string; docs?: Array<{ title: string; url: string }>; notes?: string; by?: string; at: string }

export function makeDelivery(i: DeliveryInput): Delivery {
  const summary = one(i.summary, 700);
  if (summary.length < 12) throw new DeliveryError('say what was delivered (a sentence or two)');
  const url = one(i.url, 300) || null;
  if (url && !HTTP.test(url)) throw new DeliveryError('the address must start with http:// or https://');
  const docs = (i.docs ?? []).slice(0, 12).map((d) => ({ title: one(d.title, 80), url: one(d.url, 400) }));
  for (const d of docs) if (!d.title || !HTTP.test(d.url)) throw new DeliveryError(`document "${d.title || d.url}" needs a title and an http(s) address`);
  const out: Delivery = { summary, url, start: one(i.start, 300) || null, docs, notes: one(i.notes, 700) || null, by: one(i.by || 'unknown', 60), at: i.at };
  const verdict = privacyCheck([out.summary, out.start, out.notes, ...docs.map((d) => d.title)].filter(Boolean).join('\n'));
  if (verdict.private) throw new DeliveryError(`this looks private (${verdict.reasons.join(', ')}); it was not saved. Describe the result without personal details`);
  return out;
}

export function readDelivery(kb: string, portfolio: string, project: string): Delivery | null {
  try {
    const j = JSON.parse(readFileSync(deliveryPath(kb, portfolio, project), 'utf8')) as Partial<Delivery>;
    if (!j || typeof j.summary !== 'string') return null;
    return { summary: j.summary, url: j.url ?? null, start: j.start ?? null, docs: Array.isArray(j.docs) ? j.docs : [], notes: j.notes ?? null, by: j.by ?? '', at: j.at ?? '' };
  } catch { return null; }
}

export function writeDelivery(kb: string, portfolio: string, project: string, d: Delivery): string {
  const path = deliveryPath(kb, portfolio, project);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n');
  renameSync(tmp, path);
  return path;
}
