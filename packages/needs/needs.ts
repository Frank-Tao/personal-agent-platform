import { createHash, pbkdf2Sync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// What a Needs-you item asks for, as data: the page shows buttons for it, the daily digest gives it a reply code, and `work act`
// carries it out. Two more things live here because Cockpit and the work CLI both use them: snoozing an item, and the one-time codes.

export type ActKind = 'approve-charter' | 'auto-start' | 'close-project' | 'resume-project' | 'outbox' | 'mail' | 'decisions';
export interface NeedAct { kind: ActKind; project?: string; id?: string; refs?: string[] }
export const ACT_KINDS: ActKind[] = ['approve-charter', 'auto-start', 'close-project', 'resume-project', 'outbox', 'mail', 'decisions'];

/** What "yes" and "no" mean for each kind, in the words the page and the digest use. "Not now" snoozes the item for a day. */
export const ANSWERS: Record<ActKind, { yes: string; no: string }> = {
  'approve-charter': { yes: 'Approve', no: 'Not now' },
  'auto-start': { yes: 'Start now', no: 'Stop: make it semi' },
  'close-project': { yes: 'Mark done', no: 'Not now' },
  'resume-project': { yes: 'Resume', no: 'Not now' },
  outbox: { yes: 'Release', no: 'Deny' },
  mail: { yes: 'Send', no: 'Deny' },
  decisions: { yes: 'Confirm all', no: 'Not now' },
};

const SLUG = /^[a-z][a-z0-9-]{1,47}$/;
const REF = /^[a-z][a-z0-9-]*\/(_portfolio|[a-z][a-z0-9-]{0,47})\/D\d{1,5}$/;

/** A NeedAct from untrusted input (a request body, a stored code), or null. */
export function cleanAct(v: unknown): NeedAct | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const kind = String(o.kind ?? '') as ActKind;
  if (!ACT_KINDS.includes(kind)) return null;
  if (['approve-charter', 'auto-start', 'close-project', 'resume-project'].includes(kind)) return SLUG.test(String(o.project ?? '')) ? { kind, project: String(o.project) } : null;
  if (kind === 'mail') return /^m-\d{8}-\d{6}-[0-9a-f]{4}$/.test(String(o.id ?? '')) ? { kind, id: String(o.id) } : null;
  if (kind === 'outbox') return /^[a-z0-9][a-z0-9-]{3,63}$/.test(String(o.id ?? '')) ? { kind, id: String(o.id) } : null;
  const refs = Array.isArray(o.refs) ? o.refs.map(String).filter((r) => REF.test(r)).slice(0, 50) : [];
  return refs.length ? { kind, refs } : null;
}

/** A stable key for an item, so a snooze survives the item being rebuilt on every refresh. */
export function needKey(n: { act?: NeedAct; kind: string; portfolioId: string; title: string }): string {
  // decisions: one item per project ledger, whatever entries it holds today
  if (n.act) return `${n.act.kind}:${n.act.project ?? n.act.id ?? (n.act.refs?.[0] ?? '').replace(/\/D\d+$/, '').replace('/', ':')}`;
  // titles carry live numbers ("3 failed", "for 47 minutes"): drop digits so the key stays the same
  return `${n.kind}:${n.portfolioId}:${createHash('sha256').update(n.title.replace(/\d+/g, '#')).digest('hex').slice(0, 16)}`;
}

/** "Decide now" (it asks for an answer) or "for your information". */
export const decideNow = (n: { act?: NeedAct; kind: string; severity: string; task?: unknown; mail?: unknown }): boolean =>
  !!n.act || !!n.mail || !!n.task || n.kind === 'approval' || n.severity === 'alert';

/* ---------- snooze: <data>/needs-snooze.json { key: until ISO } ---------- */

const snoozePath = (data: string) => join(data, 'needs-snooze.json');
function writeJson(path: string, v: unknown) { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(v, null, 1)); renameSync(tmp, path); }

