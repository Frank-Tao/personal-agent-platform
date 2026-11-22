import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GROUPS } from '../apps/cockpit/src/types.ts';
import { ledgers } from '../apps/cockpit/src/sources/usage.ts';
import { modelOf } from '../apps/cockpit/src/sources/agents.ts';
import { type CatalogEntry, expandHome, loadCatalog, searchCatalog } from '../packages/roster/catalog.ts';
import { type StaffingAgent, evaluateStaffing } from '../packages/roster/staffing.ts';
import {
  type AgentDef, type Effort, type ModelRef, type Persona, type Registry, EFFORTS, HERMES_EFFORT, chainProblem, mergedChain, modelChain, lintPersona, loadRegistry, mergeSoul, parseFrontmatter, renderSoul, servesPortfolio, sha256, trimPersona, validateRegistry,
} from '../packages/roster/roster.ts';
import { engineeringBlock, mergeEngineering } from '../packages/roster/engineering.ts';
import { liveConfig } from '../packages/paths/paths.ts';

// Set up agents and link them to portfolios. Dry run unless --apply.
//
//   agents catalog sync                      get the agency-agents catalog (pinned commit)
//   agents catalog search <words…> [--division d] [--limit n]
//   agents catalog show <division/slug>      persona header, size and red-flag lint
//   agents add <division/slug> --id x [--profile p] [--name N] [--role R] [--portfolios a,b] [--lanes l,m]
//                                            [--model m] [--provider p] [--accept-warnings] [--registry-only]
//   agents link <id> <portfolio>             serve one more portfolio      (portfolio '*' = all)
//   agents unlink <id> <portfolio>
//   agents sync [--only id]                  make Hermes match config/agents.json (profile, persona, description, model, skills per config/skills.json)
//   agents set <id> [--model m] [--provider p] [--lanes a,b | --add-lane l] [--role R] [--name N]   change an existing agent's settings
//   agents set <id> --chain '[{"provider":"p","model":"m"}, …]'   first choice, second choice, fallback (1 to 3, in this order; Hermes tries the next when one fails)
//   agents set <id> --emoji 🧭              the icon shown in Cockpit (catalog personas bring their own)
//   agents merge <into> --from a,b [--name N] [--role R] [--emoji E] [--omit "<from>:Heading;Heading"] [--registry-only]
//                                            fold agents into one: their personas are added (trimmed), the best model leads the chain, portfolios and lanes
//                                            are joined, open tasks move over, the old Hermes profiles are exported to a file and removed
//   agents list
//   agents suggest --task "<text>" --portfolio <id> [--body "<text>"] [--json]
//                                            does the team cover this task? which catalog specialists would? (heuristic)
//   agents models [--json]                   model choices that exist on this machine, with rate-limit status

const root = resolve(import.meta.dirname, '..');
const PORTFOLIOS = GROUPS.map((g) => g.id as string);

interface Ctx {
  registryPath: string;
  hermesBin: string;
  hermesHome: string;
  out: (s: string) => void;
  run: (cmd: string, args: string[]) => string;
  apply: boolean;
  flags: Map<string, string | true>;
  pos: string[];
}

const tilde = expandHome;

function parseArgs(argv: string[]): { pos: string[]; flags: Map<string, string | true> } {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags.set(k, v);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && !['apply', 'accept-warnings', 'accept-drift', 'registry-only', 'json', 'skills-only'].includes(k)) flags.set(k, argv[++i]);
      else flags.set(k, true);
    } else pos.push(a);
  }
  return { pos, flags };
}
const flag = (c: Ctx, k: string): string | undefined => (typeof c.flags.get(k) === 'string' ? (c.flags.get(k) as string) : undefined);
const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

/* ---------- registry + catalog ---------- */

function save(c: Ctx, reg: Registry, why: string) {
  c.out(`  ${c.apply ? '✓' : '·'} registry: ${why}`);
  if (!c.apply) return;
  mkdirSync(dirname(c.registryPath), { recursive: true });
  writeFileSync(c.registryPath, JSON.stringify(reg, null, 2) + '\n');
}

function catalogDir(reg: Registry) {
  return tilde(reg.catalog.dir);
}

function catalogIndex(reg: Registry): CatalogEntry[] {
  const dir = catalogDir(reg);
  if (!existsSync(dir)) throw new Error(`catalog not found at ${dir} — run: agents catalog sync --apply`);
  return loadCatalog(dir);
}

function readPersona(c: Ctx, reg: Registry, slug: string) {
  const entry = catalogIndex(reg).find((e) => e.slug === slug);
  if (!entry) throw new Error(`no persona "${slug}" in the catalog (try: agents catalog search <words>)`);
  const text = readFileSync(entry.file, 'utf8');
  const { meta, body } = parseFrontmatter(text);
  const lint = lintPersona(body);
  return { entry, meta, body, hash: sha256(text), warnings: lint.flags, notes: lint.notes };
}

function gitHead(dir: string, c: Ctx): string {
  try {
    return c.run('git', ['-C', dir, 'rev-parse', 'HEAD']).trim();
  } catch {
    return '';
  }
}

/* ---------- commands ---------- */

