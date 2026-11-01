import { parseYaml, stringifyYaml, type Yaml } from './yaml.ts';

// Objectives, project charters and plans (docs/design/work-model.md). Pure functions: parsing, writing, validating.
// A human approves objectives and charters; everything below a charter (plan, tasks, assignments) is checked by code here.

export const STATUSES = ['proposed', 'active', 'paused', 'review', 'done', 'cancelled'] as const;
export type Status = (typeof STATUSES)[number];

/** What no charter can ever authorise (design §9). `normalizeCharter` re-adds anything missing. */
export const FLOOR = ['money-movement', 'private-finance-data', 'deleting-outside-workspace', 'changing-hermes-config', 'unapproved-recipients'] as const;
export const DEFAULT_ESCALATE = ['over-budget', 'over-timebox', 'scope-change', 'qa-fails-twice', 'new-recipient', 'new-agent'] as const;
export const MAX_TASKS = 9;
export const OUTWARD_KINDS = ['deploy', 'publish', 'spend'] as const;
export type OutwardKind = (typeof OUTWARD_KINDS)[number];

export interface Charter {
  outcome: string;
  done_when: string[];
  /** Agent ids the project may use. */
  team: string[];
  /** Catalog personas pre-approved for creation together with the project. */
  new_agents: Array<{ slug: string; id: string; model?: string; provider?: string }>;
  models: { default?: string; lanes: string[] };
  max_tasks: number;
  budget: { usd: number; lane_minutes: number };
  outward: {
    deploy: { allowed: boolean; targets: string[]; rollback: 'required' | 'optional' };
    publish: { allowed: 'no' | 'draft-only' | 'auto'; channels: string[]; max_per_week: number };
    spend: { allowed: boolean; max_usd: number };
  };
  never: string[];
  escalate_when: string[];
}

export interface Project {
  id: string;
  /** Display name; the id stays the stable key (file, kanban tenant). Empty = derived from the id. */
  name?: string | null;
  portfolio: string;
  objective: string | null;
  key_results: string[];
  status: Status;
  /** Always an agent id; `pm` by default. */
  owner: string;
  tenant: string;
  timebox: string;
  created: string;
  approved: string | null;
  repo: string | null;
  /** 1 (highest) to 5; the order agents' work is picked in. */
  priority: number;
  /** How agents check the repo, e.g. "npm test". */
  test_cmd: string | null;
  plan_sha: string | null;
  /** Set by the watchdog when it pauses a project; cleared on resume. */
  paused_reason: string | null;
  charter: Charter;
}

export interface PlanTask {
  key: string;
  title: string;
  owner: string;
  lane: string | null;
  model: string | null;
  provider: string | null;
  needs: string[];
  accept: string;
  outward: OutwardKind | null;
  workspace: string | null;
  max_runtime: string;
  goal: boolean;
}

export interface Objectives {
  portfolio: string;
  horizon: string;
  reviewed: string;
  items: Array<{ id: string; title: string; key_results: Array<{ id: string; text: string }> }>;
}

/* ---------- helpers ---------- */

const obj = (v: Yaml | undefined): { [k: string]: Yaml } => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v: Yaml | undefined): Yaml[] => (Array.isArray(v) ? v : []);
const strs = (v: Yaml | undefined): string[] => arr(v).map((x) => String(x));
const text = (v: Yaml | undefined, d = ''): string => (v === null || v === undefined ? d : String(v));
const num = (v: Yaml | undefined, d: number): number => (typeof v === 'number' ? v : d);
const nstr = (v: Yaml | undefined): string | null => (v === null || v === undefined || v === '' ? null : String(v));

export const SLUG = /^[a-z][a-z0-9-]{1,47}$/;
export const TASK_KEY = /^[a-z][a-z0-9-]{0,47}$/;

/** "7d", "48h", "2w" → hours. */
export function timeboxHours(tb: string): number | null {
  const m = tb.match(/^(\d+)\s*([hdw])$/);
  return m ? Number(m[1]) * { h: 1, d: 24, w: 168 }[m[2] as 'h'] : null;
}

