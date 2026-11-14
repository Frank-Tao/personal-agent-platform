import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// A trace of the changes that matter, kept for the owner to check later: who changed an agent's prompt, memory or model (and what changed),
// and every write that was refused. One JSON object per line in data/audit.jsonl, append-only, readable only by this user.
// Text in the log has already been through maskSensitive (see app.ts), so a secret typed into a prompt does not end up here.
//
//   npm run audit -- --last 20 [--who Diane] [--action agents.doc]
//   GET /api/audit?limit=100                       (owner only)

export interface AuditEntry {
  at: string;
  /** Person's name as Cockpit knows it (Frank, Diane, Guest, Admin) and the device the request came from, when known. */
  who: string;
  device: string | null;
  /** What happened: agents.doc, agents.model, or denied (a write that was refused before it ran). */
  action: string;
  /** What it was done to: an agent and file, an agent, or the route that was refused. */
  target: string;
  /** false = refused or failed (the reason is in detail). */
  ok: boolean;
  detail?: Record<string, unknown>;
}

export interface AuditLog {
  log(entry: Omit<AuditEntry, 'at'>): void;
  read(limit?: number): AuditEntry[];
}

export function fileAudit(path: string, now: () => Date = () => new Date()): AuditLog {
  return {
    log(entry) {
      try {
        const fresh = !existsSync(path);
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, JSON.stringify({ at: now().toISOString(), ...entry }) + '\n', { mode: 0o600 });
        if (fresh) chmodSync(path, 0o600);
      } catch (e) {
        // The change is not undone because the trace could not be written, but it is not silent either.
        console.error('audit: could not write', path, (e as Error).message);
      }
    },
    read(limit = 100) {
      let text = '';
      try { text = readFileSync(path, 'utf8'); } catch { return []; }
      const out: AuditEntry[] = [];
      for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line) as AuditEntry); } catch { /* a half-written line */ } }
      return out.slice(-Math.max(1, Math.min(1000, Math.floor(limit) || 100)));
    },
  };
}

/** Which lines were taken out and which were put in (order and duplicates ignored), capped so one big edit cannot flood the log. */
export function lineDiff(before: string, after: string, cap = 6000): { removed: number; added: number; text: string } {
  const lines = (s: string) => s.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const count = (a: string[]) => a.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
  const b = count(lines(before)), a = count(lines(after));
  const removed: string[] = [], added: string[] = [];
  for (const [l, n] of b) for (let i = 0; i < n - (a.get(l) ?? 0); i++) removed.push(l);
  for (const [l, n] of a) for (let i = 0; i < n - (b.get(l) ?? 0); i++) added.push(l);
  const text = [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].join('\n');
  return { removed: removed.length, added: added.length, text: text.length > cap ? text.slice(0, cap) + '\n… (cut)' : text };
}
