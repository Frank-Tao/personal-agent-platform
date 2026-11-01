import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadRegistry, servesPortfolio, type AgentDef } from '../../../../packages/roster/roster.ts';
import type { AgentInfo, PortfolioCard, Source, Status, TaskCounts, UsageStats } from '../types.ts';

// Agents as the roster (config/agents.json) declares them, checked against what Hermes really has:
//   <home>/profiles/<name>/            the profile exists (or is the default profile = Atlas)
//   <profile>/config.yaml              the model it runs on
// The rollup adds each agent's 7-day usage (from the session ledgers) and task counts (from the kanban boards).
// Read-only: creating or linking agents is the job of `npm run agents`, never of Cockpit.

interface Opts {
  home: string;
  registryPath: string;
  /** Portfolio ids, to expand '*' to "all of them". */
  portfolios: string[];
}

const zero = (): TaskCounts => ({ running: 0, ready: 0, review: 0, blocked: 0, done: 0 });

/** The default profile's config lives in <home>, every other profile's under profiles/<name>. */
const profileDir = (home: string, profile: string) => (profile === 'default' ? home : join(home, 'profiles', profile));

/** `model:` block of a Hermes config.yaml — only default + provider, without a YAML dependency. */
export function modelOf(yaml: string): { model: string | null; provider: string | null } {
  const lines = yaml.split('\n');
  const i = lines.findIndex((l) => /^model:\s*$/.test(l));
  if (i === -1) return { model: null, provider: null };
  let model: string | null = null;
  let provider: string | null = null;
  for (const l of lines.slice(i + 1)) {
    if (/^\S/.test(l)) break; // next top-level key
    const d = l.match(/^\s+default:\s*(.+?)\s*$/);
    const p = l.match(/^\s+provider:\s*(.+?)\s*$/);
    if (d) model = d[1].replace(/^["']|["']$/g, '');
    if (p) provider = p[1].replace(/^["']|["']$/g, '');
  }
  return { model, provider };
}

function readModel(home: string, profile: string) {
  try {
    return modelOf(readFileSync(join(profileDir(home, profile), 'config.yaml'), 'utf8'));
  } catch {
    return { model: null, provider: null };
  }
}

export function agentsSource(opts: Opts): Source {
  return async () => {
    const reg = loadRegistry(opts.registryPath);
    const agents: AgentInfo[] = [];
    const exists = (profile: string) => profile === 'default' || existsSync(profileDir(opts.home, profile));

    for (const def of reg.agents) {
      const active = exists(def.profile);
      const { model, provider } = active ? readModel(opts.home, def.profile) : { model: null, provider: null };
      agents.push(toInfo(def, active ? 'active' : 'proposed', def.model ?? model, def.provider ?? provider, opts.portfolios));
    }

    // Hermes profiles the roster does not mention (e.g. other people's bots): listed, linked to nothing.
    const known = new Set(reg.agents.map((a) => a.profile));
    try {
      for (const d of readdirSync(join(opts.home, 'profiles'), { withFileTypes: true })) {
        if (!d.isDirectory() || known.has(d.name)) continue;
        const { model, provider } = readModel(opts.home, d.name);
        agents.push({
          id: d.name, profile: d.name, name: d.name, role: 'Hermes profile that is not in the roster', emoji: null, division: null, personaSlug: null,
          state: 'unlisted', managed: false, status: 'unknown', lanes: [], model, provider, portfolios: [], allPortfolios: false,
          tokens7d: 0, sessions7d: 0, lastAt: null, tasks: zero(), byPortfolio: {},
        });
      }
    } catch {
      /* no profiles directory */
    }
    return { cards: [], errors: [], agents };
  };
}

function toInfo(def: AgentDef, state: AgentInfo['state'], model: string | null, provider: string | null, portfolios: string[]): AgentInfo {
  return {
    id: def.id, profile: def.profile, name: def.name, role: def.role,
    emoji: def.persona?.emoji ?? null, division: def.persona?.division ?? null, personaSlug: def.persona?.slug ?? null,
    state, managed: def.managed, status: 'unknown', lanes: def.lanes, model, provider,
    portfolios: portfolios.filter((p) => servesPortfolio(def, p)), allPortfolios: def.portfolios.includes('*'),
    tokens7d: 0, sessions7d: 0, lastAt: null, tasks: zero(), byPortfolio: {},
  };
}

/** Add 7-day usage (per profile ledger) and kanban task counts (per assignee, per portfolio) to each agent. */
export function finalizeAgents(agents: AgentInfo[], usage: UsageStats | undefined, cards: PortfolioCard[]): AgentInfo[] {
  return agents.map((a) => {
    const rows = (usage?.channels ?? []).filter((c) => c.profile === a.profile);
    const tasks = zero();
    const byPortfolio: Record<string, TaskCounts> = {};
    for (const card of cards) {
      for (const t of card.team ?? []) {
        // Hermes assigns by profile name; the default profile (Atlas) may appear as 'default'.
        if (t.assignee !== a.profile && !(a.profile === 'default' && t.assignee === 'atlas')) continue;
        const cur = (byPortfolio[card.group] ??= zero());
        for (const k of ['running', 'ready', 'review', 'blocked', 'done'] as const) {
          cur[k] += t[k];
          tasks[k] += t[k];
        }
      }
    }
    const status: Status = a.state !== 'active' ? 'unknown' : tasks.blocked > 0 ? 'warn' : 'ok';
    return {
      ...a, status, tasks, byPortfolio,
      tokens7d: rows.reduce((n, c) => n + c.tokens, 0),
      sessions7d: rows.reduce((n, c) => n + c.sessions, 0),
      lastAt: rows.map((c) => c.lastAt).filter((x): x is string => !!x).sort().at(-1) ?? null,
    };
  });
}