function catalogSync(c: Ctx, reg: Registry) {
  const dir = catalogDir(reg);
  const { repo, commit } = reg.catalog;
  c.out(`catalog: ${repo}${commit ? ` @ ${commit.slice(0, 10)}` : ' (not pinned yet)'} → ${dir}`);
  const steps: Array<[string, string[]]> = existsSync(join(dir, '.git'))
    ? [['git', ['-C', dir, 'fetch', '--depth', '1', 'origin', commit || 'HEAD']], ['git', ['-C', dir, 'checkout', '-q', commit || 'FETCH_HEAD']]]
    : [['git', ['clone', '-q', '--no-checkout', '--depth', '1', repo, dir]], ...(commit ? ([['git', ['-C', dir, 'fetch', '--depth', '1', 'origin', commit]]] as Array<[string, string[]]>) : []), ['git', ['-C', dir, 'checkout', '-q', commit || 'HEAD']]];
  for (const [cmd, a] of steps) {
    c.out(`  ${c.apply ? '+' : '·'} ${cmd} ${a.join(' ')}`);
    if (c.apply) c.run(cmd, a);
  }
  if (c.apply) {
    const head = gitHead(dir, c);
    if (head && !commit) {
      reg.catalog.commit = head;
      save(c, reg, `pinned the catalog to ${head.slice(0, 10)} (review personas before installing; update the pin deliberately)`);
    }
    c.out(`  ✓ ${catalogIndex(reg).length} personas available`);
  } else c.out('(dry run — add --apply)');
}

function catalogSearch(c: Ctx, reg: Registry) {
  const query = c.pos.slice(2).join(' ');
  const hits = searchCatalog(catalogIndex(reg), query, { division: flag(c, 'division'), limit: Number(flag(c, 'limit') ?? 12) });
  if (!hits.length) c.out('no matches');
  for (const { e } of hits) c.out(`${e.emoji || ' '} ${e.slug.padEnd(52)} ${e.name} — ${e.description.slice(0, 90)}`);
}

function catalogShow(c: Ctx, reg: Registry) {
  const slug = c.pos[2];
  if (!slug) throw new Error('usage: agents catalog show <division/slug>');
  const p = readPersona(c, reg, slug);
  c.out(`${p.entry.emoji} ${p.entry.name}  (${p.entry.slug}, ${(p.body.length / 1000).toFixed(1)} KB, sha ${p.hash.slice(0, 10)})`);
  c.out(p.entry.description);
  if (p.entry.vibe) c.out(`vibe: ${p.entry.vibe}`);
  c.out(p.warnings.length ? `lint: ⚠ ${p.warnings.join('; ')}` : 'lint: no red flags found (read it anyway — it becomes part of the agent’s system prompt)');
  for (const n of p.notes) c.out(`note: ${n}`);
  c.out('---');
  c.out(p.body.split('\n').slice(0, 22).join('\n'));
}

const soulPath = (c: Ctx, profile: string) => (profile === 'default' ? join(c.hermesHome, 'SOUL.md') : join(c.hermesHome, 'profiles', profile, 'SOUL.md'));

function writeSoul(c: Ctx, def: AgentDef, personaBody: string | null, fresh: boolean, also: Array<{ name: string; body: string }> = []) {
  const path = soulPath(c, def.profile);
  const block = renderSoul(def, personaBody, also);
  const existing = !fresh && existsSync(path) ? readFileSync(path, 'utf8') : '';
  const next = mergeEngineering(fresh ? block : mergeSoul(existing, block), engineeringBlock(def.engineering === true));
  c.out(`  ${c.apply ? '✓' : '·'} SOUL.md ${fresh ? 'written' : 'updated (roster block only)'}${def.engineering ? ' + engineering rules' : ''} → ${path} (${next.length} chars)`);
  if (c.apply) writeFileSync(path, next);
}

/** An existing profile the roster does not manage: only the engineering block is written (or removed), nothing else in its SOUL.md. */
function writeEngineeringOnly(c: Ctx, def: AgentDef) {
  const path = soulPath(c, def.profile);
  if (!existsSync(path)) return;
  const existing = readFileSync(path, 'utf8');
  const next = mergeEngineering(existing, engineeringBlock(def.engineering === true));
  if (next === existing) return;
  c.out(`  ${c.apply ? '✓' : '·'} SOUL.md engineering rules ${def.engineering ? 'written' : 'removed'} → ${path}`);
  if (c.apply) writeFileSync(path, next);
}

/** Every agent's Hermes profile (and the default one) thinks at the chosen level, whatever model it runs. */
function applyEffort(c: Ctx, reg: Registry) {
  if (!reg.effort) return;
  const v = HERMES_EFFORT[reg.effort];
  for (const profile of new Set(['default', ...reg.agents.map((a) => a.profile)])) {
    if (!profileExists(c, profile)) continue;
    c.out(`  ${c.apply ? '+' : '·'} ${c.hermesBin} -p ${profile} config set agent.reasoning_effort ${v}`);
    if (c.apply) c.run(c.hermesBin, ['-p', profile, 'config', 'set', 'agent.reasoning_effort', v]);
  }
}

function cmdEffort(c: Ctx, reg: Registry) {
  const level = c.pos[1];
  if (!level) { c.out(`effort: ${reg.effort ?? 'normal'}`); return; }
  if (!EFFORTS.includes(level as Effort)) throw new Error(`effort must be one of: ${EFFORTS.join(', ')}`);
  const next: Registry = { ...reg, effort: level as Effort };
  save(c, next, `effort ${level}`);
  applyEffort(c, next);
  if (!c.apply) c.out('(dry run — add --apply)');
}

