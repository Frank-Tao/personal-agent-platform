import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir, liveConfig } from '../../packages/paths/paths.ts';
import { loadConfig, pythonSender, readState, runMailcopy, writeState } from '../../packages/mailcopy/mailcopy.ts';
import { root, type Ctx } from '../shared.ts';

/**
 * work mailcopy [--apply]: email a copy of what Hermes jobs sent to Telegram, to the person that chat belongs to
 * (people, chats and addresses: <data>/config/mailcopy.json). Run every 10 minutes by the work-watch job.
 */
export function cmdMailcopy(c: Ctx) {
  const data = dataDir(c.env);
  const cfgPath = c.env.MAILCOPY_CONFIG ?? liveConfig('mailcopy.json', c.env);
  const cfg = loadConfig(cfgPath);
  if (!cfg) { c.out(`mailcopy: not set up (no people in ${cfgPath.replace(process.env.HOME ?? '', '~')})`); return; }
  const now = c.env.WORK_NOW ? new Date(c.env.WORK_NOW) : new Date();
  const statePath = join(data, 'mailcopy-state.json'), statusPath = join(data, 'mailcopy-status.json');
  const { state, fresh } = readState(statePath, now);
  const send = pythonSender(join(root, 'infra', 'bin', 'send-mail.py'), c.env.PYTHON || undefined, { ...process.env, ...c.env });
  const r = runMailcopy({ hermesHome: c.hermesHome, cfg, state, now, send, apply: c.apply });
  c.out(`mailcopy: ${c.apply ? `${r.sent} sent, ${r.failed} failed` : `${r.pending} to send (dry run)`}, ${r.skipped} silent, ${r.unmapped.length} for chats nobody is mapped to`);
  for (const u of r.unmapped) c.out(`  ▲ no one is mapped to: ${u}`);
  if (r.lastError) c.out(`  ▲ last error: ${r.lastError}`);
  if (!c.apply) { c.out('(dry run — add --apply)'); return; }
  if (fresh) c.out(`  ✓ first run: copies start from ${now.toISOString()}; what was sent before is not mailed`);
  writeState(statePath, state);
  mkdirSync(dirname(statusPath), { recursive: true });
  const tmp = `${statusPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ at: now.toISOString(), sent: r.sent, failed: r.failed, pending: r.pending, skipped: r.skipped, unmapped: r.unmapped, lastError: r.lastError }));
  renameSync(tmp, statusPath);
}
