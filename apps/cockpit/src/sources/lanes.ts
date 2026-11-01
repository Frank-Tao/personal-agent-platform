import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { LaneInfo, Source, Status } from '../types.ts';
import { findOnPath, onPath } from './atlas.ts';

// Worker lanes, checked for real rather than assumed:
//   installed   the CLI is on disk (claude, codex, opencode, ollama)
//   login       `claude auth status` (JSON), `codex login status`, `opencode auth list` (credential per provider)
//   limits      `claude -p "/usage"` (session + weekly %); codex shares the ChatGPT plan with Hermes, so the
//               rollup adds that window from `hermes usage`. API lanes have no readable limit: they show the
//               spend `opencode stats` has recorded instead.
//   models      lanes/models.conf (default per lane); Ollama's loaded model from its API
//   runs        data/lanes.jsonl, one line per real lanes/lane.sh run (7 days)
// The CLIs' own tokens/keys are never read: only their public status commands are run.

export type Exec = (cmd: string, args: string[]) => Promise<string>;

const CACHE_MS = 5 * 60_000;
const RUN_WINDOW_MS = 7 * 86_400_000;
const ANSI = /\x1b\[[0-9;]*m/g;

interface Opts {
  lanes: string[];
  ledgerPath: string;
  /** lanes/models.conf (KEY=VALUE); missing is fine. */
  modelsPath?: string;
  exec?: Exec;
  hasCommand?: (name: string) => Promise<boolean>;
  ollamaUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Which opencode provider id each API lane uses, and the models.conf key holding its default model. */
const API_LANES: Record<string, { provider: string; label: RegExp; conf: string }> = {
  'opencode-zen': { provider: 'opencode', label: /opencode/i, conf: 'LANE_MODEL_OPENCODE_ZEN' },
  openrouter: { provider: 'openrouter', label: /openrouter/i, conf: 'LANE_MODEL_OPENROUTER' },
  openai: { provider: 'openai', label: /^openai$|openai\b(?!.*codex)/i, conf: 'LANE_MODEL_OPENAI' },
};
const CONF_KEY: Record<string, string> = { claude: 'LANE_MODEL_CLAUDE', codex: 'LANE_MODEL_CODEX', ollama: 'LANE_MODEL_OLLAMA' };

const defaultExec: Exec = async (cmd, args) => {
  const run = promisify(execFile);
  // Run from a scratch directory so a CLI never picks up a project's settings or history.
  const out = await run((await findOnPath(cmd)) ?? cmd, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, cwd: tmpdir() });
  // `codex login status` reports on stderr; claude's JSON is on stdout and must stay clean.
  return out.stdout.trim() ? out.stdout : out.stderr;
};

export function parseClaudeUsage(text: string): LaneInfo['limits'] {
  const out: LaneInfo['limits'] = [];
  for (const m of text.matchAll(/^(Current [^:\n]+):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s*(.+?))?\s*$/gm)) {
    out.push({ label: m[1].replace(/^Current /, '').replace(/^./, (c) => c.toUpperCase()), usedPercent: Number(m[2]), resets: m[3] ?? null });
  }
  return out;
}

/** `opencode auth list` → the credential rows, e.g. [{ name: 'OpenRouter', type: 'api' }]. */
export function parseOpencodeAuth(text: string): Array<{ name: string; type: string }> {
  return text.replace(ANSI, '').split('\n').flatMap((l) => {
    const m = l.match(/^\s*●\s+(.+?)\s+(api|oauth|wellknown)\s*$/i);
    return m ? [{ name: m[1].trim(), type: m[2].toLowerCase() }] : [];
  });
}

/** `opencode stats --models` → recorded cost/messages per provider (first path segment of the model id). */
export function parseOpencodeStats(text: string): Record<string, { costUsd: number; messages: number }> {
  const out: Record<string, { costUsd: number; messages: number }> = {};
  let provider: string | null = null;
  let messages = 0;
  for (const raw of text.replace(ANSI, '').split('\n')) {
    const line = raw.replace(/[│├└┌┐┘┤─]/g, ' ').trim();
    if (/^[\w.~-]+\/[\w./~:-]+$/.test(line)) {
      provider = line.split('/')[0];
      messages = 0;
    } else if (provider && /^Messages\s+\d/.test(line)) {
      messages = Number(line.split(/\s+/).pop());
    } else if (provider && /^Cost\s+\$/.test(line)) {
      const cur = out[provider] ?? { costUsd: 0, messages: 0 };
      cur.costUsd += Number(line.split('$').pop());
      cur.messages += messages;
      out[provider] = cur;
      provider = null;
    }
  }
  return out;
}

