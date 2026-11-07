import { execFileSync } from 'node:child_process';
import type { IncomingMessage } from 'node:http';

// Who is looking at Cockpit? Cockpit is published on the tailnet with `tailscale serve`, which proxies each request from 127.0.0.1 and
// adds the caller's tailnet address as the LAST entry of X-Forwarded-For. That address is mapped to a device name (`tailscale whois`),
// and the device to a person. Hard-coded on purpose: the HP X360 is Diane, everything else is Frank, and Diane never sees the
// Investments portfolio. A request with no forwarded address came from this Mac itself (Frank). If the device cannot be resolved the
// viewer is treated as a restricted Guest (fail closed), never as Frank.

export interface Person {
  name: string;
  /** Portfolio (group) ids this person may not see, in any response. */
  hide: readonly string[];
  /** Device the request came from, when known (for display and logs). */
  device: string | null;
  /** Portfolios this person owns: only their needs-you items and notifications are shown. '*' = all (admin). Absent = no scoping. */
  owns?: readonly string[] | '*';
  /** Also gets items that belong to no portfolio (Atlas health, lanes, the machine itself). */
  system?: boolean;
  admin?: boolean;
}

// Ownership (hard-coded): Diane owns AI Thrival and Research; Frank owns MicroPace, Investments and Family.
const FRANK: Person = { name: 'Frank', hide: [], device: null, owns: ['micropace', 'investments', 'family'], system: true };
/** Used when no identity function is injected (tests, demo): sees everything. */
export const ANYONE: Person = FRANK;
const DIANE: Person = { name: 'Diane', hide: ['investments'], device: 'hp-x360', owns: ['ai-thrival', 'research'], system: false };
const GUEST: Person = { name: 'Guest', hide: ['investments'], device: null, owns: [], system: false };
const ADMIN: Person = { name: 'Admin', hide: [], device: null, owns: '*', system: true, admin: true };

/** Device (first DNS label, lower case) → person. Anything not listed is Frank. */
const DEVICE_PERSON: Record<string, Person> = { 'hp-x360': DIANE };
/** Tailnet addresses that are known without asking tailscaled (stable per device). */
const KNOWN_ADDRESS: Record<string, string> = { '100.102.99.110': 'hp-x360' };

/** device short name; null when the address is not on the tailnet; throws when tailscaled cannot be asked. */
export type Whois = (address: string) => string | null;

const IP = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{2,39}$/i;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function tailscaleWhois(bin = 'tailscale'): Whois {
  const cache = new Map<string, { at: number; device: string | null }>();
  return (address) => {
    const hit = cache.get(address);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.device;
    let device: string | null = null;
    try {
      const out = JSON.parse(execFileSync(bin, ['whois', '--json', address], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as { Node?: { Name?: string; ComputedName?: string } };
      const name = out.Node?.Name ?? out.Node?.ComputedName ?? '';
      device = name ? name.split('.')[0].toLowerCase() : null;
    } catch (e) {
      // "peer not found" exits non-zero as well; only a failure to run tailscale at all is an error. Both are not cached for long.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as { killed?: boolean }).killed) throw e;
      device = null;
    }
    cache.set(address, { at: Date.now(), device });
    return device;
  };
}

/** `admin` = the request carries the valid admin cookie (see admin.ts): sees everything, whatever device it comes from. */
export function resolveIdentity(req: Pick<IncomingMessage, 'headers' | 'socket'>, whois: Whois, admin = false): Person {
  if (admin) return { ...ADMIN, device: resolveDevice(req, whois) };
  return resolveViewer(req, whois);
}

function resolveDevice(req: Pick<IncomingMessage, 'headers' | 'socket'>, whois: Whois): string | null { return resolveViewer(req, whois).device; }

function resolveViewer(req: Pick<IncomingMessage, 'headers' | 'socket'>, whois: Whois): Person {
  const peer = req.socket?.remoteAddress ?? '';
  const raw = req.headers['x-forwarded-for'];
  const xff = (Array.isArray(raw) ? raw.join(',') : raw ?? '').trim();
  // Forwarded headers are only believed from the local tailscale proxy.
  if (xff && !LOOPBACK.has(peer)) return GUEST;
  if (!xff) return LOOPBACK.has(peer) || !peer ? { ...FRANK, device: 'this Mac' } : GUEST;
  const address = xff.split(',').pop()!.trim();   // the proxy appends the real caller last; earlier entries can be forged
  if (!IP.test(address)) return GUEST;
  let device: string | null = KNOWN_ADDRESS[address] ?? null;
  if (!device) {
    try { device = whois(address); } catch { return GUEST; }
  }
  if (!device) return GUEST;                       // an address tailscale does not know: not one of ours
  const person = DEVICE_PERSON[device];
  return person ?? { ...FRANK, device };
}
