import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

// Cockpit started read-only. With chat and task creation it can now make Atlas act, so every /api request is
// checked. The threats are not network attackers (it binds to loopback and is published only on the tailnet)
// but web pages in your own browser:
//   - a page on another site posting to http://127.0.0.1:3200/api/chat   → blocked by the Origin check
//   - DNS rebinding (evil.example re-pointed at 127.0.0.1)                → blocked by the Host allow-list
//   - a "simple" cross-site form POST                                     → blocked: JSON content type required
// An optional shared token (COCKPIT_TOKEN) adds a second factor for anyone else who can reach the port.

export interface GuardOptions {
  /** Hostnames (no port) the dashboard may be reached by. */
  allowedHosts: string[];
  /** If set, writes must carry it in the x-cockpit-token header. */
  token?: string;
}

export type Verdict = { ok: true } | { ok: false; status: number; message: string };

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

export const hostnameOf = (hostHeader: string | undefined): string => (hostHeader ?? '').replace(/:\d+$/, '').toLowerCase();

/** Applies to every /api route, reads included: agent prompts and memory are not for rebinding attackers. */
export function checkHost(req: Pick<IncomingMessage, 'headers'>, opts: GuardOptions): Verdict {
  const host = hostnameOf(req.headers.host);
  const allowed = [...LOOPBACK, ...opts.allowedHosts.map((h) => h.toLowerCase())];
  return allowed.includes(host) ? { ok: true } : { ok: false, status: 403, message: `host "${host || '(none)'}" is not allowed; add it to allowedHosts in config/cockpit.json` };
}

export function checkWrite(req: Pick<IncomingMessage, 'headers' | 'method'>, opts: GuardOptions): Verdict {
  if (req.method !== 'POST') return { ok: false, status: 405, message: 'method not allowed' };
  const host = checkHost(req, opts);
  if (!host.ok) return host;

  const origin = req.headers.origin;
  if (!origin) return { ok: false, status: 403, message: 'missing Origin header' };
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return { ok: false, status: 403, message: 'bad Origin header' };
  }
  if (originHost !== String(req.headers.host ?? '').toLowerCase()) return { ok: false, status: 403, message: 'cross-origin request refused' };

  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return { ok: false, status: 415, message: 'content-type must be application/json' };

  if (opts.token) {
    const given = Buffer.from(String(req.headers['x-cockpit-token'] ?? ''));
    const want = Buffer.from(opts.token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, status: 401, message: 'missing or wrong access token' };
  }
  return { ok: true };
}

export class BodyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** JSON body with a hard size cap (a chat message or a task, never a file). */
export async function readJson(req: AsyncIterable<Buffer | string>, maxBytes = 32 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = typeof c === 'string' ? Buffer.from(c) : c;
    size += b.length;
    if (size > maxBytes) throw new BodyError(413, 'request body too large');
    chunks.push(b);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new BodyError(400, 'body must be a JSON object');
  }
}
