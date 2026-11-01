import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadRegistry } from '../packages/roster/roster.ts';
import { privacyCheck } from '../packages/redact/topics.ts';
import {
  KINDS, SOURCES, aboutConfidence, aboutId, aboutState, lessonId, settle, wins, losses, type AboutEntry, type AboutKind, type AboutSource, type Lesson,
} from '../packages/growth/model.ts';
import { agentMetrics, ymd } from '../packages/growth/metrics.ts';
import { buildPacket } from '../packages/growth/packet.ts';
import { renderDaily, renderWeekly } from '../packages/growth/report.ts';
import { SHARED, loadAbout, loadAboutFile, loadLessons, logEvent, readEvents, saveAboutFile, saveLesson } from '../packages/growth/store.ts';

// Agent growth records (docs/design/agent-growth.md). Dry run unless --apply.
//
//   growth init
//   growth about add <agent|*> --text "…" [--kind preference|constraint|workflow|decision-rule] [--source user-said|observed|correction] [--ref r]
//   growth about observe <id> support|oppose [--ref r]   | correct <id> --text "…" | retract <id> | list <agent|*> [--json]
//   growth lesson add <agent> --title T --lesson "do…" --when "applies when…" [--not-when "…"] [--evidence "task t_1: …"]
//   growth lesson apply <id> --task <task id> --outcome win|loss|neutral | retire <id> --reason R | list <agent> [--json]
//   growth packet <agent> --task "what you are about to do" [--budget 3000]     the context an agent reads before starting
//   growth show <agent> --json                                                   everything Cockpit shows for one agent
//   growth daily [--agent a] [--date d] | weekly [--agent a] | close             reports (close = daily, plus weekly on Sundays)

const root = resolve(import.meta.dirname, '..');

interface Ctx {
  growth: string; registryPath: string; hermesHome: string; today: string; now: Date; out: (s: string) => void; run: (cmd: string, args: string[]) => string;
  apply: boolean; flags: Map<string, string[] | true>; pos: string[];
}
const BOOL = new Set(['apply', 'json', 'force']);

function parseArgs(argv: string[]) {
  const pos: string[] = []; const flags = new Map<string, string[] | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (BOOL.has(k)) flags.set(k, true);
    else { const val = v !== undefined ? v : argv[++i]; if (val === undefined) throw new Error(`--${k} needs a value`); flags.set(k, [...((flags.get(k) as string[]) ?? []), val]); }
  }
  return { pos, flags };
}
const flag = (c: Ctx, k: string) => { const v = c.flags.get(k); return Array.isArray(v) ? v[v.length - 1] : undefined; };
const flagAll = (c: Ctx, k: string) => { const v = c.flags.get(k); return Array.isArray(v) ? v : []; };

const agentsOf = (c: Ctx) => loadRegistry(c.registryPath).agents;
function agentId(c: Ctx, id: string | undefined, allowStar = false): string {
  if (allowStar && id === '*') return '*';
  if (!id || !agentsOf(c).some((a) => a.id === id)) throw new Error(`unknown agent "${id ?? ''}" (see: agents list)`);
  return id;
}
const profileOf = (c: Ctx, id: string) => agentsOf(c).find((a) => a.id === id)!.profile;
const profileDb = (c: Ctx, profile: string) => join(profile === 'default' ? c.hermesHome : join(c.hermesHome, 'profiles', profile), 'state.db');
const ev = (c: Ctx, o: object) => { if (c.apply) logEvent(c.growth, { at: c.now.toISOString(), ...o }); };
const done = (c: Ctx, msg: string) => { c.out(`  ${c.apply ? '✓' : '·'} ${msg}`); };
const refuseIfPrivate = (t: string) => { const v = privacyCheck(t); if (v.private) throw new Error(`refused: this text looks private (${v.reasons.join(', ')}). Growth records are read by cloud agents, so keep them to how Frank works, never personal or financial details.`); };

/* ---------- about you ---------- */

