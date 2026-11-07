import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../../../../packages/redact/redact.ts';
import { loadCatalogCached } from '../../../../packages/roster/catalog.ts';
import { SOUL_BEGIN, SOUL_END, loadRegistry, parseFrontmatter, sha256 } from '../../../../packages/roster/roster.ts';

// What an agent is made of, straight from its Hermes profile folder (read-only):
//   prompt   SOUL.md          the identity text in every turn's system prompt (+ the persona block we installed)
//   skills   skills/**/SKILL.md + .usage.json + .bundled_manifest   what it can do, and what it has learned
//   memory   memories/MEMORY.md, USER.md                            what it remembers (size-capped by Hermes)
// Memory and prompts can hold personal details, so text is masked (PII patterns and key-like strings) before it is
// shown. The files themselves are never changed.

const PLATFORM_SKILLS = new Set(['cockpit', 'agent-lanes', 'agent-roster', 'agent-staffing']);

export interface SkillItem {
  name: string;
  category: string;
  description: string;
  /** bundled = shipped with Hermes; platform = installed by this repo; agent = written by the agent itself (Hermes' created_by);
   *  hub = installed from a skill hub (.hub/lock.json); added = anything else (imported or placed by hand). */
  source: 'bundled' | 'platform' | 'agent' | 'hub' | 'added';
  /** Hermes' curator marks skills nobody has used for a long time as stale. */
  stale: boolean;
  uses: number;
  lastUsedAt: string | null;
  patches: number;
  createdAt: string | null;
  pinned: boolean;
}

export interface MemoryFile {
  exists: boolean;
  text: string;
  chars: number;
  limit: number;
  /** sha256 of the file as it is on disk (not the masked text): sent back with an edit so a file that changed meanwhile is not overwritten. */
  sha: string | null;
}

export interface AgentDetail {
  id: string;
  profile: string;
  name: string;
  dir: string;
  prompt: {
    exists: boolean;
    text: string;
    chars: number;
    sha: string | null;
    roster: { installed: boolean; personaSlug: string | null; recordedSha: string | null; currentSha: string | null; drift: 'current' | 'changed' | 'catalog-missing' | null };
  };
  skills: { total: number; bundled: number; platform: number; agent: number; hub: number; added: number; archived: number; byCategory: Array<{ category: string; count: number }>; items: SkillItem[] };
  memory: { memory: MemoryFile; user: MemoryFile };
  masked: true;
}

const TOKEN_LIKE: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, /\bghp_[A-Za-z0-9]{20,}\b/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];
/** `password: hunter2`, `api_key = abc123…`: keep the label, hide the value. */
const KEY_VALUE = /\b(api[_-]?key|secret|token|password|passwd)(\s*[:=]\s*)(["']?)[^\s"']{6,}\3/gi;

/** PII patterns and key-like strings replaced by markers. Order matters: secrets first, then the PII filter. */
export function maskSensitive(text: string): string {
  let out = text;
  for (const re of TOKEN_LIKE) out = out.replace(re, '[MASKED:secret]');
  out = out.replace(KEY_VALUE, (_m, label: string, sep: string, quote: string) => `${label}${sep}${quote}[MASKED]${quote}`);
  return redact(out);
}

export const profileDir = (home: string, profile: string) => (profile === 'default' ? home : join(home, 'profiles', profile));

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function limitsOf(dir: string): { memory: number; user: number } {
  const yaml = read(join(dir, 'config.yaml')) ?? '';
  const num = (key: string, d: number) => Number(yaml.match(new RegExp(`^\\s+${key}:\\s*(\\d+)`, 'm'))?.[1] ?? d);
  return { memory: num('memory_char_limit', 2200), user: num('user_char_limit', 1375) };
}

function memoryFile(path: string, limit: number): MemoryFile {
  const raw = read(path);
  return { exists: raw !== null, text: raw === null ? '' : maskSensitive(raw), chars: raw?.length ?? 0, limit, sha: raw === null ? null : sha256(raw) };
}

function skillFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // .archive, .hub, .curator_* are bookkeeping, not skills
      if (e.isDirectory() && depth < 3) walk(join(dir, e.name), depth + 1);
      else if (e.isFile() && e.name === 'SKILL.md') out.push(join(dir, e.name));
    }
  };
  walk(root, 0);
  return out;
}

