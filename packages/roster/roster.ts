import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// The roster: which agents exist, which portfolios each one serves, and where its persona came from.
//
//   agent     = one Hermes profile (its own memory, skills, model); tasks are assigned to it by profile name
//   portfolio = a Cockpit section (ai-thrival, micropace, ...); many agents per portfolio, many portfolios per agent
//   persona   = optional role text from the agency-agents catalog (github.com/msitarzewski/agency-agents),
//               pinned to a commit and recorded with a hash
// config/agents.json is the source of truth; `agents sync` makes Hermes match it, Cockpit only reads it.

export interface Persona {
  slug: string;
  name: string;
  emoji?: string;
  division: string;
  vibe?: string;
  sha256: string;
  commit: string;
  /** Headings to leave out of the installed persona (case-insensitive, matched inside the heading text; the section under it goes too).
   *  For catalog text that does not fit this platform (another stack, files that do not exist). The hash still covers the whole file. */
  omit?: string[];
}

/** One model an agent can run on. `base_url` only for providers that need it (OpenCode Zen); Hermes resolves the others by provider. */
export interface ModelRef { model: string; provider: string; base_url?: string }
/** First choice, second choice, fallback. */
export const MAX_CHAIN = 3;

export interface AgentDef {
  id: string;
  /** Hermes profile name ('default' is Atlas itself). */
  profile: string;
  name: string;
  role: string;
  /** false = an existing Hermes profile we only list; true = `agents sync` creates/updates it. */
  managed: boolean;
  persona?: Persona;
  /** Worker lanes this agent is expected to use (informational; routing lives in the agent-lanes skill). */
  lanes: string[];
  model?: string;
  provider?: string;
  /** The second choice and the fallback, in order (at most MAX_CHAIN - 1). Hermes tries each when the one before it fails (rate limit, overload, connection error). */
  fallbacks?: ModelRef[];
  /** Portfolio ids this agent serves; '*' = all of them. */
  portfolios: string[];
  /** true = it writes, changes or reviews code: `agents sync` adds the engineering rules (packages/roster/engineering.ts) to its SOUL.md. */
  engineering?: boolean;
  /** The icon shown in Cockpit. Falls back to the persona's emoji; agents without a catalog persona (Atlas, Coding, Personal Privacy) need their own. */
  emoji?: string;
  /** Further personas merged into this agent (`agents merge`): installed after the main persona, each with its own `omit` list. */
  also?: Persona[];
  /** Agents that were merged into this one (their profiles are archived): their past work still counts here in the track record. */
  merged_from?: string[];
}

/** How strong a model is, for picking the best of several when agents are merged: higher is better. Within a vendor the tiers are
 *  Opus > Sonnet > Haiku and Sol > Terra > Luna; across vendors the order is a judgment (Opus, Sol, Sonnet, Terra, Haiku, Luna), then free
 *  hosted models, then local ones. An unknown model ranks last. */
const MODEL_ORDER = ['claude-opus-5-5', 'gpt-6.1-sol', 'claude-sonnet-5-5', 'gpt-6.1-terra', 'claude-haiku-5-5', 'gpt-6-luna', 'glm-5.3-flash', 'deepseek-v4.1-flash', 'coding', 'qwen3.8'];
export const modelRank = (m: Pick<ModelRef, 'model'>): number => { const i = MODEL_ORDER.indexOf(m.model); return i === -1 ? -1 : MODEL_ORDER.length - i; };
/** One chain from several agents' chains: the best first choice among them, then their other models best first, each once, at most MAX_CHAIN. */
export function mergedChain(chains: ModelRef[][]): ModelRef[] {
  const all = chains.flat();
  const first = [...all].filter((m) => modelRank(m) >= 0).sort((a, b) => modelRank(b) - modelRank(a))[0] ?? all[0];
  const rest = all.filter((m) => m !== first).sort((a, b) => modelRank(b) - modelRank(a));
  const out: ModelRef[] = [];
  for (const m of [first, ...rest]) if (m && !out.some((o) => o.model === m.model && o.provider === m.provider)) out.push(m);
  return out.slice(0, MAX_CHAIN);
}

export interface Registry {
  catalog: { repo: string; commit: string; dir: string };
  agents: AgentDef[];
  /** How hard every agent's model thinks, whichever model it runs: one setting for all (Cockpit Settings). */
  effort?: Effort;
}

export type Effort = 'fast' | 'normal' | 'high' | 'max';
export const EFFORTS: Effort[] = ['fast', 'normal', 'high', 'max'];
/** What Hermes calls each level (agent.reasoning_effort; a model that has no such level is clamped by Hermes). */
export const HERMES_EFFORT: Record<Effort, string> = { fast: 'low', normal: 'medium', high: 'high', max: 'max' };

export const EMPTY_REGISTRY: Registry = {
  catalog: { repo: 'https://github.com/msitarzewski/agency-agents', commit: '', dir: '~/.local/share/agency-agents' },
  agents: [],
};

