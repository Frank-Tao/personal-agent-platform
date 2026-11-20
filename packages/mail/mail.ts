import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { privacyCheck, type EmailAllow } from '../redact/topics.ts';

// Agents send email from the Atlas mailbox (work mail send). The rule, in code rather than in a prompt:
//   • every recipient is on the allow-list, the text does not look private, and the hourly limit is not reached → sent now
//   • anything else → held as a draft; it goes out only when a person releases it (Cockpit Needs-you, or `work mail release`)
// The mailbox password is never read here: infra/bin/send-mail.py reads it from Hermes' env file when it sends.
//
// Allow-list = EMAIL_ALLOWED_USERS in Hermes' env file (the people allowed to write to Atlas)
//            + every address in config/mailcopy.json (the people job copies go to)
//            + config/mail.json { "allowed_emails": [], "allowed_domains": ["aithrival.com"], "max_per_hour": 20 }

export interface MailPolicy { emails: string[]; domains: string[]; maxPerHour: number }
export interface MailRequest { to: string[]; subject: string; body: string; by: string; project: string | null }
export interface MailVerdict { status: 'send' | 'held'; reasons: string[] }
export interface HeldMail extends MailRequest { id: string; created: string; reasons: string[]; status: 'held' | 'sent' | 'denied' | 'failed'; decided_by?: string; decided_at?: string; result?: string }
export interface LogEntry { at: string; id: string; by: string; project: string | null; to: string[]; subject: string; status: 'sent' | 'held' | 'failed' | 'released' | 'denied'; reason?: string; bytes: number }

export const DEFAULT_MAX_PER_HOUR = 20;
export const MAX_RECIPIENTS = 10;
export const MAX_BODY = 100_000;
const ADDRESS = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[A-Za-z]{2,}$/;
export const MAIL_ID = /^m-\d{8}-\d{6}-[0-9a-f]{4}$/;

const lower = (xs: unknown[]): string[] => xs.map((x) => String(x).trim().toLowerCase().replace(/^@/, '')).filter(Boolean);

export function loadPolicy(o: { hermesEnv: string; mailcopy: string; mailConfig: string }): MailPolicy {
  const emails = new Set<string>(), domains = new Set<string>();
  let maxPerHour = DEFAULT_MAX_PER_HOUR;
  try {
    const m = readFileSync(o.hermesEnv, 'utf8').match(/^\s*EMAIL_ALLOWED_USERS\s*=\s*['"]?([^'"\n]*)/m);   // only this key is read
    if (m) for (const e of lower(m[1].split(','))) if (ADDRESS.test(e)) emails.add(e);
  } catch { /* no env file: nobody from there */ }
  try {
    const j = JSON.parse(readFileSync(o.mailcopy, 'utf8')) as { people?: Record<string, { emails?: unknown[] }> };
    for (const p of Object.values(j.people ?? {})) for (const e of lower(p.emails ?? [])) if (ADDRESS.test(e)) emails.add(e);
  } catch { /* not set up */ }
  try {
    const j = JSON.parse(readFileSync(o.mailConfig, 'utf8')) as { allowed_emails?: unknown[]; allowed_domains?: unknown[]; max_per_hour?: unknown };
    for (const e of lower(j.allowed_emails ?? [])) if (ADDRESS.test(e)) emails.add(e);
    for (const d of lower(j.allowed_domains ?? [])) if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) domains.add(d);
    const n = Number(j.max_per_hour); if (Number.isInteger(n) && n >= 0 && n <= 500) maxPerHour = n;
  } catch { /* defaults */ }
  return { emails: [...emails].sort(), domains: [...domains].sort(), maxPerHour };
}

export const isAllowed = (addr: string, p: MailPolicy): boolean => {
  const a = addr.toLowerCase(), dom = a.slice(a.lastIndexOf('@') + 1);
  return p.emails.includes(a) || p.domains.some((d) => dom === d || dom.endsWith('.' + d));
};

/** Throws on a request that cannot be sent at all (bad address, empty text …). */
export function validate(r: MailRequest): void {
  if (!r.to.length) throw new Error('--to needs at least one address');
  if (r.to.length > MAX_RECIPIENTS) throw new Error(`at most ${MAX_RECIPIENTS} recipients`);
  for (const a of r.to) if (!ADDRESS.test(a)) throw new Error(`"${a}" is not an email address`);
  if (!r.subject.trim()) throw new Error('--subject is required');
  if (/[\r\n]/.test(r.subject) || r.subject.length > 200) throw new Error('the subject must be one line of at most 200 characters');
  if (!r.body.trim()) throw new Error('the body is empty');
  if (r.body.length > MAX_BODY) throw new Error(`the body is over ${MAX_BODY} characters`);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(r.by)) throw new Error('--by must be your roster id (atlas, pm, growth …)');
}

