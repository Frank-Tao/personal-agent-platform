import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';

// Who is looking at Cockpit? Cockpit is published on the tailnet with `tailscale serve`, which proxies each request from 127.0.0.1 and
// adds the caller's tailnet address as the LAST entry of X-Forwarded-For. That address is mapped to a device name (`tailscale whois`),
// and the device to a person. Who has their own view is listed under `people` in config/cockpit.json (default: the HP X360 is Diane,
// who never sees the Investments portfolio); every other tailnet device is Frank. A request with no forwarded address came from this Mac itself (Frank). If the device cannot be resolved the
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
  /** An unknown device: also loses the tool links and the Hermes dashboard link. */
  guest?: boolean;
}

// Visibility: everyone sees every portfolio, task and notification except that Diane never sees Investments. A Guest (an
// unknown device) sees almost nothing. `owns` scoping still exists for a person who has it (Guest, Admin '*'); Frank and Diane have none.
const FRANK: Person = { name: 'Frank', hide: [], device: null, system: true };
/** Used when no identity function is injected (tests, demo): sees everything. */
export const ANYONE: Person = FRANK;
const GUEST: Person = { name: 'Guest', hide: ['investments'], device: null, owns: [], system: false, guest: true };
const ADMIN: Person = { name: 'Admin', hide: [], device: null, owns: '*', system: true, admin: true };

/** A named person with their own view, from `people` in config/cockpit.json: the devices (first DNS label) and tailnet addresses they
 *  use, and the portfolios they never see. A tailnet device that is not listed is Frank; a device tailscale does not know is a Guest.
 *  That last rule is not configurable: nothing in the config can turn an unknown device into a person. */
export interface PersonConfig { name: string; devices: string[]; addresses: string[]; hide: string[] }

/** Used when config/cockpit.json has no `people` list. */
export const DEFAULT_PEOPLE: readonly PersonConfig[] = [{ name: 'Diane', devices: ['hp-x360'], addresses: ['100.102.99.110'], hide: ['investments'] }];

export interface People {
  /** Device (first DNS label, lower case) → person. */
  byDevice: Record<string, Person>;
  /** Tailnet addresses that are known without asking tailscaled (stable per device) → device. */
  deviceOfAddress: Record<string, string>;
}

export function buildPeople(list: readonly PersonConfig[] = DEFAULT_PEOPLE): People {
  const byDevice: Record<string, Person> = {}, deviceOfAddress: Record<string, string> = {};
  for (const p of list) {
    const devices = p.devices.map((d) => d.toLowerCase());
    if (!devices.length) continue;
    for (const d of devices) byDevice[d] = { name: p.name, hide: [...p.hide], device: d, system: true };
    for (const a of p.addresses) deviceOfAddress[a] = devices[0];
  }
  return { byDevice, deviceOfAddress };
}

const DEFAULT = buildPeople();

/** device short name; null when the address is not on the tailnet; throws (or rejects) when tailscaled cannot be asked. */
export type Whois = (address: string) => string | null | Promise<string | null>;

const IP = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{2,39}$/i;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** launchd gives Cockpit a bare PATH (/usr/bin:/bin:...), so a plain `tailscale` is not found and every tailnet caller, Frank included,
 *  would fall back to a restricted Guest. Use the first install that exists (TAILSCALE_BIN overrides). */
export function findTailscale(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  const candidates = [env.TAILSCALE_BIN, '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  return candidates.find((c): c is string => !!c && exists(c)) ?? 'tailscale';
}

/** Asks tailscaled without blocking the server (the lookup can take up to 3 seconds). Answers are remembered for an hour, and
 *  callers that ask about the same address at the same moment share one lookup. */
export function tailscaleWhois(bin = findTailscale()): Whois {
  const cache = new Map<string, { at: number; device: string | null }>();
  const pending = new Map<string, Promise<string | null>>();
  return (address) => {
    const hit = cache.get(address);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.device;
    const running = pending.get(address);
    if (running) return running;
    const p = new Promise<string | null>((done, fail) => {
      execFile(bin, ['whois', '--json', address], { timeout: 3000, encoding: 'utf8' }, (err, stdout) => {
        pending.delete(address);
        let device: string | null = null;
        if (err) {
          // "peer not found" exits non-zero as well; only a failure to run tailscale at all is an error (and is not remembered).
          if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as { killed?: boolean }).killed) return fail(err);
        } else {
          try {
            const out = JSON.parse(stdout) as { Node?: { Name?: string; ComputedName?: string } };
            const name = out.Node?.Name ?? out.Node?.ComputedName ?? '';
            device = name ? name.split('.')[0].toLowerCase() : null;
          } catch { device = null; }
        }
        cache.set(address, { at: Date.now(), device });
        done(device);
      });
    });
    pending.set(address, p);
    return p;
  };
}

/** `admin` = the request carries the valid admin cookie (see admin.ts): sees everything, whatever device it comes from. */
export function resolveIdentity(req: Pick<IncomingMessage, 'headers' | 'socket'>, whois: Whois, admin = false, people: People = DEFAULT): Person | Promise<Person> {
  const viewer = resolveViewer(req, whois, people);
  if (!admin) return viewer;
  return viewer instanceof Promise ? viewer.then((v) => ({ ...ADMIN, device: v.device })) : { ...ADMIN, device: viewer.device };
}

/** Synchronous whenever no lookup is needed (this Mac, a known address, a cached answer); a promise only while tailscaled is asked. */
function resolveViewer(req: Pick<IncomingMessage, 'headers' | 'socket'>, whois: Whois, people: People): Person | Promise<Person> {
  const peer = req.socket?.remoteAddress ?? '';
  const raw = req.headers['x-forwarded-for'];
  const xff = (Array.isArray(raw) ? raw.join(',') : raw ?? '').trim();
  // Forwarded headers are only believed from the local tailscale proxy.
  if (xff && !LOOPBACK.has(peer)) return GUEST;
  if (!xff) return LOOPBACK.has(peer) || !peer ? { ...FRANK, device: 'this Mac' } : GUEST;
  const address = xff.split(',').pop()!.trim();   // the proxy appends the real caller last; earlier entries can be forged
  if (!IP.test(address)) return GUEST;
  const personOf = (device: string | null): Person => {
    if (!device) return GUEST;                     // an address tailscale does not know: not one of ours
    return people.byDevice[device] ?? { ...FRANK, device };
  };
  const known = people.deviceOfAddress[address];
  if (known) return personOf(known);
  let found: string | null | Promise<string | null>;
  try { found = whois(address); } catch { return GUEST; }
  return found instanceof Promise ? found.then(personOf, () => GUEST) : personOf(found);
}
