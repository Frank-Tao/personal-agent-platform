import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Admin view: sees everything. No user management: a secret (COCKPIT_ADMIN_TOKEN in infra/env) is passed once as a URL parameter,
//   https://<cockpit>/?admin=<secret>      switch to Admin (a session cookie is set and the parameter is removed from the address bar)
//   https://<cockpit>/?admin=off           switch back to whoever the device says you are (Diane or Frank)
// Expiry: the secret and every session expire after 720 hours (30 days) without use. Each use pushes the date out again. Once expired,
// the secret is dead until a new one is made (`npm run admin-token -- new`), and nothing needs a restart.
// The cookie holds a signed timestamp, not the secret. Wrong guesses are limited per caller. Without a secret there is no admin.

export const IDLE_MS = 720 * 3600_000;
const RENEW_MS = 3600_000;                 // the cookie and the stored date are refreshed at most once an hour
const COOKIE = 'cockpit_admin';
const MAX_AGE = IDLE_MS / 1000;

export interface AdminStore { lastUsed(): number | null; touch(now: number): void }
export type TokenSource = () => string | undefined;

/** Last use, kept in a small file; before the first use the clock starts when the secret was written (the env file's date). */
export function fileStore(statePath: string, envPath?: string): AdminStore {
  return {
    lastUsed() {
      try { const n = Number(JSON.parse(readFileSync(statePath, 'utf8')).lastUsedAt); if (Number.isFinite(n)) return n; } catch { /* none yet */ }
      try { return envPath && existsSync(envPath) ? statSync(envPath).mtimeMs : null; } catch { return null; }
    },
    touch(now) { mkdirSync(dirname(statePath), { recursive: true }); writeFileSync(statePath, JSON.stringify({ lastUsedAt: now }), { mode: 0o600 }); },
  };
}

/** The secret, read from infra/env on every use (cached a few seconds) so a new one needs no restart; env var as fallback. */
export function fileTokenSource(envPath: string, fallback?: string, ttlMs = 3000): TokenSource {
  let at = 0, value: string | undefined;
  return () => {
    if (Date.now() - at < ttlMs) return value;
    at = Date.now();
    try { value = readFileSync(envPath, 'utf8').split('\n').map((l) => l.match(/^\s*COCKPIT_ADMIN_TOKEN=(.*)$/)?.[1]?.trim()).find((v) => v) || fallback; } catch { value = fallback; }
    return value || undefined;
  };
}

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const sign = (token: string, ts: number) => createHmac('sha256', token).update(`cockpit-admin|${ts}`).digest('hex');
const issue = (token: string, now: number, secure: string) => `${COOKIE}=${now}.${sign(token, now)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}${secure}`;
const secureFlag = (req: Pick<IncomingMessage, 'headers'>) => (String(req.headers['x-forwarded-proto'] ?? '') === 'https' ? '; Secure' : '');

export function tokenStatus(store: AdminStore, now = Date.now()): { lastUsedAt: number | null; expiresAt: number | null; expired: boolean } {
  const last = store.lastUsed();
  return { lastUsedAt: last, expiresAt: last === null ? null : last + IDLE_MS, expired: last !== null && now - last > IDLE_MS };
}

/** Is this request an Admin session? `renew` = send a fresh cookie (sliding expiry). Counts as a use of the secret. */
export function adminSession(req: Pick<IncomingMessage, 'headers'>, token: string | undefined, store: AdminStore, now = Date.now()): { ok: boolean; renew: boolean; cookie?: string } {
  if (!token || tokenStatus(store, now).expired) return { ok: false, renew: false };
  const m = String(req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  const [tsRaw, mac] = (m ? m.slice(COOKIE.length + 1) : '').split('.');
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || !mac || ts > now + 60_000 || now - ts > IDLE_MS || !same(mac, sign(token, ts))) return { ok: false, renew: false };
  const last = store.lastUsed();
  if (last === null || now - last > RENEW_MS) store.touch(now);
  const renew = now - ts > RENEW_MS;
  return { ok: true, renew, ...(renew ? { cookie: issue(token, now, secureFlag(req)) } : {}) };
}

const fails = new Map<string, { n: number; until: number }>();

/** Handles `?admin=…` on a page request. Returns true when it answered (redirect or refusal). */
export function handleAdminParam(req: IncomingMessage, res: ServerResponse, url: URL, token: string | undefined, store: AdminStore, now = Date.now()): boolean {
  if (!url.searchParams.has('admin')) return false;
  const value = url.searchParams.get('admin') ?? '';
  const secure = secureFlag(req);
  const who = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop()!.trim();
  const clean = new URL(url); clean.searchParams.delete('admin');
  const back = clean.pathname + (clean.search || '') + clean.hash;
  const done = (cookie: string) => { res.writeHead(302, { location: back || '/', 'set-cookie': cookie, 'cache-control': 'no-store' }); res.end(); return true; };
  const refuse = (msg: string) => { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); res.end(msg); return true; };
  if (value === 'off') return done(`${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  const f = fails.get(who);
  if (!token || (f && f.until > now)) return refuse('Admin view is not available.');
  if (!same(value, token)) { const n = (f?.n ?? 0) + 1; fails.set(who, { n, until: n >= 5 ? now + 5 * 60_000 : 0 }); return refuse('Admin view is not available.'); }
  if (tokenStatus(store, now).expired) return refuse('The admin token expired after 30 days without use. Make a new one on the Mac: npm run admin-token -- new');
  fails.delete(who);
  store.touch(now);
  return done(issue(token, now, secure));
}