export function loadRegistry(path: string): Registry {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return structuredClone(EMPTY_REGISTRY);
  }
  return {
    catalog: { ...EMPTY_REGISTRY.catalog, ...(raw.catalog ?? {}) },
    ...(EFFORTS.includes(raw.effort) ? { effort: raw.effort as Effort } : {}),
    agents: (Array.isArray(raw.agents) ? raw.agents : []).map((a: any): AgentDef => ({
      id: String(a.id),
      profile: String(a.profile ?? a.id),
      name: String(a.name ?? a.id),
      role: String(a.role ?? ''),
      managed: a.managed !== false,
      persona: a.persona ? { ...a.persona } : undefined,
      lanes: Array.isArray(a.lanes) ? a.lanes.map(String) : [],
      model: a.model ? String(a.model) : undefined,
      provider: a.provider ? String(a.provider) : undefined,
      ...(Array.isArray(a.fallbacks) ? { fallbacks: a.fallbacks.filter((f: any) => f?.model && f?.provider).slice(0, MAX_CHAIN - 1).map((f: any): ModelRef => ({ model: String(f.model), provider: String(f.provider), ...(f.base_url ? { base_url: String(f.base_url) } : {}) })) } : {}),
      portfolios: Array.isArray(a.portfolios) ? a.portfolios.map(String) : [],
      ...(a.engineering === true ? { engineering: true } : {}),
      ...(typeof a.emoji === 'string' && a.emoji.trim() ? { emoji: a.emoji.trim().slice(0, 8) } : {}),
      ...(Array.isArray(a.also) && a.also.length ? { also: a.also.filter((p: any) => p?.slug).map((p: any): Persona => ({ ...p })) } : {}),
      ...(Array.isArray(a.merged_from) && a.merged_from.length ? { merged_from: a.merged_from.map(String) } : {}),
    })),
  };
}

/** The ordered models of an agent: first choice, then its fallbacks. Empty when no model is set (a proposed agent without one). */
export function modelChain(a: Pick<AgentDef, 'model' | 'provider' | 'fallbacks'>): ModelRef[] {
  return [...(a.model && a.provider ? [{ model: a.model, provider: a.provider }] : []), ...(a.fallbacks ?? [])];
}

/** Why a chain is not acceptable, or null: 1 to MAX_CHAIN entries, each a provider and a model, none twice. `allowed` rejects models the agent may not use. */
export function chainProblem(chain: ModelRef[], allowed?: (m: ModelRef) => string | null): string | null {
  if (!chain.length) return 'choose at least a first model';
  if (chain.length > MAX_CHAIN) return `at most ${MAX_CHAIN} models: a first choice, a second choice and a fallback`;
  const seen = new Set<string>();
  for (const m of chain) {
    if (!m.model || !m.provider) return 'every entry needs a provider and a model';
    const k = `${m.provider}\u0000${m.model}`;
    if (seen.has(k)) return `${m.model} is in the list twice: each choice must be a different model`;
    seen.add(k);
    const why = allowed?.(m); if (why) return why;
  }
  return null;
}

/** Problems that would make the roster ambiguous. Empty = fine. */
export function validateRegistry(reg: Registry, portfolioIds: string[]): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  const profiles = new Set<string>();
  for (const a of reg.agents) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(a.id)) errs.push(`agent id "${a.id}" must be lowercase letters, digits or dashes`);
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(a.profile) && a.profile !== 'default') errs.push(`profile "${a.profile}" (agent ${a.id}) must be lowercase alphanumeric`);
    if (ids.has(a.id)) errs.push(`duplicate agent id "${a.id}"`);
    if (profiles.has(a.profile)) errs.push(`profile "${a.profile}" is used by more than one agent`);
    ids.add(a.id);
    profiles.add(a.profile);
    for (const p of a.portfolios) if (p !== '*' && !portfolioIds.includes(p)) errs.push(`agent ${a.id}: unknown portfolio "${p}" (known: ${portfolioIds.join(', ')})`);
  }
  return errs;
}

export const servesPortfolio = (a: Pick<AgentDef, 'portfolios'>, portfolio: string): boolean => a.portfolios.includes('*') || a.portfolios.includes(portfolio);

/* ---------- catalog personas (agency-agents markdown with YAML frontmatter) ---------- */

export function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Persona text becomes part of an agent's system prompt, so it is read like code before it is installed.
 * `flags` are cheap, deterministic red flags — not a guarantee; the CLI refuses to apply with any unless
 * --accept-warnings. `notes` (size) are shown but never block.
 */