function cmdAbout(c: Ctx) {
  const [, sub, a1] = c.pos;
  if (sub === 'list') {
    const scope = agentId(c, a1, true);
    const rows = (scope === '*' ? loadAboutFile(c.growth, '*') : loadAbout(c.growth, scope)).map((e) => ({ ...e, confidence: aboutConfidence(e, c.today), state: aboutState(e, c.today) }));
    if (c.flags.get('json')) return c.out(JSON.stringify(rows));
    if (!rows.length) c.out('no entries');
    for (const e of rows) c.out(`${e.id}  ${e.state.padEnd(10)} ${String(e.confidence).padEnd(5)} [${e.kind}] ${e.text}`);
    return;
  }
  if (sub === 'add') {
    const scope = agentId(c, a1, true);
    const t = (flag(c, 'text') ?? '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 240) throw new Error('--text is required and at most 240 characters');
    refuseIfPrivate(t);
    const kind = (flag(c, 'kind') ?? 'preference') as AboutKind, source = (flag(c, 'source') ?? 'observed') as AboutSource;
    if (!(KINDS as readonly string[]).includes(kind)) throw new Error(`--kind must be one of ${KINDS.join(', ')}`);
    if (!(SOURCES as readonly string[]).includes(source)) throw new Error(`--source must be one of ${SOURCES.join(', ')}`);
    const entries = loadAboutFile(c.growth, scope), id = aboutId(scope, t), have = entries.find((e) => e.id === id);
    if (have) {
      const next = entries.map((e) => (e.id === id ? { ...e, support: source === 'observed' ? e.support + 1 : e.support, retracted: false, updated: c.today, ref: flag(c, 'ref') ?? e.ref } : e));
      if (c.apply) saveAboutFile(c.growth, scope, next, c.today);
      ev(c, { agent: scope, kind: 'about-observe', id });
      return done(c, `${id}: already known, counted as another confirmation`);
    }
    const e: AboutEntry = { id, text: t, kind, scope, source, ref: flag(c, 'ref') ?? '', observed: c.today, support: 0, oppose: 0, retracted: false, superseded_by: null, updated: c.today };
    if (c.apply) saveAboutFile(c.growth, scope, [...entries, e], c.today);
    ev(c, { agent: scope, kind: 'about-add', id, source });
    return done(c, `${id}: [${kind}] ${t}  (confidence ${aboutConfidence(e, c.today)}${source === 'observed' ? ', tentative until confirmed' : ''})`);
  }
  // observe / correct / retract act on an id wherever it lives
  const scopes = ['*', ...agentsOf(c).map((a) => a.id)];
  const where = scopes.find((s) => loadAboutFile(c.growth, s).some((e) => e.id === a1));
  if (!where) throw new Error(`no About You entry "${a1 ?? ''}"`);
  const entries = loadAboutFile(c.growth, where), cur = entries.find((e) => e.id === a1)!;
  if (sub === 'observe') {
    const how = c.pos[3];
    if (how !== 'support' && how !== 'oppose') throw new Error('usage: growth about observe <id> support|oppose');
    const next = entries.map((e) => (e.id === a1 ? { ...e, support: e.support + (how === 'support' ? 1 : 0), oppose: e.oppose + (how === 'oppose' ? 1 : 0), updated: c.today } : e));
    if (c.apply) saveAboutFile(c.growth, where, next, c.today);
    ev(c, { agent: where, kind: 'about-observe', id: a1, how });
    return done(c, `${a1}: ${how === 'support' ? 'confirmed' : 'contradicted'} → confidence ${aboutConfidence(next.find((e) => e.id === a1)!, c.today)}`);
  }
  if (sub === 'retract') {
    if (c.apply) saveAboutFile(c.growth, where, entries.map((e) => (e.id === a1 ? { ...e, retracted: true, updated: c.today } : e)), c.today);
    ev(c, { agent: where, kind: 'about-retract', id: a1 });
    return done(c, `${a1}: retracted (kept in the file, no longer used)`);
  }
  if (sub === 'correct') {
    const t = (flag(c, 'text') ?? '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 240) throw new Error('--text (the corrected statement) is required, at most 240 characters');
    refuseIfPrivate(t);
    const nid = aboutId(where, t);
    const fresh: AboutEntry = { ...cur, id: nid, text: t, kind: (flag(c, 'kind') as AboutKind) ?? cur.kind, source: 'correction', observed: c.today, support: 0, oppose: 0, retracted: false, superseded_by: null, updated: c.today };
    if (c.apply) saveAboutFile(c.growth, where, [...entries.map((e) => (e.id === a1 ? { ...e, superseded_by: nid, updated: c.today } : e)), fresh], c.today);
    ev(c, { agent: where, kind: 'about-correct', id: a1, to: nid });
    return done(c, `${a1} → ${nid}: corrected (the old statement is kept, marked superseded)`);
  }
  throw new Error('usage: growth about add|observe|correct|retract|list …');
}

/* ---------- lessons ---------- */

const allLessons = (c: Ctx) => agentsOf(c).flatMap((a) => loadLessons(c.growth, a.id));

function cmdLesson(c: Ctx) {
  const [, sub, a1] = c.pos;
  if (sub === 'list') {
    const rows = loadLessons(c.growth, agentId(c, a1));
    if (c.flags.get('json')) return c.out(JSON.stringify(rows.map((l) => ({ ...l, wins: wins(l), losses: losses(l) }))));
    if (!rows.length) c.out('no lessons');
    for (const l of rows) c.out(`${l.id}  ${l.status.padEnd(9)} ${wins(l)}W/${losses(l)}L  ${l.title}`);
    return;
  }
  if (sub === 'add') {
    const agent = agentId(c, a1);
    const title = (flag(c, 'title') ?? '').trim(), lesson = (flag(c, 'lesson') ?? '').trim(), when = (flag(c, 'when') ?? '').trim(), notWhen = (flag(c, 'not-when') ?? '').trim();
    if (!title || !lesson || !when) throw new Error('--title, --lesson and --when are required (a lesson without its scope is not reusable)');
    if (title.length > 90 || lesson.length > 400 || when.length > 240 || notWhen.length > 240) throw new Error('keep it short: title ≤ 90, lesson ≤ 400, when ≤ 240, not-when ≤ 240 characters');
    for (const t of [title, lesson, when, notWhen, ...flagAll(c, 'evidence')]) refuseIfPrivate(t);
    let id = lessonId(c.today, title); const existing = new Set(loadLessons(c.growth, agent).map((l) => l.id));
    for (let n = 2; existing.has(id); n++) id = `${lessonId(c.today, title)}-${n}`;
    const l: Lesson = { id, agent, title, lesson, when, not_when: notWhen, evidence: flagAll(c, 'evidence'), status: 'tentative', applied: [], created: c.today, updated: c.today, retired_reason: null, supersedes: flag(c, 'supersedes') ?? null };
    if (c.apply) saveLesson(c.growth, l);
    ev(c, { agent, kind: 'lesson-add', lesson: id });
    return done(c, `${id}: tentative until it wins on a real task`);
  }
  const l = allLessons(c).find((x) => x.id === a1);
  if (!l) throw new Error(`no lesson "${a1 ?? ''}"`);
  if (sub === 'apply') {
    const outcome = flag(c, 'outcome') as 'win' | 'loss' | 'neutral' | undefined, task = flag(c, 'task');
    if (!outcome || !['win', 'loss', 'neutral'].includes(outcome) || !task) throw new Error('usage: growth lesson apply <id> --task <task id> --outcome win|loss|neutral');
    const next = settle({ ...l, applied: [...l.applied, { task, outcome, at: c.today }], updated: c.today });
    if (c.apply) saveLesson(c.growth, next);
    ev(c, { agent: l.agent, kind: 'lesson-apply', lesson: l.id, task, outcome });
    return done(c, `${l.id}: ${outcome} on ${task} → ${next.status}${next.status !== l.status ? ` (was ${l.status})` : ''}${next.retired_reason ? ` — ${next.retired_reason}` : ''}`);
  }
  if (sub === 'retire') {
    const reason = flag(c, 'reason') ?? 'retired by owner';
    if (c.apply) saveLesson(c.growth, { ...l, status: 'retired', retired_reason: reason, updated: c.today });
    ev(c, { agent: l.agent, kind: 'lesson-retire', lesson: l.id });
    return done(c, `${l.id}: retired (${reason}); kept for the record`);
  }
  throw new Error('usage: growth lesson add|apply|retire|list …');
}

/* ---------- packet, show, reports ---------- */

function cmdPacket(c: Ctx) {
  const agent = agentId(c, c.pos[1]);
  const task = flag(c, 'task') ?? '';
  if (!task) throw new Error('usage: growth packet <agent> --task "what you are about to do"');
  const p = buildPacket({ agent, task, about: loadAbout(c.growth, agent), lessons: loadLessons(c.growth, agent), today: c.today, budget: Number(flag(c, 'budget') ?? 3000) });
  if (p.text) { c.out(p.text); logEvent(c.growth, { at: c.now.toISOString(), agent, kind: 'packet', lessons: p.lessons, about: p.about, chars: p.chars }); }
  else c.out('Nothing recorded yet that applies to this task.');
}

function metricsFor(c: Ctx, agent: string) {
  return agentMetrics({ boardsDir: join(c.hermesHome, 'kanban', 'boards'), stateDb: profileDb(c, profileOf(c, agent)), profile: profileOf(c, agent), now: c.now });
}

function cmdShow(c: Ctx) {
  const agent = agentId(c, c.pos[1]);
  const lessons = loadLessons(c.growth, agent).map((l) => ({ ...l, wins: wins(l), losses: losses(l) }));
  const about = loadAbout(c.growth, agent).map((e) => ({ ...e, confidence: aboutConfidence(e, c.today), state: aboutState(e, c.today) }));
  const list = (d: string) => { try { return readdirSync(join(c.growth, agent, d)).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, 12); } catch { return []; } };
  const events = readEvents(c.growth).filter((e) => e.agent === agent);
  const packets = events.filter((e) => e.kind === 'packet').length;
  const weekly = list('weekly')[0];
  let latestWeekly: string | null = null;
  try { latestWeekly = weekly ? readFileSync(join(c.growth, agent, 'weekly', weekly), 'utf8') : null; } catch { /* none */ }
  c.out(JSON.stringify({ agent, about, lessons, metrics: metricsFor(c, agent), reports: { daily: list('daily'), weekly: list('weekly') }, latestWeekly, packets, exists: existsSync(c.growth) }));
}

function writeReport(c: Ctx, path: string, content: string, label: string) {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return c.out(`  = ${label}: unchanged`);
  c.out(`  ${c.apply ? '✓' : '·'} ${label}`);
  if (c.apply) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
}

function cmdDaily(c: Ctx) {
  const date = flag(c, 'date') ?? c.today;
  for (const a of agentsOf(c).filter((x) => !flag(c, 'agent') || x.id === flag(c, 'agent'))) {
    const m = metricsFor(c, a.id), day = m.days.find((d) => d.key === date);
    if (!day) { c.out(`  ? ${a.id}: ${date} is outside the last 14 days`); continue; }
    writeReport(c, join(c.growth, a.id, 'daily', `${date}.md`), renderDaily(a.id, day, readEvents(c.growth)), `${a.id} daily ${date}`);
  }
}

function cmdWeekly(c: Ctx) {
  for (const a of agentsOf(c).filter((x) => !flag(c, 'agent') || x.id === flag(c, 'agent'))) {
    const m = metricsFor(c, a.id), cur = m.weeks.at(-1)!, prev = m.weeks.at(-2) ?? null;
    writeReport(c, join(c.growth, a.id, 'weekly', `${cur.key}.md`), renderWeekly({ agent: a.id, week: cur, prev, today: c.today, lessons: loadLessons(c.growth, a.id), about: loadAbout(c.growth, a.id), events: readEvents(c.growth) }), `${a.id} weekly ${cur.key}`);
  }
}

function cmdInit(c: Ctx) {
  if (!existsSync(c.growth)) { c.out(`  ${c.apply ? '+' : '·'} create ${c.growth.replace(homedir(), '~')} and git init`); if (c.apply) { mkdirSync(c.growth, { recursive: true }); c.run('git', ['init', '-b', 'main', c.growth]); } }
  else c.out('  = growth root exists');
  if (c.apply) mkdirSync(join(c.growth, SHARED), { recursive: true });
  c.out('  Private details never belong here: the CLI refuses text that looks personal or financial.');
  if (!c.apply) c.out('(dry run — add --apply)');
}

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, out: (s: string) => void = console.log, run?: Ctx['run'], now: Date = env.GROWTH_NOW ? new Date(env.GROWTH_NOW) : new Date()): number {
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { out(`error: ${(e as Error).message}`); return 1; }
  const c: Ctx = {
    growth: env.GROWTH_ROOT ?? join(homedir(), 'AgentGrowth'), registryPath: env.AGENTS_REGISTRY ?? join(root, 'config', 'agents.json'), hermesHome: env.HERMES_HOME ?? join(homedir(), '.hermes'),
    today: ymd(now), now, out, apply: parsed.flags.get('apply') === true, flags: parsed.flags, pos: parsed.pos,
    run: run ?? ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })),
  };
  try {
    const cmd = c.pos[0];
    if (cmd === 'init') cmdInit(c);
    else if (cmd === 'about') cmdAbout(c);
    else if (cmd === 'lesson') cmdLesson(c);
    else if (cmd === 'packet') cmdPacket(c);
    else if (cmd === 'show') cmdShow(c);
    else if (cmd === 'daily') cmdDaily(c);
    else if (cmd === 'weekly') cmdWeekly(c);
    else if (cmd === 'close') {
      cmdDaily(c);
      if (c.now.getDay() === 0 || c.flags.get('force')) cmdWeekly(c); else c.out('  · weekly close runs on Sundays (or with --force)');
    } else { out('usage: growth <init | about | lesson | packet | show | daily | weekly | close> … [--apply]'); return cmd ? 2 : 0; }
    if (!c.apply && ['about', 'lesson', 'daily', 'weekly', 'close'].includes(cmd) && !(c.pos[1] === 'list') && cmd !== 'packet') c.out('(dry run — add --apply)');
    return 0;
  } catch (e) {
    out(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) process.exit(main(process.argv.slice(2)));
