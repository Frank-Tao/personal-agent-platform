import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NeedsStats, NeedsYou, Rollup } from './types.ts';

const SNAPSHOT_DAYS = 7;
const DAILY_DAYS = 400;

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
    // The trend line: one small row per day, kept for DAILY_DAYS. Full snapshots are large (tens of KB) and are thinned (see prune).
    this.db.exec(`CREATE TABLE IF NOT EXISTS daily (
      date TEXT PRIMARY KEY, spent_cents INTEGER NOT NULL, budget_cents INTEGER NOT NULL, needs_you INTEGER NOT NULL
    )`);
    // One-time, for a database made before `daily` existed: the last snapshot of each day.
    if ((this.db.prepare('SELECT COUNT(*) c FROM daily').get() as { c: number }).c === 0) {
      this.db.exec(`INSERT INTO daily (date, spent_cents, budget_cents, needs_you)
        SELECT substr(s.ts,1,10), s.spent_cents, s.budget_cents, s.needs_you
        FROM snapshots s JOIN (SELECT MAX(ts) m FROM snapshots GROUP BY substr(ts,1,10)) d ON d.m = s.ts`);
    }
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
    this.db
      .prepare('INSERT OR REPLACE INTO daily (date, spent_cents, budget_cents, needs_you) VALUES (?,?,?,?)')
      .run(r.generatedAt.slice(0, 10), r.spend.spentCents, r.spend.budgetCents, r.needsYou.length);
    this.prune(Date.parse(r.generatedAt) || Date.now());
  }

  /** Full snapshots: every one for the last hour, then the first of each hour for SNAPSHOT_DAYS, then none. Saving one every two minutes
   *  and keeping them all for 90 days grew the file by about 35 MB a day; this holds it near 10 MB. Daily rows are kept for DAILY_DAYS. */
  prune(now = Date.now()): number {
    const iso = (ms: number) => new Date(ms).toISOString();
    const a = this.db.prepare('DELETE FROM snapshots WHERE ts < ?').run(iso(now - SNAPSHOT_DAYS * 86_400_000));
    const b = this.db
      .prepare('DELETE FROM snapshots WHERE ts < ? AND ts NOT IN (SELECT MIN(ts) FROM snapshots GROUP BY substr(ts,1,13))')
      .run(iso(now - 3_600_000));
    this.db.prepare('DELETE FROM daily WHERE date < ?').run(iso(now - DAILY_DAYS * 86_400_000).slice(0, 10));
    return Number(a.changes) + Number(b.changes);
  }

  /** Give freed pages back to the disk when at least a quarter of the file is empty (after the first prune of a large database). */
  compact(): boolean {
    const n = (q: string) => Number(Object.values(this.db.prepare(q).get() as Record<string, number>)[0]);
    const free = n('PRAGMA freelist_count'), pages = n('PRAGMA page_count');
    if (pages < 1000 || free * 4 < pages) return false;
    this.db.exec('VACUUM');
    return true;
  }

  latest(): Rollup | undefined {
    const row = this.db.prepare('SELECT body FROM snapshots ORDER BY ts DESC LIMIT 1').get() as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as Rollup) : undefined;
  }

  /** One point per day: the last snapshot of each day. `days` is clamped to 1..DAILY_DAYS (anything unreadable = 30). */
  history(days = 30): Array<{ date: string; spentCents: number; budgetCents: number; needsYou: number }> {
    const n = Number.isFinite(days) ? Math.min(DAILY_DAYS, Math.max(1, Math.floor(days))) : 30;
    const since = new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    return this.db
      .prepare('SELECT date, spent_cents AS spentCents, budget_cents AS budgetCents, needs_you AS needsYou FROM daily WHERE date >= ? ORDER BY date')
      .all(since) as Array<{ date: string; spentCents: number; budgetCents: number; needsYou: number }>;
  }

  close(): void {
    this.db.close();
  }
}
