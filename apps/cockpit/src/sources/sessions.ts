import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { maskSensitive } from './agentDetail.ts';

// A read-only window onto Hermes' own conversation history: one state.db per profile (sessions, messages and a full-text index). Nothing
// is written or copied. Text goes through the same masking as agent files; a model's reasoning is never shown; tool output is cut short.
// Profiles named in `exclude` are not opened at all (by default the Privacy agent, whose conversations hold private data, and Diane's own).

export const DEFAULT_EXCLUDE = ['personal', 'diane', 'zoe'];

export interface SessionRow { profile: string; id: string; source: string; model: string | null; title: string | null; startedAt: string | null; endedAt: string | null; messages: number; toolCalls: number; tokens: number; costUsd: number | null; snippet?: string }
export interface MessageRow { id: number; role: string; at: string | null; text: string; tool?: string; calls?: string[] }

const iso = (s: unknown) => (typeof s === 'number' && s > 0 ? new Date(s * 1000).toISOString() : null);

export function stateDbs(home: string, exclude: readonly string[] = DEFAULT_EXCLUDE): Array<{ profile: string; path: string }> {
  const out: Array<{ profile: string; path: string }> = [];
  const skip = new Set(exclude.map((x) => x.toLowerCase()));
  if (existsSync(join(home, 'state.db')) && !skip.has('atlas') && !skip.has('default')) out.push({ profile: 'atlas', path: join(home, 'state.db') });
  try {
    for (const d of readdirSync(join(home, 'profiles'), { withFileTypes: true })) {
      if (d.isDirectory() && !skip.has(d.name.toLowerCase()) && existsSync(join(home, 'profiles', d.name, 'state.db'))) out.push({ profile: d.name, path: join(home, 'profiles', d.name, 'state.db') });
    }
  } catch { /* no profiles */ }
  return out;
}

function withDb<T>(path: string, fn: (db: DatabaseSync) => T, fallback: T): T {
  let db: DatabaseSync | undefined;
  try { db = new DatabaseSync(path, { readOnly: true }); return fn(db); } catch { return fallback; } finally { db?.close(); }
}

