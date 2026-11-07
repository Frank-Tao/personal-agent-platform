import { resolve } from 'node:path';

// Is the app visible on the App Store in each country? Read-only: Apple's public iTunes Lookup API, no login, no App Store Connect access.
//
//   npm run store -- check --bundle com.aithrival.apa7review [--countries us,au,cn] [--json]
//   npm run store -- check --id 6829698460 [--countries us,au,cn]
//
// "found" means the storefront serves the app now (what customers see). "not found" does NOT prove it is not for sale: the lookup can lag
// a few hours after a change, and a country can be switched off in App Store Connect. The authority is App Store Connect →
// Pricing and Availability → App Availability (see the store-availability skill).

export const DEFAULT_COUNTRIES = ['us', 'au', 'cn'];
const COUNTRY = /^[a-z]{2}$/;

export interface StoreResult {
  country: string;
  found: boolean;
  error?: string;
  id?: number;
  name?: string;
  bundleId?: string;
  version?: string;
  price?: number;
  currency?: string;
  url?: string;
  released?: string;
  minOs?: string;
  seller?: string;
  rating?: number;
  ratings?: number;
}
export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export async function checkStorefronts(by: { bundle?: string; id?: string }, countries: string[], fetcher: Fetcher = (u) => fetch(u, { signal: AbortSignal.timeout(15_000) })): Promise<StoreResult[]> {
  if (!by.bundle && !by.id) throw new Error('give --bundle <bundle id> or --id <numeric Apple ID>');
  if (by.id && !/^\d{6,12}$/.test(by.id)) throw new Error('--id must be the numeric Apple ID (App Store Connect → App Information → General Information)');
  if (by.bundle && !/^[A-Za-z0-9.-]{3,155}$/.test(by.bundle)) throw new Error('--bundle looks wrong');
  const cs = countries.map((c) => c.toLowerCase());
  for (const c of cs) if (!COUNTRY.test(c)) throw new Error(`"${c}" is not a two-letter country code`);
  return Promise.all(cs.map(async (country): Promise<StoreResult> => {
    const q = by.id ? `id=${by.id}` : `bundleId=${encodeURIComponent(by.bundle!)}`;
    try {
      const r = await fetcher(`https://itunes.apple.com/lookup?${q}&country=${country}`);
      if (!r.ok) return { country, found: false, error: `Apple answered HTTP ${r.status}` };
      const d = (await r.json()) as { results?: Array<Record<string, unknown>> };
      const a = d.results?.[0];
      if (!a) return { country, found: false };
      return { country, found: true, id: a.trackId as number, name: a.trackName as string, bundleId: a.bundleId as string, version: a.version as string, price: a.price as number, currency: a.currency as string, url: String(a.trackViewUrl ?? '').replace(/\?.*$/, ''), released: a.releaseDate as string, minOs: a.minimumOsVersion as string, seller: a.sellerName as string, rating: a.averageUserRating as number, ratings: a.userRatingCount as number };
    } catch (e) { return { country, found: false, error: (e as Error).message }; }
  }));
}

export function formatResults(rs: StoreResult[]): string {
  const lines = rs.map((r) => r.found
    ? `✓ ${r.country.toUpperCase()}  available   ${r.name} ${r.version}  ${r.price === 0 ? 'free' : `${r.price} ${r.currency}`}  released ${String(r.released).slice(0, 10)}  ${r.url}`
    : `✗ ${r.country.toUpperCase()}  not found${r.error ? ` (${r.error})` : ''}`);
  const missing = rs.filter((r) => !r.found);
  lines.push(missing.length ? `\n${missing.length} of ${rs.length} not found. That is not proof the app is unavailable there: the lookup can lag a few hours. Confirm in App Store Connect → Pricing and Availability → App Availability → Manage.` : '\nEvery checked storefront serves the app. App Store Connect → App Availability is still the authority for what is switched on.');
  return lines.join('\n');
}

export async function main(argv: string[], fetcher?: Fetcher, out: (s: string) => void = console.log): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd !== 'check') { out('usage: store check (--bundle <id> | --id <apple id>) [--countries us,au,cn] [--json]'); return 2; }
  try {
    const rs = await checkStorefronts({ bundle: flag('bundle'), id: flag('id') }, (flag('countries') ?? DEFAULT_COUNTRIES.join(',')).split(',').map((c) => c.trim()).filter(Boolean), fetcher);
    out(rest.includes('--json') ? JSON.stringify(rs) : formatResults(rs));
    return rs.every((r) => r.found) ? 0 : 1;
  } catch (e) { out(`error: ${(e as Error).message}`); return 2; }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) process.exit(await main(process.argv.slice(2)));
