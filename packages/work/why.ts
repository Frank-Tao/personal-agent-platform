// `work why <id>`: the whole story of one task, from what Hermes already records. Pure: it formats, the CLI fetches.

interface Ev { kind?: string; created_at?: number; at?: number; payload?: Record<string, unknown> | null }
interface Run { started_at?: number | string; ended_at?: number | string; outcome?: string; status?: string; error?: string }
export interface ShowJson {
  task?: Record<string, unknown>; parents?: unknown[]; children?: unknown[]; events?: Ev[]; runs?: Run[]; comments?: Array<{ author?: string; body?: string }>;
}

const when = (n: unknown): string => (typeof n === 'number' ? new Date((n > 1e12 ? n : n * 1000)).toISOString().slice(0, 16).replace('T', ' ') : typeof n === 'string' ? n.slice(0, 16).replace('T', ' ') : '?');
const ids = (xs: unknown[] | undefined): string => (xs && xs.length ? xs.map((x) => (typeof x === 'string' ? x : String((x as { id?: unknown }).id ?? '?'))).join(', ') : 'none');
const short = (v: unknown, n = 90): string => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export function whyTask(j: ShowJson, hops: number | null): string[] {
  const t = j.task ?? {};
  const body = String(t.body ?? '');
  const marker = body.match(/^\[work:([^:\]]+):([^\]]+)\]/);
  const out: string[] = [];
  out.push(`${t.id} — ${short(t.title, 120)}`);
  out.push(`  now: ${t.status}${t.assignee ? `, owner ${t.assignee}` : ', no owner'}${t.last_failure_error ? `; last failure: ${short(t.last_failure_error)}` : ''}`);
  out.push(`  came from: ${marker ? `project ${marker[1]}, plan task "${marker[2]}"` : 'not from a project plan'}; created by ${t.created_by ?? '?'} on ${when(t.created_at)}${hops != null ? `; hop ${hops}` : ''}`);
  out.push(`  waits for: ${ids(j.parents)}   unblocks: ${ids(j.children)}`);
  out.push(`  where: ${t.workspace_kind ?? '?'}${t.workspace_path ? ` ${t.workspace_path}` : ''}${t.branch_name ? ` (branch ${t.branch_name})` : ''}`);
  const evs = (j.events ?? []).filter((e) => e.kind !== 'heartbeat');
  const beats = (j.events ?? []).length - evs.length;
  out.push(`  timeline${beats ? ` (${beats} heartbeats hidden)` : ''}:`);
  for (const e of evs.slice(-15)) out.push(`    ${when(e.created_at ?? e.at)}  ${e.kind}${e.payload && Object.keys(e.payload).length ? ` — ${short(JSON.stringify(e.payload), 100)}` : ''}`);
  if (j.runs?.length) {
    out.push(`  runs: ${j.runs.length}`);
    for (const r of j.runs.slice(-3)) out.push(`    ${when(r.started_at)} → ${when(r.ended_at)}  ${r.outcome ?? r.status ?? ''}${r.error ? ` — ${short(r.error)}` : ''}`);
  }
  if (j.comments?.length) { out.push('  last comment:'); const c = j.comments[j.comments.length - 1]; out.push(`    ${c.author ?? '?'}: ${short(c.body, 160)}`); }
  return out;
}
