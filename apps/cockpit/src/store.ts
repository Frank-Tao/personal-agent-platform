import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Rollup } from './types.ts';

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
