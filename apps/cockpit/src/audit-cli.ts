import { join } from 'node:path';
import { dataDir } from '../../../packages/paths/paths.ts';
import { fileAudit } from './audit.ts';

// npm run audit -- [--last 20] [--who Diane] [--action agents.doc] [--json]
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const path = process.env.AUDIT_LOG ?? join(dataDir(), 'audit.jsonl');
let rows = fileAudit(path).read(1000);
if (opt('who')) rows = rows.filter((r) => r.who.toLowerCase() === opt('who')!.toLowerCase());
if (opt('action')) rows = rows.filter((r) => r.action === opt('action'));
rows = rows.slice(-(Number(opt('last')) || 20));
if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else if (!rows.length) console.log(`no entries in ${path}`);
else for (const r of rows) {
  const d = (r.detail ?? {}) as Record<string, unknown>;
  console.log(`${r.at}  ${r.ok ? 'ok    ' : 'REFUSED'}  ${r.who}${r.device ? ` (${r.device})` : ''}  ${r.action}  ${r.target}`);
  if (d.from !== undefined || d.to !== undefined) console.log(`    ${String(d.from ?? '?')}  →  ${String(d.to ?? '?')}`);
  if (d.reason) console.log(`    reason: ${String(d.reason)}`);
  if (typeof d.diff === 'string' && d.diff) console.log(d.diff.split('\n').map((l) => `    ${l}`).join('\n'));
}