/** Fill defaults and make the fixed floor impossible to remove. */
export function normalizeCharter(raw: Yaml | undefined): Charter {
  const c = obj(raw), o = obj(c.outward), d = obj(o.deploy), p = obj(o.publish), s = obj(o.spend), b = obj(c.budget), m = obj(c.models);
  return {
    outcome: text(c.outcome), done_when: strs(c.done_when), team: strs(c.team),
    new_agents: arr(c.new_agents).map((x) => { const a = obj(x); return { slug: text(a.slug), id: text(a.id), ...(nstr(a.model) ? { model: text(a.model) } : {}), ...(nstr(a.provider) ? { provider: text(a.provider) } : {}) }; }),
    models: { ...(nstr(m.default) ? { default: text(m.default) } : {}), lanes: strs(m.lanes) },
    max_tasks: num(c.max_tasks, MAX_TASKS),
    budget: { usd: num(b.usd, 0), lane_minutes: num(b.lane_minutes, 120) },
    outward: {
      deploy: { allowed: d.allowed === true, targets: strs(d.targets), rollback: d.rollback === 'optional' ? 'optional' : 'required' },
      publish: { allowed: p.allowed === 'auto' ? 'auto' : p.allowed === 'no' ? 'no' : 'draft-only', channels: strs(p.channels), max_per_week: num(p.max_per_week, 0) },
      spend: { allowed: s.allowed === true, max_usd: num(s.max_usd, 0) },
    },
    never: [...new Set([...FLOOR, ...strs(c.never)])],
    escalate_when: [...new Set([...DEFAULT_ESCALATE, ...strs(c.escalate_when)])],
  };
}

export function emptyCharter(over: Partial<Charter> = {}): Charter {
  return normalizeCharter({ ...over } as unknown as Yaml);
}

/* ---------- project file: front-matter (the charter) + body (context, plan, log) ---------- */

export function splitFile(md: string): { meta: Yaml; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { meta: parseYaml(m[1]), body: m[2] } : { meta: null, body: md };
}

export function parseProject(md: string): { project: Project; body: string } {
  const { meta, body } = splitFile(md);
  const m = obj(meta);
  const status = text(m.status, 'proposed') as Status;
  const id = text(m.id);
  return {
    project: {
      id, ...(nstr(m.name) ? { name: nstr(m.name) } : {}), portfolio: text(m.portfolio), objective: nstr(m.objective), key_results: strs(m.key_results), status,
      owner: text(m.owner, 'pm'), tenant: text(m.tenant, id), timebox: text(m.timebox, '7d'), created: text(m.created),
      approved: nstr(m.approved), repo: nstr(m.repo), priority: Math.min(5, Math.max(1, Math.round(num(m.priority, 3)))), test_cmd: nstr(m.test_cmd), plan_sha: nstr(m.plan_sha), paused_reason: nstr(m.paused_reason), charter: normalizeCharter(m.charter),
    },
    body,
  };
}

export function serializeProject(p: Project, body: string): string {
  const meta: { [k: string]: Yaml } = {
    id: p.id, ...(p.name ? { name: p.name } : {}), portfolio: p.portfolio, objective: p.objective, key_results: p.key_results, status: p.status, owner: p.owner, tenant: p.tenant,
    timebox: p.timebox, created: p.created, approved: p.approved, ...(p.repo ? { repo: p.repo } : {}), priority: p.priority, ...(p.test_cmd ? { test_cmd: p.test_cmd } : {}), ...(p.plan_sha ? { plan_sha: p.plan_sha } : {}), ...(p.paused_reason ? { paused_reason: p.paused_reason } : {}),
    charter: p.charter as unknown as Yaml,
  };
  return `---\n${stringifyYaml(meta)}---\n${body.startsWith('\n') ? '' : '\n'}${body}`;
}

