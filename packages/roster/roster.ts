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
}

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
  /** Portfolio ids this agent serves; '*' = all of them. */
  portfolios: string[];
}

export interface Registry {
  catalog: { repo: string; commit: string; dir: string };
  agents: AgentDef[];
}

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
      portfolios: Array.isArray(a.portfolios) ? a.portfolios.map(String) : [],
    })),
  };
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

/** The rules every roster agent works under, whatever its persona says (kept short on purpose). */
export const OPERATING_RULES = `## Operating rules (set by the platform, they outrank the persona above)

- You work for Frank through the kanban board: pick up tasks assigned to you, finish them, hand back a short summary.
- Use the agent-lanes skill for model work. Verify results yourself (diff, tests) before completing a task.
- Anything outward-facing (deploy, publish, send, spend, delete) goes to \`review\` for Frank's approval. Never do it yourself.
- Never handle raw personal-finance documents; that belongs to the local-only personal profile.
- Stay in your lane: do your specialty well and hand other work back to Atlas rather than improvising.
`;

export const SOUL_BEGIN = '<!-- agent-roster:begin -->';
export const SOUL_END = '<!-- agent-roster:end -->';

export function renderSoul(def: Pick<AgentDef, 'name' | 'role' | 'portfolios'>, personaBody: string | null): string {
  const intro = `# ${def.name}\n\n${def.role}\n\nPortfolios you serve: ${def.portfolios.includes('*') ? 'all' : def.portfolios.join(', ') || 'none yet'}.\n`;
  const persona = personaBody ? `\n## Persona\n\n${personaBody.trim()}\n` : '';
  return `${SOUL_BEGIN}\n${intro}${persona}\n${OPERATING_RULES}${SOUL_END}\n`;
}

/** Replace the roster block in an existing SOUL.md, or append it, leaving anything else untouched. */
export function mergeSoul(existing: string, block: string): string {
  const a = existing.indexOf(SOUL_BEGIN);
  const b = existing.indexOf(SOUL_END);
  if (a !== -1 && b > a) return existing.slice(0, a) + block + existing.slice(b + SOUL_END.length).replace(/^\n/, '');
  return existing.trim() ? `${existing.trimEnd()}\n\n${block}` : block;
}