export function parseModelsConf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of text.split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)=(.*?)\s*$/);
    if (m && !l.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

async function readRuns(path: string, now: Date) {
  const per = new Map<string, LaneInfo['runs'] & { lastModel: string | null }>();
  let lines: string[] = [];
  try {
    lines = (await readFile(path, 'utf8')).trim().split('\n').slice(-500);
  } catch {
    /* no ledger yet */
  }
  for (const line of lines) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(r.endedAt ?? r.startedAt);
    if (!r.lane || !Number.isFinite(at) || now.getTime() - at > RUN_WINDOW_MS) continue;
    const cur = per.get(r.lane) ?? { total: 0, failed: 0, lastAt: null, lastStatus: null, lastNote: null, lastModel: null };
    cur.total++;
    if (r.status !== 0) cur.failed++;
    if (!cur.lastAt || at >= Date.parse(cur.lastAt)) {
      cur.lastAt = new Date(at).toISOString();
      cur.lastStatus = r.status === 0 ? 'ok' : 'failed';
      cur.lastNote = r.status === 0 ? null : String(r.note ?? '').slice(0, 160) || null;
      cur.lastModel = r.model ? String(r.model) : cur.lastModel;
    }
    per.set(r.lane, cur);
  }
  return per;
}

export function lanesSource(opts: Opts): Source {
  const exec = opts.exec ?? defaultExec;
  const hasCommand = opts.hasCommand ?? onPath;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const cache = new Map<string, { at: number; value: any }>();

  /** Slow or networked checks are cached so a 2-minute refresh doesn't hammer the CLIs. */
  async function cached<T>(key: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    let value: T;
    try {
      value = await fn();
    } catch {
      value = hit?.value ?? fallback;
    }
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  async function probeApi(name: string, conf: Record<string, string>): Promise<Partial<LaneInfo>> {
    const spec = API_LANES[name];
    const creds = await cached('opencode:auth', async () => parseOpencodeAuth(await exec('opencode', ['auth', 'list'])), []);
    const hasCred = creds.some((c) => spec.label.test(c.name));
    const modelCount = await cached(`opencode:models:${spec.provider}`, async () => {
      const out = (await exec('opencode', ['models', spec.provider])).replace(ANSI, '');
      return out.split('\n').filter((l) => l.startsWith(spec.provider + '/')).length;
    }, 0);
    const stats = await cached('opencode:stats', async () => parseOpencodeStats(await exec('opencode', ['stats', '--days', '30', '--models'])), {});
    const spend = stats[spec.provider] ?? null;
    const model = conf[spec.conf] || null;
    if (name === 'opencode-zen') {
      // The free models need no key; a key unlocks the paid ones.
      if (!hasCred && !modelCount) return { login: 'none', detail: 'OpenCode Zen models unavailable — run `opencode auth login`', model, spend };
      return { login: 'ok', plan: hasCred ? 'API key' : 'free models', detail: hasCred ? `${modelCount} models` : `${modelCount} free models, no key needed; add a Zen key with \`opencode auth login\` for paid ones`, model, spend };
    }
    if (!hasCred) return { login: 'none', detail: `not set up — run \`opencode auth login\` and choose ${name === 'openai' ? 'OpenAI' : 'OpenRouter'}`, model, spend };
    return { login: 'ok', plan: 'API key', detail: modelCount ? `${modelCount} models available` : 'key present', model, spend };
  }

  async function probe(name: string, conf: Record<string, string>): Promise<Partial<LaneInfo>> {
    const model = conf[CONF_KEY[name] ?? ''] || null;
    if (name === 'claude') {
      const auth = await cached('claude:auth', async () => {
        const j = JSON.parse(await exec('claude', ['auth', 'status']));
        return { login: j.loggedIn ? ('ok' as const) : ('no' as const), plan: j.subscriptionType ? String(j.subscriptionType) : null,
          detail: j.loggedIn ? `logged in via ${j.authMethod ?? 'login'}` : 'not logged in — run `claude auth login`' };
      }, {});
      const usage = await cached('claude:usage', async () => {
        const limits = parseClaudeUsage(await exec('claude', ['-p', '/usage']));
        return { limits, limitsSource: limits.length ? 'claude /usage (subscription, this machine)' : null };
      }, {});
      return { ...auth, ...usage, model };
    }
    if (name === 'codex') {
      const auth = await cached('codex:auth', async () => {
        const out = await exec('codex', ['login', 'status']);
        return /logged in/i.test(out) ? { login: 'ok' as const, detail: out.trim().split('\n')[0] } : { login: 'no' as const, detail: 'not logged in — run `codex login`' };
      }, {});
      return { ...auth, model };
    }
    if (name === 'ollama') {
      const base = opts.ollamaUrl ?? 'http://127.0.0.1:11434';
      const o = await cached('ollama', async () => {
        const tags = (await (await doFetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) })).json()) as { models?: unknown[] };
        const ps = (await (await doFetch(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) })).json()) as { models?: Array<{ name?: string }> };
        return { count: tags.models?.length ?? 0, loaded: (ps.models ?? []).map((m) => String(m.name)).filter(Boolean) };
      }, null as { count: number; loaded: string[] } | null);
      if (!o) return { login: 'no', detail: 'Ollama is not reachable at ' + base, model };
      return { login: 'ok', modelsNow: o.loaded, model, detail: `reachable · ${o.count} models installed` };
    }
    if (API_LANES[name]) return probeApi(name, conf);
    return { login: 'unknown', detail: 'no check available for this lane' };
  }

  return async () => {
    const t = now();
    const runs = await readRuns(opts.ledgerPath, t);
    let conf: Record<string, string> = {};
    try {
      if (opts.modelsPath) conf = parseModelsConf(await readFile(opts.modelsPath, 'utf8'));
    } catch {
      /* optional */
    }
    const lanes: LaneInfo[] = await Promise.all(
      opts.lanes.map(async (name) => {
        const cmd = API_LANES[name] ? 'opencode' : name;
        const installed = await hasCommand(cmd);
        const r = runs.get(name);
        const info: LaneInfo = {
          name, kind: API_LANES[name] ? 'api' : name === 'ollama' ? 'local' : 'cli',
          status: 'unknown', installed, login: 'unknown', plan: null, detail: installed ? '' : `${cmd} is not installed`,
          limits: [], limitsSource: null, model: null, modelsNow: [], lastModel: r?.lastModel ?? null, spend: null,
          runs: r ? { total: r.total, failed: r.failed, lastAt: r.lastAt, lastStatus: r.lastStatus, lastNote: r.lastNote } : { total: 0, failed: 0, lastAt: null, lastStatus: null, lastNote: null },
        };
        if (installed) {
          try {
            Object.assign(info, await probe(name, conf));
          } catch (e) {
            info.detail = `status check failed (${(e as Error).message.slice(0, 80)})`;
          }
        }
        info.status = laneStatus(info);
        return info;
      }),
    );
    return { cards: [], errors: [], lanes };
  };
}

/** Red = cannot work, amber = degraded or at risk, grey = never set up or nothing to judge by yet. */
export function laneStatus(l: Pick<LaneInfo, 'installed' | 'login' | 'limits' | 'runs'>): Status {
  if (!l.installed) return 'alert';
  if (l.login === 'none') return 'unknown'; // never set up is a choice, not a fault
  if (l.login === 'no') return 'alert';
  if (l.limits.some((x) => x.usedPercent >= 100)) return 'alert';
  if (l.runs.lastStatus === 'failed') return 'alert';
  if (l.limits.some((x) => x.usedPercent >= 85)) return 'warn';
  if (l.runs.failed > 0) return 'warn';
  if (l.login === 'unknown' && !l.runs.total) return 'unknown';
  return 'ok';
}
