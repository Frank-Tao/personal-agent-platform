import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDir, liveConfig } from '../../packages/paths/paths.ts';
import { loadConfig, pythonSender, type Sender } from '../../packages/mailcopy/mailcopy.ts';
import { ANSWERS, CODE_HOURS, decideNow, issueCode, needKey, readSnoozes, type NeedAct } from '../../packages/needs/needs.ts';
import { root, type Ctx } from '../shared.ts';
import { scorecardOf } from './scorecard.ts';
import { allOutbox } from './outbox.ts';

/** Steps an approver agent released or refused for Frank in the last day: he sees each one, with its reason. */
const delegatedLines = (c: Ctx, now: number): string[] => { try { return allOutbox(c).map((x) => x.item).filter((i) => /\(delegated/.test(i.decided_by) && i.decided_at && now - Date.parse(i.decided_at) < 86_400_000).map((i) => `${i.status === 'denied' ? 'Refused' : 'Approved'} by ${i.decided_by.replace(/ \(delegated.*$/, '')}: ${i.kind} ${i.target} (${i.project}) — ${i.why ?? ''}`.slice(0, 300)); } catch { return []; } };
import { scorecardLines } from '../../packages/work/scorecard.ts';

const trustLines = (c: Ctx): string[] => { try { return scorecardLines(scorecardOf(c), 8); } catch { return []; } };

/**
 * work digest [--due] [--preview] [--apply]: the owner's daily message, on Telegram and by email. Up to five things to decide, worst first,
 * each with a one-time reply code ("yes K7Q2P4" / "no K7Q2P4") that Atlas turns into `work act`. Read from Cockpit's latest snapshot.
 *   --due     only if today's has not gone out and it is past the configured time (the work-watch job runs it every 10 minutes)
 *   --preview print it, issue no codes, send nothing
 * Settings (<data>/config/digest.json): { "person": "Frank", "at": "07:30", "max": 5, "url": "https://…:8443" }; the person's Telegram chat and
 * addresses come from config/mailcopy.json.
 */

interface Need { portfolioId: string; kind: string; severity: string; title: string; act?: NeedAct; mail?: unknown; task?: unknown }
interface DigestConfig { person: string; at: string; max: number; url: string | null; trustDay: number }
interface DigestState { day: string; text?: string; subject?: string; done: string[]; tries: number; error?: string | null; at?: string }

export interface DigestDeps { telegram?: (chat: string, text: string) => { ok: boolean; error?: string }; mail?: Sender }

export function loadDigestConfig(path: string): DigestConfig {
  let j: Partial<DigestConfig> = {};
  try { j = JSON.parse(readFileSync(path, 'utf8')) as Partial<DigestConfig>; } catch { /* defaults */ }
  return {
    person: typeof j.person === 'string' && j.person ? j.person : 'Frank',
    at: typeof j.at === 'string' && /^\d{2}:\d{2}$/.test(j.at) ? j.at : '07:30',
    max: Number.isInteger(j.max) && (j.max as number) > 0 && (j.max as number) <= 10 ? (j.max as number) : 5,
    url: typeof j.url === 'string' && /^https?:\/\//.test(j.url) ? j.url.replace(/\/$/, '') : null,
    // the weekly track record goes into one day's digest: 0 = Sunday … 1 = Monday (default), -1 = never
    trustDay: Number.isInteger((j as { trust_day?: unknown }).trust_day) && ((j as { trust_day: number }).trust_day >= -1 && (j as { trust_day: number }).trust_day <= 6) ? (j as { trust_day: number }).trust_day : 1,
  };
}

/** The needs list from Cockpit's latest snapshot (read-only; Cockpit refreshes it every few minutes). */
export function latestNeeds(dbPath: string): { needs: Need[]; at: string | null } {
  if (!existsSync(dbPath)) return { needs: [], at: null };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT body FROM snapshots ORDER BY ts DESC LIMIT 1').get() as { body: string } | undefined;
    if (!row) return { needs: [], at: null };
    const r = JSON.parse(row.body) as { needsYou?: Need[]; generatedAt?: string };
    return { needs: r.needsYou ?? [], at: r.generatedAt ?? null };
  } finally { db.close(); }
}

/** Command hints written for a terminal are noise in a message. */
const tidy = (t: string) => t.replace(/\s*\((?:work|npm|hermes|launchctl) [^)]*\)/g, '').replace(/\s+/g, ' ').trim();

