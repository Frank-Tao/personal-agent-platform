import { readFileSync } from 'node:fs';

// Cockpit's read-only view of the family portfolio. It reads the snapshot file written by family-portofolio-tracker
// (scripts/snapshot_ghostfolio.py): never Ghostfolio's database or API directly, and it writes nothing.

export interface PanelPosition { symbol: string; name: string; market: string; currency: string; valueAud: number; share: number }
export interface PanelMarket { market: string; valueAud: number; share: number }
export interface PortfolioPanel {
  state: 'ok' | 'stale' | 'unavailable';
  message?: string;
  currency: 'AUD';
  asOf?: string;
  totalAud?: number;
  byMarket: PanelMarket[];
  topPositions: PanelPosition[];
  warnings: string[];
}

const EMPTY = { currency: 'AUD' as const, byMarket: [], topPositions: [], warnings: [] };
export const unavailable = (message: string): PortfolioPanel => ({ ...EMPTY, state: 'unavailable', message });

/** Market of a Yahoo-style symbol: .AX = ASX, .HK/.SS/.SZ = China (incl. Hong Kong), anything else = US. */
export function marketOf(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.endsWith('.AX')) return 'ASX';
  if (/\.(HK|SS|SZ)$/.test(s)) return 'China';
  return 'US';
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Shapes a parsed snapshot into the display model. Anything unexpected becomes an explicit "unavailable", never a zero. */
export function buildPanel(snap: any, opts: { top?: number; now?: Date; maxAgeHours?: number } = {}): PortfolioPanel {
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.positions)) return unavailable('The portfolio snapshot is not in the expected format.');
  const total = num(snap.total_value_aud);
  if (total === undefined) return unavailable('The portfolio snapshot has no AUD total.');
  const positions: PanelPosition[] = [];
  for (const p of snap.positions) {
    const v = num(p?.value_aud);
    if (typeof p?.symbol !== 'string' || v === undefined) return unavailable('The portfolio snapshot has a position without a symbol or AUD value.');
    positions.push({ symbol: p.symbol, name: typeof p.name === 'string' ? p.name : p.symbol, market: marketOf(p.symbol), currency: typeof p.currency === 'string' ? p.currency : '?', valueAud: v, share: total > 0 ? v / total : 0 });
  }
  const markets = new Map<string, number>();
  for (const p of positions) markets.set(p.market, (markets.get(p.market) ?? 0) + p.valueAud);
  const byMarket = [...markets].map(([market, valueAud]) => ({ market, valueAud, share: total > 0 ? valueAud / total : 0 })).sort((a, b) => b.valueAud - a.valueAud);
  const topPositions = positions.sort((a, b) => b.valueAud - a.valueAud).slice(0, opts.top ?? 5);
  const warnings: string[] = Array.isArray(snap.warnings) ? snap.warnings.filter((w: unknown): w is string => typeof w === 'string') : [];
  const asOf = typeof snap.generated_at === 'string' ? snap.generated_at : undefined;
  let stale = snap.stale === true || snap.base_currency !== 'AUD';
  if (snap.base_currency !== 'AUD') warnings.push(`Base currency is ${String(snap.base_currency)}, not AUD.`);
  const age = asOf ? ((opts.now ?? new Date()).getTime() - Date.parse(asOf)) / 3_600_000 : NaN;
  if (!Number.isFinite(age)) { stale = true; warnings.push('The snapshot has no valid time.'); }
  else if (age > (opts.maxAgeHours ?? 36)) { stale = true; warnings.push(`The snapshot is ${Math.round(age)} hours old.`); }
  return { state: stale ? 'stale' : 'ok', currency: 'AUD', asOf, totalAud: total, byMarket, topPositions, warnings };
}

/** Reads the snapshot at `path` (unset, missing or unreadable = unavailable). */
export function readPanel(path: string | undefined, opts: Parameters<typeof buildPanel>[1] = {}): PortfolioPanel {
  if (!path) return unavailable('No portfolio snapshot is configured (set PORTFOLIO_SNAPSHOT).');
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return unavailable('No portfolio snapshot found. Run scripts/snapshot_ghostfolio.py in family-portofolio-tracker.'); }
  try { return buildPanel(JSON.parse(text), opts); } catch { return unavailable('The portfolio snapshot could not be read (not valid JSON).'); }
}
