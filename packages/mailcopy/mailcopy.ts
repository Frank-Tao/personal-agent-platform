import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Email copies of what Hermes jobs send to Telegram. A job's output is saved by Hermes (cron/output/<job>/<time>.md, with the text it sent
// under "## Response"); this finds the outputs of jobs that deliver to Telegram, works out WHICH PERSON that Telegram chat belongs to, and
// mails that person's addresses a copy. It reads Hermes' files and writes nothing there; the mailbox password stays in Hermes' env file
// and is only ever read by infra/bin/send-mail.py.
//
// Who gets what is decided by the chat the Telegram message went to (not by the job's name): chat 1 is Diane, so her two addresses.
// The people, their chats and their addresses live in <data>/config/mailcopy.json (state, not code: it has personal addresses):
//   { "people": { "Diane": { "telegram": ["<chat id>"], "emails": ["a@x", "b@y"] }, "Frank": { … } },
//     "exclude": ["a job name that must not be copied"] }

export interface Person { telegram: string[]; emails: string[]; allowedJobs?: string[] }
export interface MailcopyConfig { people: Record<string, Person>; exclude?: string[] }
export interface JobRef { profile: string; home: string; id: string; name: string; deliver: string; enabled: boolean }
export interface Copy { key: string; job: JobRef; file: string; person: string; to: string[]; subject: string; body: string }
export interface State { since: string; sent: Record<string, string>; failed: Record<string, { n: number; error: string }> }
export interface Mail { to: string[]; subject: string; body: string }
export type Sender = (m: Mail) => { ok: boolean; error?: string };

export const SETTLE_SECONDS = 20;     // an output still being written is left for the next run
export const MAX_PER_RUN = 12;
export const GIVE_UP_AFTER = 5;

export function loadConfig(path: string): MailcopyConfig | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as MailcopyConfig;
    const people: Record<string, Person> = {};
    for (const [name, p] of Object.entries(j.people ?? {})) {
      const telegram = (p.telegram ?? []).map(String).filter((x) => /^-?\d{4,20}$/.test(x));
      const emails = (p.emails ?? []).filter((e) => typeof e === 'string' && /^[^@\s,;<>]+@[^@\s,;<>]+\.[A-Za-z]{2,}$/.test(e));
      if (telegram.length && emails.length) {
        const person: Person = { telegram, emails };
        if (Object.hasOwn(p, 'allowedJobs')) {
          const allowed = p.allowedJobs;
          person.allowedJobs = Array.isArray(allowed) && allowed.every((token) => typeof token === 'string' && /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(token)) ? allowed : [];
        }
        people[name] = person;
      }
    }
    return Object.keys(people).length ? { people, exclude: (j.exclude ?? []).map(String) } : null;
  } catch { return null; }
}

/** Every job of every Hermes profile (the default one and profiles/*). */
export function listJobs(hermesHome: string): JobRef[] {
  const homes: Array<{ profile: string; home: string }> = [{ profile: 'default', home: hermesHome }];
  try { for (const d of readdirSync(join(hermesHome, 'profiles'), { withFileTypes: true })) if (d.isDirectory()) homes.push({ profile: d.name, home: join(hermesHome, 'profiles', d.name) }); } catch { /* no profiles */ }
  const out: JobRef[] = [];
  for (const h of homes) {
    try {
      const raw = JSON.parse(readFileSync(join(h.home, 'cron', 'jobs.json'), 'utf8')) as { jobs?: unknown[] } | unknown[];
      const jobs = (Array.isArray(raw) ? raw : raw.jobs ?? []) as Array<Record<string, unknown>>;
      for (const j of jobs) out.push({ ...h, id: String(j.id), name: String(j.name ?? j.id), deliver: String(j.deliver ?? 'local'), enabled: j.enabled !== false });
    } catch { /* no jobs file */ }
  }
  return out;
}