export function readSnoozes(data: string, now = Date.now()): Record<string, string> {
  try {
    const all = JSON.parse(readFileSync(snoozePath(data), 'utf8')) as Record<string, string>;
    return Object.fromEntries(Object.entries(all).filter(([, until]) => Date.parse(until) > now));
  } catch { return {}; }
}
export function snooze(data: string, key: string, days: number, now = Date.now()): string {
  if (!/^[a-z-]+:[A-Za-z0-9:_-]{1,120}$/.test(key)) throw new Error('bad item key');
  const until = new Date(now + Math.min(30, Math.max(0, days)) * 86_400_000).toISOString();
  const all = readSnoozes(data, now);
  if (days <= 0) delete all[key]; else all[key] = until;
  writeJson(snoozePath(data), all);
  return until;
}

/* ---------- one-time reply codes: <data>/reply-codes.json ----------
 * A code is printed only in the message sent to the owner. Only a slow salted hash is kept, so whoever reads the file (an agent runs as the
 * same macOS user) cannot work a code out from it; a code works once, for one item, for 48 hours, and five wrong codes in an hour lock all codes out. */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';     // no 0/O, 1/I/L
export const CODE_LEN = 6;
export const CODE_HOURS = 48;
const ITER = 20_000;
interface StoredCode { salt: string; hash: string; act: NeedAct; label: string; issued: string; expires: string; used?: string }
interface CodeFile { codes: StoredCode[]; failures: string[] }
const codesPath = (data: string) => join(data, 'reply-codes.json');
const hashOf = (code: string, salt: string) => pbkdf2Sync(code, Buffer.from(salt, 'hex'), ITER, 32, 'sha256').toString('hex');

function readCodes(data: string, now: number): CodeFile {
  try {
    const f = JSON.parse(readFileSync(codesPath(data), 'utf8')) as CodeFile;
    return { codes: (f.codes ?? []).filter((c) => Date.parse(c.expires) > now - 7 * 86_400_000), failures: (f.failures ?? []).filter((t) => Date.parse(t) > now - 3_600_000) };
  } catch { return { codes: [], failures: [] }; }
}

export function issueCode(data: string, act: NeedAct, label: string, now = Date.now()): string {
  const code = Array.from({ length: CODE_LEN }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  const salt = randomBytes(16).toString('hex');
  const f = readCodes(data, now);
  f.codes.push({ salt, hash: hashOf(code, salt), act, label: label.slice(0, 200), issued: new Date(now).toISOString(), expires: new Date(now + CODE_HOURS * 3_600_000).toISOString() });
  writeJson(codesPath(data), f);
  return code;
}

export class CodeError extends Error {}

/** The item a code stands for; marks it used. Throws CodeError with a reason a person can act on. */
export function redeemCode(data: string, raw: string, now = Date.now()): { act: NeedAct; label: string } {
  const code = raw.trim().toUpperCase();
  const f = readCodes(data, now);
  if (f.failures.length >= 5) throw new CodeError('too many wrong codes in the last hour; codes are locked for now (use Cockpit)');
  const hit = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`).test(code) ? f.codes.find((c) => timingSafeEqual(Buffer.from(c.hash, 'hex'), Buffer.from(hashOf(code, c.salt), 'hex'))) : undefined;
  if (!hit) { f.failures.push(new Date(now).toISOString()); writeJson(codesPath(data), f); throw new CodeError(`"${raw.trim().slice(0, 12)}" is not a valid code`); }
  if (hit.used) throw new CodeError(`that code was already used (${hit.label})`);
  if (Date.parse(hit.expires) <= now) throw new CodeError(`that code has expired (${hit.label}); use Cockpit or wait for the next digest`);
  hit.used = new Date(now).toISOString();
  writeJson(codesPath(data), f);
  const act = cleanAct(hit.act);
  if (!act) throw new CodeError('that code is damaged');
  return { act, label: hit.label };
}
