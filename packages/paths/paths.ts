import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Where this install keeps what changes while it runs, kept apart from the code so that updating the code never touches it.
//
//   dev (a working copy): nothing is set, state lives in <repo>/data and the config files in <repo>/config, as before.
//   prod (~/services/personal-agent-platform): infra/env has PAP_DATA_DIR=~/services/data/personal-agent-platform, so the database,
//     audit log, feedback, ledgers AND the config files the platform rewrites itself (the roster, the repo list, the privacy
//     allow-list) live there. A deploy only ever replaces tracked files, so it can never overwrite them.
//
// PAP_DATA_DIR is read from the environment first, then from infra/env, so a command run by an agent from a plain shell (no env loaded)
// finds the same data as the launchd services do.

export const root = resolve(import.meta.dirname, '../..');

/** One KEY=value line of a dotenv-style file (quotes removed); undefined when the file or the key is missing. */
export function envFileValue(path: string, key: string): string | undefined {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return undefined; }
  let found: string | undefined;
  for (const line of text.split('\n')) {
    const m = line.match(new RegExp(`^\\s*${key}=(.*)$`));
    if (m) found = m[1].trim().replace(/^["']|["']$/g, '');
  }
  return found || undefined;
}

const expand = (p: string) => resolve(p.replace(/^~(?=\/|$)/, homedir()));

/** PAP_DATA_DIR when this install has one (prod), else null. */
function configured(env: NodeJS.ProcessEnv, rootDir: string): string | null {
  const v = env.PAP_DATA_DIR || envFileValue(join(rootDir, 'infra', 'env'), 'PAP_DATA_DIR');
  return v ? expand(v) : null;
}

/** The folder for databases, logs, ledgers and other state. */
export function dataDir(env: NodeJS.ProcessEnv = process.env, rootDir: string = root): string {
  return configured(env, rootDir) ?? join(rootDir, 'data');
}

/** `prod`, `dev` or `demo`: what this process says it is (PAP_ENV), else prod when it has its own data folder, else dev. */
export function envName(env: NodeJS.ProcessEnv = process.env, rootDir: string = root): 'prod' | 'dev' | 'demo' {
  const v = env.PAP_ENV || envFileValue(join(rootDir, 'infra', 'env'), 'PAP_ENV');
  if (v === 'prod' || v === 'dev' || v === 'demo') return v;
  return env.COCKPIT_DEMO === '1' ? 'demo' : configured(env, rootDir) ? 'prod' : 'dev';
}

/**
 * A config file the platform rewrites itself (config/agents.json, projects.json, privacy.json). In dev it is the tracked file in
 * config/. In prod it is <data>/config/<name>, seeded once from the tracked copy: it is state, not code, so a deploy never replaces it.
 */
export function liveConfig(name: string, env: NodeJS.ProcessEnv = process.env, rootDir: string = root): string {
  const shipped = join(rootDir, 'config', name);
  const dir = configured(env, rootDir);
  if (!dir) return shipped;
  const live = join(dir, 'config', name);
  if (!existsSync(live) && existsSync(shipped)) {
    mkdirSync(dirname(live), { recursive: true });
    copyFileSync(shipped, live);
  }
  return live;
}