/** The Telegram chat a profile's "home" delivery goes to (its .env, else its config.yaml). */
export function homeChannel(home: string): string | null {
  for (const f of ['.env', 'config.yaml']) {
    try { const m = readFileSync(join(home, f), 'utf8').match(/^\s*TELEGRAM_HOME_CHANNEL\s*[:=]\s*['"]?(-?\d+)/m); if (m) return m[1]; } catch { /* next */ }
  }
  return null;
}

/** The Telegram chats a job delivers to: `telegram` is the profile's home channel, `telegram:<chat>[:<thread>]` a chat. Other platforms are not copied. */
export function telegramChats(job: JobRef, home: (h: string) => string | null = homeChannel): string[] {
  const chats = new Set<string>();
  for (const raw of job.deliver.split(',')) {
    const part = raw.trim().toLowerCase();
    if (part === 'telegram') { const c = home(job.home); if (c) chats.add(c); }
    else if (part.startsWith('telegram:')) { const c = part.slice(9).split(':')[0]; if (/^-?\d+$/.test(c)) chats.add(c); }
  }
  return [...chats];
}

/** The text Hermes sent: everything under "## Response". */
export function responseOf(output: string): string {
  const i = output.search(/^## Response\s*$/m);
  return i < 0 ? '' : output.slice(i).replace(/^## Response\s*\n/, '').trim();
}

const dateOf = (file: string) => (file.match(/^(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? '';

export interface Scan { copies: Copy[]; unmapped: string[]; skipped: number }

/** Copies still to send: outputs newer than `state.since`, not sent yet, of jobs that deliver to a mapped Telegram chat. */
export function pendingCopies(hermesHome: string, cfg: MailcopyConfig, state: State, nowMs: number, home: (h: string) => string | null = homeChannel): Scan {
  const copies: Copy[] = [], unmapped = new Set<string>(), seen = new Set<string>();
  let skipped = 0;
  const since = Date.parse(state.since);
  for (const job of listJobs(hermesHome)) {
    if (!job.enabled || (cfg.exclude ?? []).includes(job.name)) continue;
    const chats = telegramChats(job, home);
    if (!chats.length) continue;
    const eligible: Array<[string, Person]> = [];
    for (const chat of chats) {
      const who = Object.entries(cfg.people).find(([, p]) => p.telegram.includes(chat));
      if (!who) { unmapped.add(`${job.name} → chat ${chat}`); continue; }
      if (who[1].allowedJobs !== undefined && !who[1].allowedJobs.includes(`${job.profile}/${job.id}`)) continue;
      eligible.push(who);
    }
    if (!eligible.length) continue;
    const dir = join(job.home, 'cron', 'output', job.id);
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { continue; }
    for (const f of files) {
      const base = `${job.profile}/${job.id}/${f}`;
      let st; try { st = statSync(join(dir, f)); } catch { continue; }
      if (st.mtimeMs < since || nowMs - st.mtimeMs < SETTLE_SECONDS * 1000) continue;
      const body = responseOf(readFileSync(join(dir, f), 'utf8'));
      if (!body || /^\[SILENT\]$/.test(body)) { skipped++; continue; }       // nothing was sent to Telegram either
      for (const who of eligible) {
        const key = `${base}#${who[0]}`;                                   // one record per output and person
        if (seen.has(key) || state.sent[key] || (state.failed[key]?.n ?? 0) >= GIVE_UP_AFTER) continue;
        seen.add(key);
        const failed = /^\[CRON_FAILURE\]/.test(body);
        copies.push({ key, job, file: f, person: who[0], to: who[1].emails, subject: `[Atlas]${failed ? ' FAILED:' : ''} ${job.name} — ${dateOf(f)}`.slice(0, 180), body: `${body}\n\n—\nCopy of what Atlas sent to ${who[0]} on Telegram (job "${job.name}", ${f.replace('.md', '').replace('_', ' ')}).` });
      }
    }
  }
  return { copies, unmapped: [...unmapped], skipped };
}

export interface RunResult { sent: number; failed: number; skipped: number; pending: number; unmapped: string[]; lastError: string | null }

export function emptyState(now: Date): State { return { since: now.toISOString(), sent: {}, failed: {} }; }

export function readState(path: string, now: Date): { state: State; fresh: boolean } {
  try { const s = JSON.parse(readFileSync(path, 'utf8')) as State; return { state: { since: s.since, sent: s.sent ?? {}, failed: s.failed ?? {} }, fresh: false }; } catch { return { state: emptyState(now), fresh: true }; }
}
export function writeState(path: string, s: State): void {
  mkdirSync(dirname(path), { recursive: true });
  // keep the record bounded: what was sent more than 60 days ago can no longer match a file Hermes still has
  const cutoff = Date.now() - 60 * 86_400_000;
  for (const [k, v] of Object.entries(s.sent)) if (Date.parse(v) < cutoff) delete s.sent[k];
  const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(s, null, 1)); renameSync(tmp, path);
}

/** One pass: send what is pending. `apply: false` only reports. A copy that fails is retried on the next pass, five times in all. */
export function runMailcopy(o: { hermesHome: string; cfg: MailcopyConfig; state: State; now: Date; send: Sender; apply: boolean; home?: (h: string) => string | null }): RunResult {
  const scan = pendingCopies(o.hermesHome, o.cfg, o.state, o.now.getTime(), o.home);
  const todo = scan.copies.slice(0, MAX_PER_RUN);
  let sent = 0, failed = 0, lastError: string | null = null;
  if (o.apply) {
    for (const c of todo) {
      const r = o.send({ to: c.to, subject: c.subject, body: c.body });
      if (r.ok) { sent++; o.state.sent[c.key] = o.now.toISOString(); delete o.state.failed[c.key]; }
      else { failed++; lastError = r.error ?? 'send failed'; const f = o.state.failed[c.key] ?? { n: 0, error: '' }; o.state.failed[c.key] = { n: f.n + 1, error: lastError }; }
    }
  }
  return { sent, failed, skipped: scan.skipped, pending: scan.copies.length - (o.apply ? sent : 0), unmapped: scan.unmapped, lastError };
}

/** The real sender: infra/bin/send-mail.py, which reads the mailbox settings itself. */
export function pythonSender(script: string, python = process.env.PYTHON || '/opt/homebrew/bin/python3', env: NodeJS.ProcessEnv = process.env): Sender {
  return (m) => {
    if (!existsSync(script)) return { ok: false, error: 'send-mail.py is missing' };
    try {
      const out = execFileSync(python, [script], { input: JSON.stringify(m), encoding: 'utf8', timeout: 60_000, env });
      return JSON.parse(out.trim().split('\n').pop() ?? '{}') as { ok: boolean; error?: string };
    } catch (e) {
      const stdout = String((e as { stdout?: string }).stdout ?? '').trim().split('\n').pop() ?? '';
      try { const j = JSON.parse(stdout) as { ok: boolean; error?: string }; if (j.error) return j; } catch { /* not JSON */ }
      return { ok: false, error: `mail sender failed (${(e as Error).message.split('\n')[0].slice(0, 100)})` };
    }
  };
}