export function lintPersona(body: string): { flags: string[]; notes: string[] } {
  const w: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/\b(curl|wget)\b[^\n|]*\|\s*(ba|z)?sh\b/i, 'pipes a download into a shell'],
    [/\brm\s+-rf\s+(\/|~|\$HOME)/i, 'contains a destructive rm -rf'],
    [/ignore (all |any )?(the )?(previous|prior|above) (instructions|rules)/i, 'tells the model to ignore earlier instructions'],
    [/disregard (all |any )?(the )?(previous|prior|above|safety|system)/i, 'tells the model to disregard earlier instructions'],
    [/(send|post|upload|exfiltrate)[^\n]{0,40}(api[_ -]?key|password|secret|token|credential)/i, 'mentions sending secrets somewhere'],
    [/[A-Za-z0-9+/]{200,}={0,2}/, 'contains a long base64-like blob'],
    [/\bsudo\b/i, 'mentions sudo'],
  ];
  for (const [re, msg] of rules) if (re.test(body)) w.push(msg);
  // Size is a cost, not a safety problem: reported, never blocking.
  const notes = body.length > 14_000 ? [`is long (${Math.round(body.length / 1000)} KB) — it is added to every turn's system prompt`] : [];
  return { flags: w, notes };
}

const headingKey = (line: string) => line.replace(/^#+\s*/, '').replace(/[^\p{L}\p{N}&' -]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Leave sections out of a catalog persona: each heading that contains an `omit` entry goes, with everything under it up to the next
 * heading of the same or a higher level. Headings inside code fences (templates, shell comments) are text, not structure.
 * Also drops the catalog's "Instructions Reference" line, which points at files that do not exist here.
 * `unmatched` lists omit entries that matched no heading (a typo, or the upstream text changed).
 */
export function trimPersona(body: string, omit: string[]): { body: string; dropped: string[]; unmatched: string[] } {
  const wants = omit.map((o) => o.trim().toLowerCase()).filter(Boolean);
  const hit = new Set<string>();
  const dropped: string[] = [];
  const out: string[] = [];
  let fence = false;
  let skipLevel = 0; // > 0 while inside an omitted section of that heading level
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && !/^\s*(```|~~~)/.test(line) ? line.match(/^(#{1,6})\s+\S/) : null;
    if (h) {
      const level = h[1].length;
      if (skipLevel && level <= skipLevel) skipLevel = 0;
      if (!skipLevel) {
        const key = headingKey(line);
        const w = wants.find((x) => key.includes(x));
        if (w) { hit.add(w); dropped.push(key); skipLevel = level; continue; }
      }
    }
    if (skipLevel) continue;
    if (!fence && /^\*\*Instructions Reference\*\*/.test(line)) continue;
    out.push(line);
  }
  const text = out.join('\n').replace(/(\n---\s*)+\s*$/, '\n').replace(/\n{3,}/g, '\n\n');
  return { body: text, dropped, unmatched: wants.filter((w) => !hit.has(w)) };
}

/** The rules every roster agent works under, whatever its persona says (kept short on purpose). */
export const OPERATING_RULES = `## Operating rules (set by the platform, they outrank the persona above)

- You work for Frank through the kanban board: pick up tasks assigned to you, finish them, hand back a short summary.
- Use the agent-lanes skill for model work. Verify results yourself (diff, tests) before completing a task.
- Outward-facing means reaching people or systems outside the platform: email or messages to anyone who is not Frank, Diane or another approved recipient, public posts, deploys to a live host, spending money, deleting outside your workspace. Those go to \`review\` for Frank's approval; never do them yourself.
- NOT outward-facing, and needing no approval: git commits, branches, pushes, pull requests and merging them on the project's own repository (once the tests pass, with the evidence in the PR), writing to the KnowledgeBase and to files in your workspace, and Telegram messages to Frank or Diane. Do not block a task on these.
- Never handle raw personal-finance documents; that belongs to the local-only personal profile.
- Stay in your lane: do your specialty well and hand other work back to Atlas rather than improvising.
`;

export const SOUL_BEGIN = '<!-- agent-roster:begin -->';
export const SOUL_END = '<!-- agent-roster:end -->';

export function renderSoul(def: Pick<AgentDef, 'name' | 'role' | 'portfolios'>, personaBody: string | null, also: Array<{ name: string; body: string }> = []): string {
  const intro = `# ${def.name}\n\n${def.role}\n\nPortfolios you serve: ${def.portfolios.includes('*') ? 'all' : def.portfolios.join(', ') || 'none yet'}.\n`;
  const persona = (personaBody ? `\n## Persona\n\n${personaBody.trim()}\n` : '') + also.map((a) => `\n## Also: ${a.name} (merged into this role)\n\n${a.body.trim()}\n`).join('');
  return `${SOUL_BEGIN}\n${intro}${persona}\n${OPERATING_RULES}${SOUL_END}\n`;
}

/** Replace the roster block in an existing SOUL.md, or append it, leaving anything else untouched. */
export function mergeSoul(existing: string, block: string): string {
  const a = existing.indexOf(SOUL_BEGIN);
  const b = existing.indexOf(SOUL_END);
  if (a !== -1 && b > a) return existing.slice(0, a) + block + existing.slice(b + SOUL_END.length).replace(/^\n/, '');
  return existing.trim() ? `${existing.trimEnd()}\n\n${block}` : block;
}
