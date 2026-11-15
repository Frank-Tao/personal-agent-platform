import { existsSync, readFileSync } from 'node:fs';
import { liveConfig } from '../paths/paths.ts';
import { findPii } from './redact.ts';

// "Is this message about something private?" Used to keep such messages away from cloud models: detected values (account numbers,
// tax file numbers, emails…) or an explicit private document/topic. Narrow on purpose: a false positive only means a local answer.

const TOPICS: Array<[string, RegExp]> = [
  ['bank-statement', /\b(bank|credit card|card|account) (statement|balance|transactions?)\b/i],
  ['payslip', /\b(pay ?slips?|salary|my (income|wage|earnings))\b/i],
  ['tax', /\b(tax return|tax file number|tfn|ato|group certificate|capital gains)\b/i],
  ['identity', /\b(passport|driver'?s? licen[cs]e|medicare (number|card)|visa (number|grant))\b/i],
  ['health', /\b(diagnos\w+|prescription|medical (record|history|report)|my (doctor|therapist|medication))\b/i],
  ['net-worth', /\b(net worth|my (mortgage|loan|super(annuation)?|savings) (balance|amount)|how much (do|did) (i|we) (owe|have|earn|spend))\b/i],
  ['legal-family', /\b(divorce|custody|will and testament|lawsuit|immigration case)\b/i],
];

export interface PrivacyVerdict { private: boolean; reasons: string[] }

/** Emails that are not private (config/privacy.json): exact addresses and whole domains. */
export interface EmailAllow { emails: string[]; domains: string[] }
const CONFIG = liveConfig('privacy.json');
let cached: { at: number; allow: EmailAllow } | null = null;
export function loadEmailAllow(path = CONFIG, ttlMs = 5000): EmailAllow {
  if (path === CONFIG && cached && Date.now() - cached.at < ttlMs) return cached.allow;
  let allow: EmailAllow = { emails: [], domains: [] };
  try {
    if (existsSync(path)) {
      const j = JSON.parse(readFileSync(path, 'utf8')) as { allowedEmails?: unknown; allowedEmailDomains?: unknown };
      const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase().replace(/^@/, '')).filter(Boolean) : []);
      allow = { emails: list(j.allowedEmails), domains: list(j.allowedEmailDomains) };
    }
  } catch { /* a broken file allows nothing: fail closed */ }
  if (path === CONFIG) cached = { at: Date.now(), allow };
  return allow;
}
export const isAllowedEmail = (email: string, allow: EmailAllow): boolean => {
  const e = email.toLowerCase(), domain = e.slice(e.lastIndexOf('@') + 1);
  return allow.emails.includes(e) || allow.domains.some((d) => domain === d || domain.endsWith('.' + d));
};
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Frank's explicit opt-in: a message that starts with this (any capitals; "share ok:" and "share_ok:" count too) may carry email addresses to a cloud model. */
export const SHARE_OK = /^\s*share[-_ ]?ok\s*:/i;

/** Reasons are kinds only (never the matched text). An allow-listed email counts for nothing, digits included. With the share-ok: tag, emails alone
 *  no longer make a message private; every other kind (tax, account, BSB, date of birth, identity, health…) still does. */
export function privacyCheck(text: string, allow: EmailAllow = loadEmailAllow()): PrivacyVerdict {
  const scanned = text.replace(EMAIL, (m) => (isAllowedEmail(m, allow) ? ' ' : m));
  let reasons = [...new Set([...findPii(scanned).map((h) => h.kind), ...TOPICS.filter(([, re]) => re.test(scanned)).map(([k]) => k)])];
  if (SHARE_OK.test(text)) reasons = reasons.filter((k) => k !== 'email');
  return { private: reasons.length > 0, reasons };
}
