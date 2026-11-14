import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NeedsStats, NeedsYou, Rollup } from './types.ts';

/** Snapshot history, so the dashboard can show trends and survive a Hermes outage. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS snapshots (
      ts TEXT PRIMARY KEY,
      spent_cents INTEGER NOT NULL,
      budget_cents INTEGER NOT NULL,
      needs_you INTEGER NOT NULL,
      body TEXT NOT NULL
    )`);
    // Every Needs-you item ever seen: when it first appeared and when it stopped (= was resolved), to measure how long things wait for a human.
    this.db.exec(`CREATE TABLE IF NOT EXISTS needs_log (
      key TEXT PRIMARY KEY, kind TEXT NOT NULL, grp TEXT NOT NULL, first_seen TEXT NOT NULL, resolved_at TEXT
    )`);
  }

  /** Record which items are open now; an item that was open and is gone has been resolved. `grp` maps an item to its portfolio. */
  trackNeeds(items: NeedsYou[], grp: (n: NeedsYou) => string, nowIso = new Date().toISOString()): void {
    const keyOf = (n: NeedsYou) => `${n.portfolioId}|${n.kind}|${n.title}`;
    const open = new Set(items.map(keyOf));
    const ins = this.db.prepare('INSERT INTO needs_log (key, kind, grp, first_seen, resolved_at) VALUES (?,?,?,?,NULL) ON CONFLICT(key) DO UPDATE SET resolved_at = NULL WHERE resolved_at IS NOT NULL');
    for (const n of items) ins.run(keyOf(n), n.kind, grp(n), nowIso);
    for (const row of this.db.prepare('SELECT key FROM needs_log WHERE resolved_at IS NULL').all() as Array<{ key: string }>) {
      if (!open.has(row.key)) this.db.prepare('UPDATE needs_log SET resolved_at = ? WHERE key = ?').run(nowIso, row.key);
    }
  }

  /** One-time: rebuild the needs log from stored snapshots (one per hour), so the first view already has history. */
  backfillNeeds(grp: (n: NeedsYou, r: Rollup) => string): void {
    if ((this.db.prepare('SELECT COUNT(*) c FROM needs_log').get() as { c: number }).c > 0) return;
    const rows = this.db.prepare(`SELECT ts, body FROM snapshots s WHERE ts = (SELECT MIN(ts) FROM snapshots WHERE substr(ts,1,13) = substr(s.ts,1,13)) ORDER BY ts`).all() as Array<{ ts: string; body: string }>;
    for (const row of rows) {
      try { const r = JSON.parse(row.body) as Rollup; this.trackNeeds(r.needsYou ?? [], (n) => grp(n, r), row.ts); } catch { /* skip a bad snapshot */ }
    }
  }

  needsStats(nowIso = new Date().toISOString()): NeedsStats {
    const rows = this.db.prepare('SELECT kind, grp, first_seen f, resolved_at r FROM needs_log').all() as Array<{ kind: string; grp: string; f: string; r: string | null }>;
    const hours = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3_600_000;
    const open = rows.filter((x) => !x.r), done = rows.filter((x) => x.r);
    const count = (list: typeof rows, key: 'kind' | 'grp') => list.reduce<Record<string, number>>((m, x) => ((m[x[key]] = (m[x[key]] ?? 0) + 1), m), {});
    const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
    const kinds = [...new Set(rows.map((x) => x.kind))];
    return {
      openByPortfolio: count(open, 'grp'), openByKind: count(open, 'kind'),
      resolved: done.length,
      resolveHours: Object.fromEntries(kinds.map((k) => { const h = done.filter((x) => x.kind === k).map((x) => hours(x.f, x.r!)); return [k, { count: h.length, medianHours: median(h) }]; })),
      oldestOpenHours: open.length ? Math.max(...open.map((x) => hours(x.f, nowIso))) : null,
      since: rows.length ? rows.map((x) => x.f).sort()[0] : null,
    };
  }

  save(r: Rollup): void {
    this.db
      .prepare('INSERT OR REPLACE INTO snapshots (ts, spent_cents, budget_cents, needs_you, body) VALUES (?,?,?,?,?)')
      .run(r.generatedAt, r.spend.spentCents, r.spend.budgetCents, r.needsYou.length, JSON.stringify(r));
    // Keep roughly 90 days at 5-minute cadence collapsed to ~25k rows at most.
    this.db.prepare('DELETE FROM snapshots WHERE ts < ?').run(new Date(Date.now() - 90 * 86_400_000).toISOString());
  }

  latest(): Rollup | undefined {
    const row = this.db.prepare('SELECT body FROM snapshots ORDER BY ts DESC LIMIT 1').get() as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as Rollup) : undefined;
  }

  /** One point per day: last snapshot of each day. */
  history(days = 30): Array<{ date: string; spentCents: number; budgetCents: number; needsYou: number }> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db
      .prepare(
        `SELECT substr(ts,1,10) AS date, spent_cents AS spentCents, budget_cents AS budgetCents, needs_you AS needsYou
         FROM snapshots s
         WHERE ts >= ? AND ts = (SELECT MAX(ts) FROM snapshots WHERE substr(ts,1,10) = substr(s.ts,1,10))
         ORDER BY date`,
      )
      .all(since) as any;
  }

  close(): void {
    this.db.close();
  }
}