function profileExists(c: Ctx, profile: string) {
  return profile === 'default' || existsSync(join(c.hermesHome, 'profiles', profile));
}

function syncAgent(c: Ctx, reg: Registry, def: AgentDef) {
  c.out(`${def.name} (${def.id} → profile ${def.profile})`);
  if (!def.managed) {
    c.out('  · not managed by the roster (existing profile): persona and model left alone');
    return writeEngineeringOnly(c, def);
  }
  // Read and verify the persona first: a refused sync must not leave a half-created profile behind.
  let body: string | null = null;
  if (def.persona) {
    const p = readPersona(c, reg, def.persona.slug);
    if (p.hash !== def.persona.sha256 && !c.flags.get('accept-drift')) {
      throw new Error(`persona ${def.persona.slug} changed since it was added (sha ${def.persona.sha256.slice(0, 10)} → ${p.hash.slice(0, 10)}). Read the diff, then re-run with --accept-drift`);
    }
    const t = trimPersona(p.body, def.persona.omit ?? []);
    if (t.dropped.length) c.out(`  · persona: left out ${t.dropped.length} section${t.dropped.length === 1 ? '' : 's'} (${t.dropped.join('; ')})`);
    if (t.unmatched.length) c.out(`  ⚠ persona omit matched no heading: ${t.unmatched.join('; ')} (typo, or the catalog text changed)`);
    body = t.body;
  }
  // Personas merged into this agent: each verified and trimmed the same way.
  const also: Array<{ name: string; body: string }> = [];
  for (const ap of def.also ?? []) {
    const p = readPersona(c, reg, ap.slug);
    if (p.hash !== ap.sha256 && !c.flags.get('accept-drift')) throw new Error(`persona ${ap.slug} changed since it was added (sha ${ap.sha256.slice(0, 10)} → ${p.hash.slice(0, 10)}). Read the diff, then re-run with --accept-drift`);
    const t = trimPersona(p.body, ap.omit ?? []);
    c.out(`  · also ${ap.name}: ${t.dropped.length ? `left out ${t.dropped.length} section${t.dropped.length === 1 ? '' : 's'}, ` : ''}${(t.body.length / 1000).toFixed(1)} KB`);
    if (t.unmatched.length) c.out(`  ⚠ ${ap.name}: omit matched no heading: ${t.unmatched.join('; ')}`);
    also.push({ name: ap.name, body: t.body });
  }
  let fresh = false;
  if (!profileExists(c, def.profile)) {
    // --clone brings the model credentials so the agent can work; its SOUL.md is replaced below.
    const args = ['profile', 'create', def.profile, '--clone', '--no-alias', '--description', def.role.slice(0, 200)];
    c.out(`  ${c.apply ? '+' : '·'} ${c.hermesBin} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    if (c.apply) c.run(c.hermesBin, args);
    fresh = true;
  }
  writeSoul(c, def, body, fresh, also);
  const desc = ['profile', 'describe', def.profile, '--text', def.role.slice(0, 300)];
  c.out(`  ${c.apply ? '+' : '·'} ${c.hermesBin} ${desc.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}   (Atlas routes tasks by this text)`);
  if (c.apply && def.profile !== 'default') c.run(c.hermesBin, desc);
  if (def.model) {
    for (const [k, v] of [['model.default', def.model], ...(def.provider ? [['model.provider', def.provider]] : [])] as string[][]) {
      c.out(`  ${c.apply ? '+' : '·'} ${c.hermesBin} -p ${def.profile} config set ${k} ${v}`);
      if (c.apply) c.run(c.hermesBin, ['-p', def.profile, 'config', 'set', k, v]);
    }
    if (def.fallbacks?.length) writeFallbacks(c, def.profile, def.fallbacks);
  }
}

/** The live Hermes profile's fallback chain (what is tried when the first model fails). An empty list turns fallbacks off for that profile. */
function writeFallbacks(c: Ctx, profile: string, list: NonNullable<AgentDef['fallbacks']>) {
  const json = JSON.stringify(list.map((f) => ({ provider: f.provider, model: f.model, ...(f.base_url ? { base_url: f.base_url } : {}) })));
  c.out(`  ${c.apply ? '+' : '·'} ${c.hermesBin} -p ${profile} config set fallback_providers ${json}`);
  if (c.apply) c.run(c.hermesBin, ['-p', profile, 'config', 'set', 'fallback_providers', json]);
}

function cmdAdd(c: Ctx, reg: Registry) {
  const slug = c.pos[1];
  const id = flag(c, 'id');
  if (!slug || !id) throw new Error('usage: agents add <division/slug> --id <id> [--profile p] [--portfolios a,b] …');
  const p = readPersona(c, reg, slug);
  const def: AgentDef = {
    id, profile: flag(c, 'profile') ?? id, name: flag(c, 'name') ?? p.entry.name, role: flag(c, 'role') ?? p.entry.description,
    managed: true,
    persona: { slug, name: p.entry.name, emoji: p.entry.emoji || undefined, division: p.entry.division, vibe: p.entry.vibe || undefined, sha256: p.hash, commit: reg.catalog.commit || gitHead(catalogDir(reg), c) },
    lanes: list(flag(c, 'lanes')), model: flag(c, 'model'), provider: flag(c, 'provider'), portfolios: list(flag(c, 'portfolios')),
  };
  const next: Registry = { ...reg, agents: [...reg.agents.filter((a) => a.id !== id), def] };
  const errs = validateRegistry(next, PORTFOLIOS);
  if (errs.length) throw new Error(errs.join('\n'));
  c.out(`add ${p.entry.emoji} ${def.name} as "${id}" → portfolios: ${def.portfolios.join(', ') || '(none yet; use: agents link)'}`);
  for (const n of p.notes) c.out(`  note: persona ${n}`);
  if (p.warnings.length) {
    c.out(`  ⚠ persona lint: ${p.warnings.join('; ')}`);
    if (c.apply && !c.flags.get('accept-warnings')) throw new Error('refusing to apply with persona warnings; read `agents catalog show` and re-run with --accept-warnings if you accept them');
  }
  save(c, next, `agent ${id} added`);
  if (c.flags.get('registry-only')) c.out('  · registry only: Hermes is untouched; Cockpit shows the agent as "proposed" until `agents sync --apply`');
  else { syncAgent(c, next, def); syncSkills(c, def); }
  if (!c.apply) c.out('(dry run — add --apply)');
}

function cmdLink(c: Ctx, reg: Registry, on: boolean) {
  const [, id, portfolio] = c.pos;
  if (!id || !portfolio) throw new Error(`usage: agents ${on ? 'link' : 'unlink'} <agent id> <portfolio>   (portfolios: ${PORTFOLIOS.join(', ')}, or *)`);
  const def = reg.agents.find((a) => a.id === id);
  if (!def) throw new Error(`no agent "${id}" (see: agents list)`);
  const portfolios = on ? [...new Set([...def.portfolios, portfolio])] : def.portfolios.filter((p) => p !== portfolio);
  const next: Registry = { ...reg, agents: reg.agents.map((a) => (a.id === id ? { ...a, portfolios } : a)) };
  const errs = validateRegistry(next, PORTFOLIOS);
  if (errs.length) throw new Error(errs.join('\n'));
  save(c, next, `${id} ${on ? 'now serves' : 'no longer serves'} ${portfolio} → [${portfolios.join(', ')}]`);
  if (!c.flags.get('registry-only')) syncAgent(c, next, next.agents.find((a) => a.id === id)!);
  if (!c.apply) c.out('(dry run — add --apply)');
}

/** agents merge <into> --from a,b: one agent in place of several. Dry run unless --apply. */
function cmdMerge(c: Ctx, reg: Registry) {
  const into = c.pos[1];
  const from = list(flag(c, 'from'));
  const survivor = reg.agents.find((a) => a.id === into);
  if (!into || !survivor || !from.length) throw new Error('usage: agents merge <agent to keep> --from <a,b> [--name N] [--role R] [--emoji E] [--omit "<agent>:Heading;Heading"] [--registry-only] [--apply]');
  const gone = from.map((id) => { const a = reg.agents.find((x) => x.id === id); if (!a) throw new Error(`no agent "${id}" (see: agents list)`); return a; });
  if (gone.some((a) => a.id === into)) throw new Error('the agent to keep cannot also be merged away');
  for (const a of [survivor, ...gone]) if (!a.managed || a.profile === 'default' || a.id === 'personal') throw new Error(`${a.id} cannot be merged: only managed roster agents can (Atlas, existing profiles and Personal Privacy stay as they are)`);
  const registryOnly = c.flags.get('registry-only') === true;

  // persona trimming for the merged-in personas: --omit "marketer:Heading one;Heading two" (several --omit allowed via repeated flag as ";;")
  const omitFor = (id: string): string[] => String(flag(c, 'omit') ?? '').split(';;').map((x) => x.trim()).filter((x) => x.startsWith(id + ':')).flatMap((x) => x.slice(id.length + 1).split(';').map((h) => h.trim()).filter(Boolean));
  const also: Persona[] = [...(survivor.also ?? [])];
  for (const g of gone) {
    if (g.persona) also.push({ ...g.persona, omit: [...new Set([...(g.persona.omit ?? []), ...omitFor(g.id)])] });
    for (const x of g.also ?? []) also.push(x);
  }
  const chains = [survivor, ...gone].map(modelChain);
  const chain = mergedChain(chains);
  const lanes = [...new Set([survivor, ...gone].flatMap((a) => a.lanes))];
  const portfolios = [...new Set([survivor, ...gone].flatMap((a) => a.portfolios))];
  const next: AgentDef = {
    ...survivor, name: flag(c, 'name') ?? survivor.name, role: flag(c, 'role') ?? survivor.role, emoji: flag(c, 'emoji') ?? survivor.emoji, lanes, portfolios,
    model: chain[0]?.model, provider: chain[0]?.provider, ...(chain.length > 1 ? { fallbacks: chain.slice(1) } : {}), also,
    merged_from: [...new Set([...(survivor.merged_from ?? []), ...gone.flatMap((a) => [a.id, ...(a.merged_from ?? [])])])],
  };
  if (chain.length <= 1) delete next.fallbacks;
  const problem = chainProblem(chain);
  if (problem) throw new Error(problem);

  c.out(`merge ${gone.map((a) => a.id).join(' + ')} into ${into} (${next.name})`);
  c.out(`  models: ${chains.map((ch, i) => `${[survivor, ...gone][i].id}: ${ch.map((m) => m.model).join(' › ') || '—'}`).join(' · ')}`);
  c.out(`  → best first: ${chain.map((m) => m.model).join(' › ')}`);
  c.out(`  portfolios: ${portfolios.join(', ')} · lanes: ${lanes.join(', ')} · personas: ${[next.persona?.name, ...also.map((p) => p.name)].filter(Boolean).join(' + ')}`);

  // open tasks of the agents that go move to the one that stays; a profile with scheduled jobs is not removed
  const boardsDir = join(c.hermesHome, 'kanban', 'boards');
  const boards = existsSync(boardsDir) ? readdirSync(boardsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name) : [];
  const moves: Array<{ board: string; id: string; title: string; from: string }> = [];
  if (!registryOnly) {
    for (const g of gone) {
      const jobs = join(c.hermesHome, 'profiles', g.profile, 'cron', 'jobs.json');
      if (existsSync(jobs) && ((JSON.parse(readFileSync(jobs, 'utf8')) as { jobs?: unknown[] }).jobs ?? []).length) throw new Error(`${g.id} has scheduled jobs (${jobs}): move or remove them first`);
      for (const b of boards) {
        let tasks: Array<{ id: string; title: string; status: string; assignee: string | null }> = [];
        try { tasks = JSON.parse(c.run(c.hermesBin, ['kanban', '--board', b, 'list', '--json'])); } catch { continue; }
        for (const t of tasks) if (t.assignee === g.profile && !['done', 'archived'].includes(t.status)) moves.push({ board: b, id: t.id, title: t.title, from: g.profile });
      }
    }
    for (const m of moves) c.out(`  ${c.apply ? '→' : '·'} ${m.board}: ${m.id} (${m.from}) → ${survivor.profile}: ${m.title.slice(0, 60)}`);
    if (!moves.length) c.out('  · no open tasks to move');
  }
  const exportDir = join(c.hermesHome, 'profile-exports');
  if (!registryOnly) for (const g of gone) c.out(`  ${c.apply ? '■' : '·'} ${g.profile}: export to ${exportDir.replace(homedir(), '~')}/ then remove the profile (undo: hermes profile import <file>, and add it to the roster again)`);
  c.out(`  ${c.apply ? '✓' : '·'} roster: ${gone.map((a) => a.id).join(', ')} removed, ${into} updated${registryOnly ? ' (registry only: no Hermes changes)' : ''}`);
  if (!c.apply) { c.out('(dry run — add --apply)'); return; }

  if (!registryOnly) {
    for (const m of moves) c.run(c.hermesBin, ['kanban', '--board', m.board, 'reassign', m.id, survivor.profile]);
    for (const g of gone) {
      if (!profileExists(c, g.profile)) continue;
      mkdirSync(exportDir, { recursive: true });
      const file = join(exportDir, `${g.profile}-${new Date().toISOString().slice(0, 10)}.tar.gz`);
      c.run(c.hermesBin, ['profile', 'export', g.profile, '-o', file]);
      if (!existsSync(file)) throw new Error(`the export of ${g.profile} did not produce ${file}: nothing was removed`);
      c.run(c.hermesBin, ['profile', 'delete', g.profile, '--yes']);
    }
  }
  save(c, { ...reg, agents: reg.agents.filter((a) => !from.includes(a.id)).map((a) => (a.id === into ? next : a)) }, `merged ${from.join(', ')} into ${into}`);
  if (!registryOnly) c.out(`  next: agents sync --only ${into} --apply   (writes the merged persona, model chain and the profile description Atlas routes by)`);
}

function cmdSet(c: Ctx, reg: Registry) {
  const id = c.pos[1];
  const def = reg.agents.find((a) => a.id === id);
  if (!id || !def) throw new Error(`usage: agents set <agent id> [--model m] [--provider p] [--chain '[…]'] [--lanes a,b] [--role R] [--name N]  (see: agents list)`);
  // --chain: the whole ordered list at once (first choice, second choice, fallback). It replaces --model/--provider and the fallbacks.
  let chain: ModelRef[] | null = null;
  if (flag(c, 'chain') !== undefined) {
    try { chain = JSON.parse(flag(c, 'chain')!) as ModelRef[]; } catch { throw new Error('--chain must be a JSON list like [{"provider":"anthropic","model":"claude-sonnet-5-5"}]'); }
    if (!Array.isArray(chain)) throw new Error('--chain must be a JSON list');
    chain = chain.map((m) => ({ model: String(m?.model ?? ''), provider: String(m?.provider ?? ''), ...(m?.base_url ? { base_url: String(m.base_url) } : {}) }));
    const problem = chainProblem(chain, (m) => (def.id === 'personal' && !/^(custom:local|ollama)/.test(m.provider) ? 'the Personal Privacy agent may only use models that run on this Mac, as first choice and as fallback' : null));
    if (problem) throw new Error(problem);
  }
  const addLanes = flag(c, 'add-lanes') ? list(flag(c, 'add-lanes')).filter((l) => !def.lanes.includes(l)) : [];
  const next: AgentDef = {
    ...def,
    model: chain ? chain[0].model : flag(c, 'model') ?? def.model, provider: chain ? chain[0].provider : flag(c, 'provider') ?? def.provider, emoji: flag(c, 'emoji') ?? def.emoji, name: flag(c, 'name') ?? def.name, role: flag(c, 'role') ?? def.role,
    lanes: flag(c, 'lanes') !== undefined ? list(flag(c, 'lanes')) : flag(c, 'add-lane') && !def.lanes.includes(flag(c, 'add-lane')!) ? [...def.lanes, flag(c, 'add-lane')!, ...addLanes] : addLanes.length ? [...def.lanes, ...addLanes] : def.lanes,
  };
  if (chain) { if (chain.length > 1) next.fallbacks = chain.slice(1); else delete next.fallbacks; }
  if (def.id === 'personal' && (next.provider ?? '') && !/^(custom:local|ollama)/.test(next.provider!)) throw new Error('the Personal Privacy agent may only use a model that runs on this Mac (provider custom:local-ai or ollama)');
  const changed = (['model', 'provider', 'fallbacks', 'name', 'role', 'lanes', 'emoji'] as const).filter((k) => JSON.stringify(next[k] ?? null) !== JSON.stringify(def[k] ?? null));
  if (!changed.length) throw new Error('nothing to change: pass --chain, --model, --provider, --lanes, --role, --name or --emoji');
  const show = (k: (typeof changed)[number]) => k === 'fallbacks' ? (next.fallbacks?.length ? next.fallbacks.map((f) => f.model).join(' › ') : 'none') : Array.isArray(next[k]) ? (next[k] as string[]).join(',') : String(next[k]);
  save(c, { ...reg, agents: reg.agents.map((a) => (a.id === id ? next : a)) }, `${id}: ${changed.map((k) => `${k} → ${show(k)}`).join(', ')}`);
  // Switching a model takes effect now, for managed and unmanaged agents alike: the live Hermes profile's config is updated too.
  if (profileExists(c, def.profile) && (changed.includes('model') || changed.includes('provider'))) {
    for (const [k, v] of [['model.default', next.model], ['model.provider', next.provider]] as Array<[string, string | undefined]>) {
      if (!v) continue;
      c.out(`  ${c.apply ? '+' : '·'} ${c.hermesBin} -p ${def.profile} config set ${k} ${v}`);
      if (c.apply) c.run(c.hermesBin, ['-p', def.profile, 'config', 'set', k, v]);
    }
  }
  if (profileExists(c, def.profile) && changed.includes('fallbacks')) writeFallbacks(c, def.profile, next.fallbacks ?? []);
  if (profileExists(c, def.profile) && def.profile !== 'default' && (changed.includes('role') || changed.includes('name'))) {
    c.out(`  ${c.apply ? '+' : '·'} ${c.hermesBin} profile describe ${def.profile} --text …`);
    if (c.apply) c.run(c.hermesBin, ['profile', 'describe', def.profile, '--text', next.role.slice(0, 300)]);
  }
  if (profileExists(c, def.profile) && def.managed && (changed.includes('lanes') || changed.includes('role') || changed.includes('name'))) c.out('  · run `agents sync --only ' + id + ' --apply` to refresh its prompt (roster block) with the new lanes/role');
  if (!c.apply) c.out('(dry run — add --apply)');
}

// ---- skills: mandatory set + per-agent keep list (config/skills.json) ----
interface SkillsConfig { mandatory: Record<string, string[]>; agents: Record<string, string[]> }

/** Every enabled-candidate skill in a profile: declared name (frontmatter, else folder name) → folder. Hidden folders (.archive, .hub) are skipped, as Hermes does. */
export function installedSkills(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const sub = join(d, e.name);
      if (existsSync(join(sub, 'SKILL.md'))) {
        const m = readFileSync(join(sub, 'SKILL.md'), 'utf8').match(/^---\n[\s\S]*?^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
        found.set(m ? m[1].trim() : e.name, sub);
      } else walk(sub);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

function syncSkills(c: Ctx, def: AgentDef) {
  const cfgPath = join(dirname(c.registryPath), 'skills.json');
  if (!existsSync(cfgPath)) return;
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as SkillsConfig;
  if (!cfg.agents[def.id] && !cfg.mandatory[def.id]) return c.out(`  · skills: ${def.id} is not in config/skills.json: left alone`);
  if (!profileExists(c, def.profile)) return c.out('  · skills: profile not created yet');
  const home = def.profile === 'default' ? c.hermesHome : join(c.hermesHome, 'profiles', def.profile);
  const dir = join(home, 'skills');
  const keep = [...new Set([...(cfg.mandatory[def.id] ?? cfg.mandatory.all ?? []), ...(cfg.agents[def.id] ?? [])])];
  let have = installedSkills(dir);
  const bundled = installedSkills(join(c.hermesHome, 'hermes-agent', 'skills'));   // Hermes' own skills (e.g. sdlc-review): the fallback source
  for (const name of keep) {
    const src = existsSync(join(root, 'hermes', 'skills', name, 'SKILL.md')) ? join(root, 'hermes', 'skills', name) : bundled.get(name) ?? join(root, 'hermes', 'skills', name);
    if (!have.has(name) && existsSync(join(src, 'SKILL.md'))) {
      c.out(`  ${c.apply ? '+' : '·'} skill ${name} installed from ${src.startsWith(root) ? 'hermes/skills/' : 'Hermes\' bundled skills'}`);
      if (c.apply) { mkdirSync(dir, { recursive: true }); cpSync(src, join(dir, name), { recursive: true }); }
      have = new Map(have).set(name, join(dir, name));
    }
  }
  const missing = keep.filter((n) => !have.has(n));
  if (missing.length) c.out(`  ⚠ skills not installed anywhere (ignored): ${missing.join(', ')}`);
  const disabled = [...have.keys()].filter((n) => !keep.includes(n)).sort();
  c.out(`  ${c.apply ? '+' : '·'} skills: keep ${keep.length - missing.length}, disable ${disabled.length} (${[...have.keys()].length} installed)`);
  if (c.apply) c.run(c.hermesBin, ['-p', def.profile, 'config', 'set', 'skills.disabled', JSON.stringify(disabled)]);
}

function cmdSync(c: Ctx, reg: Registry) {
  const errs = validateRegistry(reg, PORTFOLIOS);
  if (errs.length) throw new Error(errs.join('\n'));
  const only = flag(c, 'only');
  for (const def of reg.agents.filter((a) => !only || a.id === only)) { if (!c.flags.get('skills-only')) syncAgent(c, reg, def); syncSkills(c, def); }
  if (!c.apply) c.out('(dry run — add --apply)');
}

function cmdList(c: Ctx, reg: Registry) {
  c.out(`${'id'.padEnd(14)}${'profile'.padEnd(14)}${'state'.padEnd(11)}${'portfolios'.padEnd(34)}persona`);
  for (const a of reg.agents) {
    const state = profileExists(c, a.profile) ? 'active' : 'proposed';
    c.out(`${a.id.padEnd(14)}${a.profile.padEnd(14)}${state.padEnd(11)}${(a.portfolios.includes('*') ? 'all' : a.portfolios.join(', ') || '—').padEnd(34)}${a.persona?.slug ?? '—'}`);
  }
  c.out('');
  for (const g of PORTFOLIOS) c.out(`${g.padEnd(13)} ← ${reg.agents.filter((a) => servesPortfolio(a, g)).map((a) => a.id).join(', ') || '—'}`);
}

/* ---------- suggest: does the team cover a task? ---------- */

function staffingAgents(c: Ctx, reg: Registry): StaffingAgent[] {
  return reg.agents.map((a) => ({
    id: a.id, name: a.name, role: a.role, profile: a.profile, state: profileExists(c, a.profile) ? 'active' : 'proposed',
    portfolios: a.portfolios.filter((p) => p !== '*'), allPortfolios: a.portfolios.includes('*'),
    personaName: a.persona?.name ?? null, personaSlug: a.persona?.slug ?? null, division: a.persona?.division ?? null,
  }));
}

function cmdSuggest(c: Ctx, reg: Registry) {
  const title = flag(c, 'task');
  const portfolio = flag(c, 'portfolio');
  if (!title || !portfolio) throw new Error('usage: agents suggest --task "<text>" --portfolio <id> [--body "<text>"] [--json]');
  if (!PORTFOLIOS.includes(portfolio)) throw new Error(`unknown portfolio "${portfolio}" (known: ${PORTFOLIOS.join(', ')})`);
  const catalog = existsSync(catalogDir(reg)) ? loadCatalog(catalogDir(reg)) : [];
  const r = evaluateStaffing({ title, body: flag(c, 'body'), portfolio }, staffingAgents(c, reg), catalog);
  if (c.flags.get('json')) return c.out(JSON.stringify({ ...r, catalogAvailable: catalog.length > 0, note: r.note + ' (keyword heuristic: judge it, do not trust it blindly)' }, null, 2));
  c.out(`${r.verdict.toUpperCase()} (${r.confidence} confidence) — ${r.note}`);
  for (const b of r.best) c.out(`  team: ${b.id} (${b.state}) score ${b.score} [${b.matched.join(', ')}]`);
  for (const k of r.candidates) c.out(`  catalog: ${k.emoji} ${k.slug} — ${k.name} (${(k.bytes / 1000).toFixed(0)} KB) score ${k.score} [${k.matched.join(', ')}]`);
  if (!catalog.length) c.out('  (catalog not synced: run agents catalog sync --apply to get specialist suggestions)');
}

/* ---------- models: what can a new agent run on? ---------- */

interface ModelOption {
  provider: string;
  model: string | null;
  sessions30d: number;
  lastUsed: string | null;
  billing: string;
  status: 'ok' | 'rate-limited';
  note: string;
}

/** `hermes auth list` → providers that have a credential, and whether it is currently rate-limited. */
export function parseAuthList(text: string): Array<{ provider: string; status: 'ok' | 'rate-limited'; note: string }> {
  const out: Array<{ provider: string; status: 'ok' | 'rate-limited'; note: string }> = [];
  let cur: (typeof out)[number] | null = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^([a-z0-9:_-]+) \((\d+) credentials?\):/i);
    if (h) {
      cur = { provider: h[1], status: 'ok', note: '' };
      out.push(cur);
    } else if (cur && /rate-limited|exhausted/i.test(line)) {
      cur.status = 'rate-limited';
      cur.note = (line.match(/(rate-limited[^\n]*|exhausted[^\n]*)/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
    }
  }
  return out;
}

const BILLING: Record<string, string> = {
  'openai-codex': 'subscription (no per-token cost, but a weekly limit)',
  'opencode-zen': 'API key; its free models cost nothing',
  anthropic: 'API key (pay per token)',
  openrouter: 'API key (pay per token)',
};

function modelOptions(c: Ctx): ModelOption[] {
  let providers: ReturnType<typeof parseAuthList> = [];
  try {
    providers = parseAuthList(c.run(c.hermesBin, ['auth', 'list']));
  } catch {
    /* no credential info: still list what the ledgers show */
  }
  const seen = new Map<string, ModelOption>();
  const since = Date.now() / 1000 - 30 * 86_400;
  for (const l of ledgers(c.hermesHome)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(l.path, { readOnly: true });
      for (const r of db.prepare(`SELECT billing_provider bp, model, COUNT(*) n, MAX(started_at) last FROM sessions
          WHERE started_at >= ? AND COALESCE(billing_provider,'')<>'' AND COALESCE(model,'')<>'' AND model NOT IN ('auto') GROUP BY bp, model`).all(since) as Array<{ bp: string; model: string; n: number; last: number }>) {
        const key = `${r.bp}\u0000${r.model}`;
        const cur = seen.get(key) ?? { provider: r.bp, model: r.model, sessions30d: 0, lastUsed: null, billing: BILLING[r.bp] ?? 'unknown', status: 'ok' as const, note: '' };
        cur.sessions30d += r.n;
        const iso = new Date(r.last * 1000).toISOString();
        if (!cur.lastUsed || iso > cur.lastUsed) cur.lastUsed = iso;
        seen.set(key, cur);
      }
    } catch {
      /* unreadable ledger: skip it */
    } finally {
      db?.close();
    }
  }
  const options = [...seen.values()];
  for (const o of options) {
    const p = providers.find((x) => x.provider === o.provider);
    if (p) Object.assign(o, { status: p.status, note: p.note });
  }
  // Providers with a credential but no recent sessions: the model name is the user's to choose.
  for (const p of providers) {
    if (!options.some((o) => o.provider === p.provider)) options.push({ provider: p.provider, model: null, sessions30d: 0, lastUsed: null, billing: BILLING[p.provider] ?? 'unknown', status: p.status, note: p.note || 'credential present, no recent use: choose a model name yourself' });
  }
  // The local model: private, free, slower.
  try {
    for (const line of c.run('ollama', ['list']).split('\n').slice(1)) {
      const name = line.trim().split(/\s+/)[0];
      if (name) options.push({ provider: 'ollama (local)', model: name, sessions30d: 0, lastUsed: null, billing: 'local: free and private, slower', status: 'ok', note: '' });
    }
  } catch {
    /* ollama not installed */
  }
  let def = { model: null as string | null, provider: null as string | null };
  try {
    def = modelOf(readFileSync(join(c.hermesHome, 'config.yaml'), 'utf8'));
  } catch {
    /* default unknown */
  }
  const rank = (o: ModelOption) => (o.status === 'rate-limited' ? 1 : 0) * 1e6 - o.sessions30d;
  return options.sort((a, b) => rank(a) - rank(b)).map((o) => ({ ...o, note: o.note || (o.model === def.model && o.provider === def.provider ? 'current default of the default profile' : '') }));
}

function cmdModels(c: Ctx) {
  const opts = modelOptions(c);
  if (c.flags.get('json')) return c.out(JSON.stringify(opts, null, 2));
  c.out(`${'provider'.padEnd(16)}${'model'.padEnd(26)}${'30d'.padEnd(6)}${'status'.padEnd(14)}billing`);
  for (const o of opts) c.out(`${o.provider.padEnd(16)}${(o.model ?? '—').padEnd(26)}${String(o.sessions30d).padEnd(6)}${(o.status === 'ok' ? 'ok' : o.note || 'rate-limited').slice(0, 13).padEnd(14)}${o.billing}`);
}

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, out: (s: string) => void = console.log, run?: Ctx['run']): number {
  const { pos, flags } = parseArgs(argv);
  const c: Ctx = {
    registryPath: env.AGENTS_REGISTRY ?? liveConfig('agents.json', env),
    hermesBin: env.HERMES_BIN ?? join(homedir(), '.local', 'bin', 'hermes'),
    hermesHome: env.HERMES_HOME ?? join(homedir(), '.hermes'),
    out, apply: flags.get('apply') === true, flags, pos,
    run: run ?? ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })),
  };
  try {
    const reg = loadRegistry(c.registryPath);
    const [cmd, sub] = pos;
    if (cmd === 'catalog' && sub === 'sync') catalogSync(c, reg);
    else if (cmd === 'catalog' && sub === 'search') catalogSearch(c, reg);
    else if (cmd === 'catalog' && sub === 'show') catalogShow(c, reg);
    else if (cmd === 'add') cmdAdd(c, reg);
    else if (cmd === 'link') cmdLink(c, reg, true);
    else if (cmd === 'unlink') cmdLink(c, reg, false);
    else if (cmd === 'sync') { cmdSync(c, reg); applyEffort(c, reg); }
    else if (cmd === 'effort') cmdEffort(c, reg);
    else if (cmd === 'set') cmdSet(c, reg);
    else if (cmd === 'merge') cmdMerge(c, reg);
    else if (cmd === 'list') cmdList(c, reg);
    else if (cmd === 'suggest') cmdSuggest(c, reg);
    else if (cmd === 'models') cmdModels(c);
    else {
      out('usage: agents <catalog sync|search|show | add | link | unlink | set | effort | sync | list | suggest | models> … [--apply]');
      return cmd ? 2 : 0;
    }
    return 0;
  } catch (e) {
    out(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) process.exit(main(process.argv.slice(2)));