function readSkills(dir: string): AgentDetail['skills'] {
  const root = join(dir, 'skills');
  const bundled = new Set((read(join(root, '.bundled_manifest')) ?? '').split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean));
  let usage: Record<string, any> = {};
  try {
    usage = JSON.parse(read(join(root, '.usage.json')) ?? '{}');
  } catch {
    /* no usage data */
  }
  let hub = new Set<string>();
  try {
    hub = new Set(Object.keys(JSON.parse(read(join(root, '.hub', 'lock.json')) ?? '{}').installed ?? {}));
  } catch {
    /* no hub lock */
  }
  const items: SkillItem[] = [];
  for (const file of skillFiles(root)) {
    const rel = file.slice(root.length + 1).split('/');
    const { meta } = parseFrontmatter(read(file) ?? '');
    const name = meta.name || rel[rel.length - 2] || 'unnamed';
    const u = usage[name] ?? {};
    if (u.state === 'archived') continue;
    items.push({
      name, category: rel.length > 2 ? rel[0] : '(top level)', description: (meta.description ?? '').slice(0, 220),
      source: PLATFORM_SKILLS.has(name) ? 'platform' : u.created_by === 'agent' ? 'agent' : bundled.has(name) ? 'bundled' : hub.has(name) ? 'hub' : 'added',
      stale: u.state === 'stale',
      uses: Number(u.use_count ?? 0), lastUsedAt: u.last_used_at ?? null, patches: Number(u.patch_count ?? 0), createdAt: u.created_at ?? null, pinned: !!u.pinned,
    });
  }
  items.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  const cats = new Map<string, number>();
  for (const i of items) cats.set(i.category, (cats.get(i.category) ?? 0) + 1);
  const archived = Object.values(usage).filter((u: any) => u?.state === 'archived').length;
  return {
    total: items.length, bundled: items.filter((i) => i.source === 'bundled').length, platform: items.filter((i) => i.source === 'platform').length,
    agent: items.filter((i) => i.source === 'agent').length, hub: items.filter((i) => i.source === 'hub').length, added: items.filter((i) => i.source === 'added').length, archived,
    byCategory: [...cats.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)), items,
  };
}

export function agentDetail(opts: { home: string; registryPath: string; id: string }): AgentDetail | null {
  const reg = loadRegistry(opts.registryPath);
  const def = reg.agents.find((a) => a.id === opts.id);
  // Profiles the roster does not list can still be inspected by profile name.
  const profile = def?.profile ?? opts.id;
  const dir = profileDir(opts.home, profile);
  if (!/^[a-z0-9][a-z0-9-]{0,31}$|^default$/.test(profile) || !existsSync(dir) || !statSync(dir).isDirectory()) return null;

  const soulRaw = read(join(dir, 'SOUL.md'));
  const installed = !!soulRaw && soulRaw.includes(SOUL_BEGIN) && soulRaw.includes(SOUL_END);
  let currentSha: string | null = null;
  let drift: AgentDetail['prompt']['roster']['drift'] = null;
  if (def?.persona) {
    const entry = loadCatalogCached(reg.catalog.dir).find((e) => e.slug === def.persona!.slug);
    const text = entry ? read(entry.file) : null;
    currentSha = text === null ? null : sha256(text);
    drift = currentSha === null ? 'catalog-missing' : currentSha === def.persona.sha256 ? 'current' : 'changed';
  }
  const lim = limitsOf(dir);
  return {
    id: def?.id ?? opts.id, profile, name: def?.name ?? profile, dir: dir.replace(opts.home, '~/.hermes'),
    prompt: {
      exists: soulRaw !== null, text: soulRaw === null ? '' : maskSensitive(soulRaw), chars: soulRaw?.length ?? 0, sha: soulRaw === null ? null : sha256(soulRaw),
      roster: { installed, personaSlug: def?.persona?.slug ?? null, recordedSha: def?.persona?.sha256 ?? null, currentSha, drift },
    },
    skills: readSkills(dir),
    memory: { memory: memoryFile(join(dir, 'memories', 'MEMORY.md'), lim.memory), user: memoryFile(join(dir, 'memories', 'USER.md'), lim.user) },
    masked: true,
  };
}

export class DocError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const DOC_FILES = { soul: 'SOUL.md', memory: 'memories/MEMORY.md', user: 'memories/USER.md' } as const;
export type DocKey = keyof typeof DOC_FILES;

/** Edit one of an agent's three text files from Cockpit. Only these fixed files; the old version is kept next to it (.bak-<time>);
 *  a file that changed since it was opened (sha mismatch) is not overwritten; text containing a masked placeholder is refused, because
 *  Cockpit shows masked text and saving it would replace real values with the placeholder. */
export function saveAgentDoc(opts: { home: string; registryPath: string; id: string; file: string; text: unknown; base: unknown; now?: () => Date }): AgentDetail {
  const detail = agentDetail(opts);
  if (!detail) throw new DocError('no such agent profile', 404);
  if (!(opts.file in DOC_FILES)) throw new DocError('unknown file');
  const key = opts.file as DocKey;
  if (typeof opts.text !== 'string' || opts.text.length > 200_000) throw new DocError('text must be a string of at most 200000 characters');
  if (/\[MASKED/.test(opts.text)) throw new DocError('this text contains a masked placeholder ([MASKED…]); Cockpit hides sensitive values, so saving would overwrite them. Edit the file directly instead.', 409);
  const dir = profileDir(opts.home, detail.profile);
  const path = join(dir, DOC_FILES[key]);
  const current = read(path);
  const curSha = current === null ? null : sha256(current);
  if ((opts.base ?? null) !== curSha) throw new DocError('the file changed since you opened it; reload and try again', 409);
  const text = opts.text.endsWith('\n') ? opts.text : opts.text + '\n';
  if (key !== 'soul') {
    const lim = limitsOf(dir)[key === 'memory' ? 'memory' : 'user'];
    if (text.length > lim) throw new DocError(`Hermes caps this file at ${lim} characters; this text is ${text.length}`, 413);
  }
  if (current !== null) { const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[-:]/g, '').slice(0, 15); copyFileSync(path, `${path}.bak-${stamp}`); }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return agentDetail(opts)!;
}