/** Every word quoted, so what a person types can never be read as search syntax. */
const ftsQuery = (q: string) => q.split(/\s+/).map((t) => t.replace(/["*^:(){}\[\]-]/g, '')).filter((t) => t.length > 1).slice(0, 8).map((t) => `"${t}"`).join(' ');

export interface ListOpts { exclude?: readonly string[]; profile?: string; source?: string; q?: string; limit?: number; offset?: number }

export function listSessions(home: string, o: ListOpts = {}): { sessions: SessionRow[]; total: number; profiles: string[]; sources: string[] } {
  const dbs = stateDbs(home, o.exclude).filter((d) => !o.profile || d.profile === o.profile);
  const limit = Math.max(1, Math.min(100, o.limit ?? 40)), offset = Math.max(0, o.offset ?? 0);
  const fts = o.q ? ftsQuery(o.q) : '';
  const rows: SessionRow[] = [];
  let total = 0;
  const sources = new Set<string>();
  for (const d of dbs) {
    withDb(d.path, (db) => {
      for (const s of db.prepare("SELECT DISTINCT source FROM sessions WHERE source IS NOT NULL").all() as Array<{ source: string }>) sources.add(s.source);
      const hits = new Map<string, string>();
      if (fts) for (const h of db.prepare("SELECT m.session_id sid, snippet(messages_fts, 0, '[', ']', '…', 14) snip FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? LIMIT 400").all(fts) as Array<{ sid: string; snip: string }>) if (!hits.has(h.sid)) hits.set(h.sid, h.snip);
      const where = ["COALESCE(hidden,0) = 0", ...(o.source ? ['source = ?'] : []), ...(fts ? [`id IN (${[...hits.keys()].map(() => '?').join(',') || "''"})`] : [])].join(' AND ');
      const args = [...(o.source ? [o.source] : []), ...(fts ? [...hits.keys()] : [])];
      total += Number((db.prepare(`SELECT COUNT(*) n FROM sessions WHERE ${where}`).get(...args) as { n: number }).n);
      const found = db.prepare(`SELECT id, source, model, title, started_at, ended_at, message_count, tool_call_count, input_tokens, output_tokens, COALESCE(actual_cost_usd, estimated_cost_usd) cost FROM sessions WHERE ${where} ORDER BY started_at DESC LIMIT ?`).all(...args, limit + offset) as Array<Record<string, unknown>>;
      for (const r of found) rows.push({ profile: d.profile, id: String(r.id), source: String(r.source ?? ''), model: (r.model as string) ?? null, title: r.title ? maskSensitive(String(r.title)).slice(0, 160) : null, startedAt: iso(r.started_at), endedAt: iso(r.ended_at), messages: Number(r.message_count ?? 0), toolCalls: Number(r.tool_call_count ?? 0), tokens: Number(r.input_tokens ?? 0) + Number(r.output_tokens ?? 0), costUsd: typeof r.cost === 'number' ? r.cost : null, ...(hits.has(String(r.id)) ? { snippet: maskSensitive(hits.get(String(r.id))!).slice(0, 300) } : {}) });
    }, undefined);
  }
  rows.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  return { sessions: rows.slice(offset, offset + limit), total, profiles: dbs.map((d) => d.profile), sources: [...sources].sort() };
}

export function getSession(home: string, id: string, o: { exclude?: readonly string[]; offset?: number; limit?: number } = {}): { session: SessionRow; messages: MessageRow[]; total: number } | null {
  const limit = Math.max(1, Math.min(200, o.limit ?? 80)), offset = Math.max(0, o.offset ?? 0);
  for (const d of stateDbs(home, o.exclude)) {
    const hit = withDb(d.path, (db) => {
      const s = db.prepare('SELECT id, source, model, title, started_at, ended_at, message_count, tool_call_count, input_tokens, output_tokens, COALESCE(actual_cost_usd, estimated_cost_usd) cost FROM sessions WHERE id = ? AND COALESCE(hidden,0) = 0').get(id) as Record<string, unknown> | undefined;
      if (!s) return null;
      const total = Number((db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id = ? AND role != 'session_meta'").get(id) as { n: number }).n);
      const ms = db.prepare("SELECT id, role, content, tool_name, tool_calls, timestamp FROM messages WHERE session_id = ? AND role != 'session_meta' ORDER BY id LIMIT ? OFFSET ?").all(id, limit, offset) as Array<Record<string, unknown>>;
      const messages: MessageRow[] = ms.map((m) => {
        const role = String(m.role);
        let calls: string[] | undefined;
        try { const tc = m.tool_calls ? JSON.parse(String(m.tool_calls)) as Array<{ function?: { name?: string }; name?: string }> : []; if (tc.length) calls = tc.map((c) => c.function?.name ?? c.name ?? 'tool').slice(0, 8); } catch { /* not JSON */ }
        const cap = role === 'tool' ? 600 : 6000;
        const text = maskSensitive(String(m.content ?? '')).slice(0, cap);
        return { id: Number(m.id), role, at: iso(m.timestamp), text, ...(role === 'tool' && m.tool_name ? { tool: String(m.tool_name) } : {}), ...(calls ? { calls } : {}) };
      });
      return { session: { profile: d.profile, id: String(s.id), source: String(s.source ?? ''), model: (s.model as string) ?? null, title: s.title ? maskSensitive(String(s.title)).slice(0, 160) : null, startedAt: iso(s.started_at), endedAt: iso(s.ended_at), messages: Number(s.message_count ?? 0), toolCalls: Number(s.tool_call_count ?? 0), tokens: Number(s.input_tokens ?? 0) + Number(s.output_tokens ?? 0), costUsd: typeof s.cost === 'number' ? s.cost : null }, messages, total };
    }, null);
    if (hit) return hit;
  }
  return null;
}