export function composeDigest(o: { needs: Need[]; snoozed: Record<string, string>; max: number; url: string | null; day: Date; snapshotAt: string | null; now: number; code: (act: NeedAct, label: string) => string; trust?: string[]; delegated?: string[] }): { subject: string; text: string; count: number } {
  const open = o.needs.filter((n) => !o.snoozed[needKey(n)]);
  const decide = open.filter(decideNow).sort((a, b) => Number(!!b.act) - Number(!!a.act));   // the list is already worst first; answerable ones go first
  const fyi = open.length - decide.length;
  const top = decide.slice(0, o.max);
  const date = o.day.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  const lines: string[] = [];
  if (!top.length) lines.push(`Atlas · nothing needs you today — ${date}`, '', fyi ? `${fyi} item${fyi === 1 ? '' : 's'} for your information in Cockpit.` : 'All clear.');
  else {
    lines.push(`Atlas · ${decide.length} thing${decide.length === 1 ? '' : 's'} need${decide.length === 1 ? 's' : ''} you — ${date}`, '');
    top.forEach((n, i) => {
      lines.push(`${i + 1}. ${tidy(n.title).slice(0, 300)}`);
      if (n.act) { const code = o.code(n.act, tidy(n.title).slice(0, 120)); const w = ANSWERS[n.act.kind]; lines.push(`   → reply "yes ${code}" to ${w.yes.toLowerCase()} · "no ${code}" to ${w.no.toLowerCase()}`); }
      else lines.push('   → open Cockpit to answer');
    });
    if (decide.length > top.length) lines.push('', `+${decide.length - top.length} more in Cockpit.`);
    if (fyi) lines.push(`${fyi} more for your information.`);
    lines.push('', `Codes work once, for ${CODE_HOURS} hours. Reply here or to the email.`);
  }
  if (o.delegated?.length) lines.push('', 'Decided on your behalf by agents (last 24 h):', ...o.delegated.map((l) => '• ' + l));
  if (o.trust?.length) lines.push('', 'Track record, last 4 weeks (first time = passed without rework or you):', ...o.trust.map((l) => '• ' + l));
  if (o.url) lines.push(`Cockpit: ${o.url}/#/needs`);
  const age = o.snapshotAt ? (o.now - Date.parse(o.snapshotAt)) / 3_600_000 : null;
  if (age === null) lines.push('(Cockpit has no data yet.)'); else if (age > 2) lines.push(`(From Cockpit's data of ${Math.round(age)} h ago: Cockpit may be down.)`);
  return { subject: top.length ? `[Atlas] ${decide.length} thing${decide.length === 1 ? '' : 's'} need${decide.length === 1 ? 's' : ''} you — ${date}` : `[Atlas] Nothing needs you — ${date}`, text: lines.join('\n'), count: decide.length };
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const localHm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export function telegramSender(script: string, python = process.env.PYTHON || '/opt/homebrew/bin/python3', env: NodeJS.ProcessEnv = process.env) {
  return (chat: string, text: string) => {
    try { return JSON.parse(execFileSync(python, [script], { input: JSON.stringify({ chat, text }), encoding: 'utf8', timeout: 40_000, env }).trim().split('\n').pop() ?? '{}') as { ok: boolean; error?: string }; }
    catch (e) { const last = String((e as { stdout?: string }).stdout ?? '').trim().split('\n').pop() ?? ''; try { return JSON.parse(last) as { ok: boolean; error?: string }; } catch { return { ok: false, error: `telegram sender failed (${(e as Error).message.split('\n')[0].slice(0, 100)})` }; } }
  };
}

export function cmdDigest(c: Ctx, deps: DigestDeps = {}) {
  const data = dataDir(c.env);
  const cfg = loadDigestConfig(c.env.DIGEST_CONFIG ?? liveConfig('digest.json', c.env));
  const now = c.env.WORK_NOW ? new Date(c.env.WORK_NOW) : new Date();
  const statePath = join(data, 'digest-state.json');
  let state: DigestState = { day: '', done: [], tries: 0 };
  try { state = { ...state, ...(JSON.parse(readFileSync(statePath, 'utf8')) as DigestState) }; } catch { /* first run */ }
  const today = localDay(now);
  const preview = c.flags.get('preview') === true;
  if (c.flags.get('due') === true && !preview) {
    if (localHm(now) < cfg.at) return;                                   // quiet before the time
    if (state.day === today && (state.done.length >= 2 || state.tries >= 5)) return;
  }
  const people = loadConfig(c.env.MAILCOPY_CONFIG ?? liveConfig('mailcopy.json', c.env))?.people ?? {};
  const who = people[cfg.person];
  if (!who) throw new Error(`no "${cfg.person}" with a Telegram chat and email addresses in config/mailcopy.json`);

  // Today's message is composed once; a channel that failed gets the same text (and codes) on the next try.
  let { text, subject } = state.day === today && state.text ? { text: state.text, subject: state.subject ?? '[Atlas] Digest' } : { text: '', subject: '' };
  if (!text || preview) {
    const snap = latestNeeds(c.env.COCKPIT_DB ?? join(data, 'cockpit.sqlite'));
    const m = composeDigest({ needs: snap.needs, snoozed: readSnoozes(data, now.getTime()), max: cfg.max, url: cfg.url, day: now, snapshotAt: snap.at, now: now.getTime(),
      code: (act, label) => (preview || !c.apply ? 'XXXXXX' : issueCode(data, act, label, now.getTime())),
      trust: now.getDay() === cfg.trustDay || c.flags.get('trust') === true ? trustLines(c) : undefined,
      delegated: delegatedLines(c, now.getTime()) });
    text = m.text; subject = m.subject;
    if (!preview && c.apply) state = { day: today, text, subject, done: [], tries: 0 };
  }
  if (preview || !c.apply) { c.out(`to ${cfg.person}: Telegram ${who.telegram[0]} · ${who.emails.join(', ')}\nsubject: ${subject}\n\n${text}`); if (!preview) c.out('\n(dry run — add --apply)'); return; }

  const tg = deps.telegram ?? telegramSender(join(root, 'infra', 'bin', 'send-telegram.py'), c.env.PYTHON || undefined, { ...process.env, ...c.env });
  const mail = deps.mail ?? pythonSender(join(root, 'infra', 'bin', 'send-mail.py'), c.env.PYTHON || undefined, { ...process.env, ...c.env });
  const errors: string[] = [];
  if (!state.done.includes('telegram')) { const r = tg(who.telegram[0], text); if (r.ok) state.done.push('telegram'); else errors.push(`Telegram: ${r.error}`); }
  if (!state.done.includes('email')) { const r = mail({ to: who.emails, subject, body: text }); if (r.ok) state.done.push('email'); else errors.push(`email: ${r.error}`); }
  state.tries++; state.error = errors.join('; ') || null; state.at = now.toISOString();
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(state, null, 1)); renameSync(tmp, statePath);
  c.out(`digest: ${state.done.join(' + ') || 'nothing'} sent to ${cfg.person}${errors.length ? ` — ▲ ${errors.join('; ')}` : ''}`);
}