export const BODY_TEMPLATE = `## Context and decisions (stamped into every task body)

<!-- decisions that apply to all tasks: names, formats, tone, links to the spec -->

## Plan

<!-- pm writes the plan here as a fenced yaml block; see docs/design/work-model.md §5.2 -->

## Log
`;

function section(body: string, heading: string): { start: number; end: number } | null {
  const re = new RegExp(`^## ${heading}\\b.*$`, 'm');
  const m = re.exec(body);
  if (!m) return null;
  const start = m.index + m[0].length;
  const next = /^## /m.exec(body.slice(start));
  return { start, end: next ? start + next.index : body.length };
}

export function sectionText(body: string, heading: string): string {
  const s = section(body, heading);
  return s ? body.slice(s.start, s.end).trim() : '';
}

/** The decisions that every task body must carry (the comment placeholder alone does not count). */
export const decisionsOf = (body: string): string => sectionText(body, 'Context and decisions').replace(/<!--[\s\S]*?-->/g, '').trim();

/** Add a dated bullet to "Context and decisions": it is stamped into every task body, so agents see it. */
export function addDecision(body: string, line: string, today: string): string {
  const s = section(body, 'Context and decisions');
  const entry = `- ${today} — ${line.replace(/\s+/g, ' ').trim()}`;
  if (!s) return `## Context and decisions\n\n${entry}\n\n${body}`;
  const head = body.slice(0, s.end).trimEnd();
  const tail = body.slice(s.end).replace(/^\n+/, '');
  return `${head}\n${entry}\n\n${tail}`;
}

export function readPlan(body: string): PlanTask[] | null {
  const sec = sectionText(body, 'Plan');
  const m = sec.match(/```ya?ml\n([\s\S]*?)```/);
  if (!m) return null;
  const doc = obj(parseYaml(m[1]));
  return arr(doc.tasks).map((x) => {
    const t = obj(x);
    const ow = nstr(t.outward);
    return {
      key: text(t.key), title: text(t.title), owner: text(t.owner), lane: nstr(t.lane), model: nstr(t.model), provider: nstr(t.provider),
      needs: strs(t.needs), accept: text(t.accept), outward: (OUTWARD_KINDS as readonly string[]).includes(ow ?? '') ? (ow as OutwardKind) : null,
      workspace: nstr(t.workspace), max_runtime: text(t.max_runtime, '2h'), goal: t.goal === true,
    };
  });
}

export function writePlan(body: string, tasks: PlanTask[]): string {
  const yaml = stringifyYaml({ tasks: tasks.map((t) => ({ key: t.key, title: t.title, owner: t.owner, lane: t.lane, model: t.model, needs: t.needs, accept: t.accept, outward: t.outward, ...(t.workspace ? { workspace: t.workspace } : {}), ...(t.max_runtime !== '2h' ? { max_runtime: t.max_runtime } : {}), ...(t.goal ? { goal: true } : {}) })) as unknown as Yaml });
  const block = `\n\`\`\`yaml\n${yaml}\`\`\`\n\n`;
  const s = section(body, 'Plan');
  return s ? body.slice(0, s.start) + block + body.slice(s.end) : body.trimEnd() + `\n\n## Plan\n${block}`;
}

/** Log lines, newest last, as written by appendLog. */
export const logOf = (body: string): string[] => sectionText(body, 'Log').split('\n').filter((l) => /^- \d{4}-\d{2}-\d{2} — /.test(l)).map((l) => l.slice(2));

export function appendLog(body: string, line: string, today: string): string {
  const entry = `- ${today} — ${line}`;
  const s = section(body, 'Log');
  if (!s) return `${body.trimEnd()}\n\n## Log\n${entry}\n`;
  const after = body.slice(s.end).replace(/^\n+/, '');
  return `${body.slice(0, s.end).trimEnd()}\n${entry}\n${after ? '\n' + after : ''}`;
}

/* ---------- objectives.md ---------- */

