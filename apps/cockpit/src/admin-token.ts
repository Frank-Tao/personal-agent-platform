import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { IDLE_MS, fileStore, fileTokenSource, tokenStatus } from './admin.ts';

// npm run admin-token                 when it was last used and when it expires
// npm run admin-token -- new [--show] make a new secret (the old one stops working at once; no restart needed); --show prints it
const root = resolve(import.meta.dirname, '..', '..', '..');
const envPath = join(root, 'infra', 'env');
const statePath = process.env.COCKPIT_ADMIN_STATE ?? join(root, 'data', 'cockpit-admin.json');
const store = fileStore(statePath, envPath);
const when = (ms: number | null) => (ms === null ? 'never' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');

export function main(argv: string[], out: (s: string) => void = console.log): number {
  if (argv[0] === 'new') {
    const token = randomBytes(24).toString('hex');
    const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    const lines = text.split('\n').filter((l) => !/^\s*COCKPIT_ADMIN_TOKEN=/.test(l) && l !== '');
    writeFileSync(envPath, [...lines, `COCKPIT_ADMIN_TOKEN=${token}`, ''].join('\n'), { mode: 0o600 });
    chmodSync(envPath, 0o600);
    store.touch(Date.now());
    out(`New admin secret written to infra/env. The old one no longer works; sessions made with it end now. Valid until ${when(Date.now() + IDLE_MS)} unless used (each use extends it by 30 days).`);
    out(argv.includes('--show') ? `Open: https://<cockpit address>/?admin=${token}` : 'Read it with: grep COCKPIT_ADMIN_TOKEN infra/env');
    return 0;
  }
  const have = !!fileTokenSource(envPath, process.env.COCKPIT_ADMIN_TOKEN, 0)();
  const s = tokenStatus(store);
  out(have ? `Admin secret: set. Last used ${when(s.lastUsedAt)}. ${s.expired ? 'EXPIRED (30 days unused): make a new one with: npm run admin-token -- new' : `Expires ${when(s.expiresAt)} unless used.`}` : 'Admin secret: not set. Make one with: npm run admin-token -- new');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) process.exit(main(process.argv.slice(2)));
void homedir;
