import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNoPii } from '../../../../packages/redact/redact.ts';
import type { Metric, NeedsYou, PortfolioCard, Source, Status } from '../types.ts';

// One JSON file per portfolio:
// {
//   "id": "personal", "name": "Personal", "status": "ok",
//   "headline": "Cash runway 7.2 months",
//   "metrics": [{ "label": "Runway", "value": "7.2 mo", "trend": "flat" }],
//   "alerts": [{ "title": "Q4 estimated tax due", "dueAt": "2027-01-15", "severity": "warn" }],
//   "updatedAt": "2026-10-25T08:00:00Z"
// }

interface FileCard {
  id: string;
  name: string;
  status?: Status;
  headline?: string;
  metrics?: Metric[];
  alerts?: Array<{ title: string; dueAt?: string; severity?: 'info' | 'warn' | 'alert' }>;
  updatedAt?: string;
}

const STALE_MS = 3 * 24 * 3600 * 1000;

export function fileCardsSource(dir: string, kind: 'private' | 'manual'): Source {
  return async () => {
    const cards: PortfolioCard[] = [];
    const errors: string[] = [];
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.endsWith('.example.json'));
    } catch {
      return { cards, errors: [] }; // directory not created yet: nothing to show
    }

    for (const name of names) {
      try {
        const raw = JSON.parse(await readFile(join(dir, name), 'utf8')) as FileCard;
        // The summary layer is the only thing allowed past the privacy boundary: gate every file.
        if (kind === 'private') assertNoPii(raw, name);
        if (!raw.id || !raw.name) throw new Error('missing id/name');

        const updatedAt = raw.updatedAt ?? new Date(0).toISOString();
        const stale = Date.now() - Date.parse(updatedAt) > STALE_MS;
        const needsYou: NeedsYou[] = (raw.alerts ?? []).map((a) => ({
          portfolioId: raw.id,
          kind: a.dueAt ? ('deadline' as const) : ('alert' as const),
          title: a.title,
          severity: a.severity ?? 'info',
          dueAt: a.dueAt,
        }));
        if (stale) {
          needsYou.push({ portfolioId: raw.id, kind: 'alert', title: 'Data is stale (>3 days)', severity: 'warn' });
        }
        cards.push({
          id: raw.id,
          name: raw.name,
          source: kind,
          status: stale && (raw.status ?? 'unknown') === 'ok' ? 'warn' : (raw.status ?? 'unknown'),
          headline: raw.headline ?? '',
          metrics: raw.metrics ?? [],
          needsYou,
          updatedAt,
        });
      } catch (e) {
        // Never echo file contents in errors — they may be what tripped the PII gate.
        errors.push(`${kind}: ${name} rejected (${(e as Error).message})`);
      }
    }
    return { cards, errors };
  };
}