export function parseObjectives(md: string): Objectives {
  const { meta, body } = splitFile(md);
  const m = obj(meta);
  const items: Objectives['items'] = [];
  for (const block of body.split(/^## /m).slice(1)) {
    const [head, ...rest] = block.split('\n');
    const h = head.match(/^(O\d+)\s+(.*)$/);
    if (!h) continue;
    const key_results = rest.flatMap((l) => { const k = l.match(/^[-*]\s+(KR\d+\.\d+)\s+(.*)$/); return k ? [{ id: k[1], text: k[2].trim() }] : []; });
    items.push({ id: h[1], title: h[2].trim(), key_results });
  }
  return { portfolio: text(m.portfolio), horizon: text(m.horizon, 'rolling'), reviewed: text(m.reviewed), items };
}

export function serializeObjectives(o: Objectives): string {
  const head = stringifyYaml({ portfolio: o.portfolio, horizon: o.horizon, reviewed: o.reviewed });
  const body = o.items.map((i) => `## ${i.id} ${i.title}\n${i.key_results.map((k) => `- ${k.id} ${k.text}`).join('\n')}\n`).join('\n');
  return `---\n${head}---\n\n${body}`;
}

/* ---------- validation ---------- */

export interface AgentLite {
  id: string;
  profile: string;
  state: 'active' | 'proposed' | 'unlisted';
  portfolios: string[];
  allPortfolios: boolean;
}

export interface CheckContext {
  portfolios: string[];
  agents: AgentLite[];
  /** Catalog slugs, when the catalog is available (to validate `new_agents`). */
  catalogSlugs?: string[];
}

export interface Findings {
  errors: string[];
  warnings: string[];
}

const serves = (a: AgentLite, portfolio: string) => a.allPortfolios || a.portfolios.includes(portfolio);

export function checkCharter(p: Project, ctx: CheckContext): Findings {
  const errors: string[] = [], warnings: string[] = [];
  const c = p.charter;
  if (!SLUG.test(p.id)) errors.push(`id "${p.id}" must be 2–48 lowercase letters, digits or dashes`);
  if (!ctx.portfolios.includes(p.portfolio)) errors.push(`unknown portfolio "${p.portfolio}" (known: ${ctx.portfolios.join(', ')})`);
  if (!(STATUSES as readonly string[]).includes(p.status)) errors.push(`status "${p.status}" must be one of ${STATUSES.join(', ')}`);
  if (p.tenant !== p.id) errors.push('tenant must equal the project id (it is how Hermes groups the tasks)');
  if (!c.outcome.trim()) errors.push('charter.outcome is empty');
  if (!c.done_when.length) errors.push('charter.done_when needs at least one verifiable condition');
  if (c.max_tasks < 1 || c.max_tasks > MAX_TASKS) errors.push(`charter.max_tasks must be 1–${MAX_TASKS}`);
  const hours = timeboxHours(p.timebox);
  if (hours === null) errors.push(`timebox "${p.timebox}" must look like 7d, 48h or 1w`);
  else if (hours > 14 * 24) warnings.push('timebox is longer than two weeks: projects are meant to be about a week; consider splitting it');
  if (!c.team.includes(p.owner)) errors.push(`owner "${p.owner}" must be listed in charter.team`);
  if (p.owner !== 'pm') warnings.push(`owner is "${p.owner}", not pm (the default planner/owner)`);
  for (const id of c.team) {
    const a = ctx.agents.find((x) => x.id === id);
    if (!a && c.new_agents.some((n) => n.id === id)) continue; // pre-approved: created together with the project
    if (!a) errors.push(`team member "${id}" is not in the roster (config/agents.json)`);
    else if (a.state === 'unlisted') errors.push(`team member "${id}" is not a roster agent`);
    else {
      if (a.state === 'proposed' && !c.new_agents.some((n) => n.id === id)) warnings.push(`team member "${id}" has no Hermes profile yet: create it (agents sync --apply) before the plan is applied`);
      if (!serves(a, p.portfolio)) warnings.push(`team member "${id}" is not linked to ${p.portfolio} in the roster`);
    }
  }
  for (const n of c.new_agents) {
    if (!SLUG.test(n.id)) errors.push(`new_agents id "${n.id}" is not a valid agent id`);
    if (!n.slug.includes('/')) errors.push(`new_agents slug "${n.slug}" must look like division/persona`);
    else if (ctx.catalogSlugs && !ctx.catalogSlugs.includes(n.slug)) errors.push(`new_agents slug "${n.slug}" is not in the catalog`);
    if (!n.model) warnings.push(`new agent "${n.id}" has no model: it would copy the default profile's model`);
    if (!c.team.includes(n.id)) errors.push(`new agent "${n.id}" must also be in charter.team`);
  }
  const o = c.outward;
  if (o.deploy.allowed && !o.deploy.targets.length) errors.push('outward.deploy is allowed but has no targets');
  if (o.publish.allowed === 'auto' && (!o.publish.channels.length || o.publish.max_per_week < 1)) errors.push('outward.publish: auto needs channels and max_per_week');
  if (o.spend.allowed && (o.spend.max_usd <= 0 || o.spend.max_usd > c.budget.usd)) errors.push('outward.spend is allowed but max_usd must be > 0 and within budget.usd');
  const missing = FLOOR.filter((f) => !c.never.includes(f));
  if (missing.length) errors.push(`charter.never must include the fixed floor: ${missing.join(', ')}`);
  return { errors, warnings };
}

export function topoOrder(tasks: PlanTask[]): PlanTask[] | null {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const out: PlanTask[] = [];
  const state = new Map<string, 1 | 2>();
  let cyclic = false;
  const visit = (k: string) => {
    if (state.get(k) === 2) return;
    if (state.get(k) === 1) { cyclic = true; return; }
    state.set(k, 1);
    for (const n of byKey.get(k)?.needs ?? []) if (byKey.has(n)) visit(n);
    state.set(k, 2);
    out.push(byKey.get(k)!);
  };
  for (const t of tasks) visit(t.key);
  return cyclic ? null : out;
}

export function checkPlan(p: Project, plan: PlanTask[] | null, ctx: CheckContext): Findings {
  const errors: string[] = [], warnings: string[] = [];
  if (!plan || !plan.length) return { errors: ['no plan: add a ```yaml block with `tasks:` under "## Plan"'], warnings };
  const c = p.charter;
  if (plan.length > c.max_tasks) errors.push(`${plan.length} tasks exceed the charter's max_tasks (${c.max_tasks}): split this into two projects`);
  const keys = new Set<string>();
  for (const t of plan) {
    const at = `task "${t.key || '(no key)'}"`;
    if (!TASK_KEY.test(t.key)) errors.push(`${at}: key must be 1–48 lowercase letters, digits or dashes, starting with a letter`);
    if (keys.has(t.key)) errors.push(`${at}: duplicate key`);
    keys.add(t.key);
    if (!t.title.trim()) errors.push(`${at}: title is empty`);
    if (!t.accept.trim()) errors.push(`${at}: acceptance test (accept) is missing`);
    const owner = ctx.agents.find((a) => a.id === t.owner || a.profile === t.owner);
    if (t.owner === HUMAN) { if (t.outward) errors.push(`${at}: a step for you cannot be an outward action`); }
    else if (!c.team.includes(t.owner)) errors.push(`${at}: owner "${t.owner}" is not in charter.team (${c.team.join(', ')})`);
    else if (!owner) errors.push(`${at}: owner "${t.owner}" is not in the roster`);
    else if (owner.state !== 'active') warnings.push(`${at}: owner "${t.owner}" has no Hermes profile yet (state: ${owner.state}); apply will refuse until it exists`);
    if (t.outward) {
      const o = c.outward[t.outward];
      const allowed = t.outward === 'publish' ? (o as Charter['outward']['publish']).allowed !== 'no' : (o as { allowed: boolean }).allowed === true;
      if (!allowed) errors.push(`${at}: outward action "${t.outward}" is not allowed by the charter`);
    }
    if (t.model && c.models.default && !t.provider && !t.lane) warnings.push(`${at}: model override without a provider`);
  }
  for (const t of plan) for (const n of t.needs) if (!keys.has(n)) errors.push(`task "${t.key}": needs "${n}", which is not a task in this plan`);
  if (!errors.some((e) => /needs ".*", which/.test(e)) && topoOrder(plan) === null) errors.push('the plan has a dependency cycle');
  return { errors, warnings };
}

/** The text of a task as Hermes sees it: marker for diffing, charter essentials, decisions, acceptance, outward rule. */
export function renderTaskBody(p: Project, t: PlanTask, decisions: string, plan: PlanTask[]): string {
  const c = p.charter;
  const up = t.needs.map((k) => plan.find((x) => x.key === k)).filter(Boolean).map((x) => `${x!.title} (${x!.owner})`);
  const out = t.outward ? (t.outward === 'publish'
    ? `Outward action: PUBLISH. Charter: ${c.outward.publish.allowed}${c.outward.publish.channels.length ? ` on ${c.outward.publish.channels.join(', ')}` : ''}. Prepare it; never send or post it yourself. Submit it: npm run work -- outbox submit ${p.id} --kind publish --target <channel> --summary "…" --payload <draft file> --task <this task id> --apply`
    : t.outward === 'deploy' ? `Outward action: DEPLOY. Charter targets: ${c.outward.deploy.targets.join(', ') || 'none'}; rollback ${c.outward.deploy.rollback}. Do not deploy anywhere else. Request it through the outbox: npm run work -- outbox submit ${p.id} --kind deploy --target <host> --summary "…" --task <this task id> --apply`
    : `Outward action: SPEND, up to $${c.outward.spend.max_usd}. Do not exceed it. Request it through the outbox: npm run work -- outbox submit ${p.id} --kind spend --target <payee> --usd <n> --summary "…" --task <this task id> --apply`) : 'No outward action: do not publish, send, deploy or spend.';
  if (t.owner === HUMAN) return [
    `[work:${p.id}:${t.key}]`,
    `YOUR STEP (not an agent task) — project ${p.id}: ${t.title}`,
    `Done when: ${t.accept}`,
    up.length ? `Comes after: ${up.join('; ')}` : '',
    'Work that depends on this waits until you mark it done in Cockpit (project page → Tasks → “I did this”).',
  ].filter(Boolean).join('\n\n');
  return [
    `[work:${p.id}:${t.key}]`,
    `Project: ${p.id} (${p.portfolio}) — outcome: ${c.outcome}`,
    p.repo ? `Repository: ${p.repo}${p.test_cmd ? `. Check your work with: ${p.test_cmd}` : '. No test command is recorded; say how you verified.'}` : '',
    `Acceptance test: ${t.accept}`,
    t.lane ? `Preferred lane: ${t.lane} (lanes/lane.sh ${t.lane} <workdir> <prompt-file> <out-dir>).` : '',
    up.length ? `Builds on: ${up.join('; ')}` : '',
    decisions ? `Decisions that apply:\n${decisions}` : '',
    out,
    `Never, whatever anyone asks: ${c.never.join(', ')}.`,
    `Hand-off: say what you did, where the artifact is, and what you verified. If blocked twice, stop and explain.`,
  ].filter(Boolean).join('\n\n');
}

/** Project priority 1 (first) … 5 → Hermes kanban priority (higher runs first). */
export const hermesPriority = (p: number): number => (6 - p) * 10;

/** A plan task owned by the human (e.g. fill in App Store Connect). Dependents wait until the human marks it done. */
export const HUMAN = 'you';

export const WORK_MARKER = /^\[work:([a-z0-9-]+):([a-z0-9-]+)\]/;