export function decideMail(r: MailRequest, p: MailPolicy, sentLastHour: number): MailVerdict {
  const reasons: string[] = [];
  const outside = r.to.filter((a) => !isAllowed(a, p));
  if (outside.length) reasons.push(`not on the allow-list: ${outside.join(', ')}`);
  // allowed addresses are not "private"; every other kind (account numbers, tax, health …) is
  const allow: EmailAllow = { emails: p.emails, domains: p.domains };
  const pv = privacyCheck(`${r.subject}\n${r.body}`, allow);
  if (pv.private) reasons.push(`looks private (${pv.reasons.join(', ')})`);
  if (sentLastHour >= p.maxPerHour) reasons.push(`${sentLastHour} sent in the last hour (limit ${p.maxPerHour})`);
  return { status: reasons.length ? 'held' : 'send', reasons };
}

/* ---------- the mail folder: <data>/mail/{held/<id>.json, log.jsonl} ---------- */

export const mailDir = (data: string) => join(data, 'mail');
const heldDir = (data: string) => join(mailDir(data), 'held');
const logPath = (data: string) => join(mailDir(data), 'log.jsonl');

export function newMailId(now: Date): string {
  const s = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `m-${s}-${randomBytes(2).toString('hex')}`;
}

export function appendLog(data: string, e: LogEntry): void {
  mkdirSync(mailDir(data), { recursive: true });
  appendFileSync(logPath(data), JSON.stringify(e) + '\n');
}

export function readLog(data: string): LogEntry[] {
  try { return readFileSync(logPath(data), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as LogEntry]; } catch { return []; } }); } catch { return []; }
}

export const sentSince = (data: string, sinceMs: number): number => readLog(data).filter((e) => (e.status === 'sent' || e.status === 'released') && Date.parse(e.at) >= sinceMs).length;

export function saveHeld(data: string, m: HeldMail): void {
  if (!MAIL_ID.test(m.id)) throw new Error('bad mail id');
  mkdirSync(heldDir(data), { recursive: true });
  const f = join(heldDir(data), `${m.id}.json`), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 1)); renameSync(tmp, f);
}

export function readHeld(data: string, id: string): HeldMail {
  if (!MAIL_ID.test(id)) throw new Error(`"${id}" is not a mail id (m-YYYYMMDD-HHMMSS-xxxx)`);
  const f = join(heldDir(data), `${id}.json`);
  if (!existsSync(f)) throw new Error(`no held mail "${id}" (see: work mail list)`);
  return JSON.parse(readFileSync(f, 'utf8')) as HeldMail;
}

export function listHeld(data: string, all = false): HeldMail[] {
  let files: string[] = [];
  try { files = readdirSync(heldDir(data)).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  return files.flatMap((f) => { try { return [JSON.parse(readFileSync(join(heldDir(data), f), 'utf8')) as HeldMail]; } catch { return []; } })
    .filter((m) => all || m.status === 'held');
}

/** Approval must come from a person: refuse when called from inside a Hermes agent session (a guard against an agent releasing its own mail;
 *  it is a speed bump, not a wall: agents run as the same macOS user). */
export function insideAgent(env: NodeJS.ProcessEnv): boolean {
  return ['HERMES_SESSION_KEY', 'HERMES_GATEWAY_SESSION', 'HERMES_EXEC_ASK', 'HERMES_SESSION_PLATFORM', 'HERMES_KANBAN_TASK'].some((k) => !!env[k]);
}
