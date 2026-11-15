import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { HUMAN, SLUG, WORK_MARKER, logOf, checkCharter, decisionsOf, readPlan, timeboxHours } from '../../packages/work/model.ts';
import { GITIGNORE, renderAgents, renderReadme, titleOf } from '../../packages/work/repo.ts';
import { taskUsage } from '../../packages/work/taskusage.ts';
import { needsHuman } from '../../packages/work/watch.ts';

import { PORTFOLIOS, allProjects, autoSubtasks, boardOf, checkCtx, codesDir, explainTask, flag, flagAll, hoursSince, iso, kanban, recoverMarkers, root, show, type Ctx, type KTask } from '../shared.ts';
import { adviseProject } from './automation.ts';
import { liveConfig } from '../../packages/paths/paths.ts';

/* ---------- projects (Cockpit's view) ---------- */

export function gitState(c: Ctx, repo: string | null) {
  if (!repo) return null;
  const dir = repo.startsWith('/') ? repo : join(codesDir(c), repo);
  if (!existsSync(dir)) return { path: repo, missing: true };
  const g = (...a: string[]) => { try { return c.run('git', ['-C', dir, ...a]).trim(); } catch { return ''; } };
  return { path: repo, missing: false, branch: g('rev-parse', '--abbrev-ref', 'HEAD'), last: g('log', '-1', '--format=%cs %s').slice(0, 90), dirty: g('status', '--porcelain').split('\n').filter(Boolean).length };
}

/** The project's folders for tracking: the repo root and its visible sub-folders (docs, ios, android…), one level deep. */
export function foldersOf(c: Ctx, repo: string | null): Array<{ name: string; path: string; root: boolean; modified: string | null }> {
  if (!repo) return [];
  const dir = repo.startsWith('/') ? repo : join(codesDir(c), repo);
  if (!existsSync(dir)) return [];
  const mt = (d: string) => { try { return statSync(d).mtime.toISOString(); } catch { return null; } };
  const skip = new Set(['node_modules', 'build', 'dist', 'DerivedData']);
  let subs: string[] = [];
  try { subs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !skip.has(e.name)).map((e) => e.name).sort(); } catch { /* unreadable: show the root only */ }
  return [{ name: basename(dir), path: dir, root: true, modified: mt(dir) }, ...subs.map((n) => ({ name: n, path: join(dir, n), root: false, modified: mt(join(dir, n)) }))];
}

export const touchCache = new Map<string, boolean>();

export function cmdProjects(c: Ctx) {
  const onlyId = flag(c, 'id');
  const boardTasks = new Map<string, KTask[] | null>(); // one `kanban list` per board, not per project
  const tasksOn = (board: string): KTask[] | null => {
    if (!boardTasks.has(board)) { try { boardTasks.set(board, recoverMarkers(c, board, JSON.parse(kanban(c, board, ['list', '--json'])) as KTask[])); } catch { boardTasks.set(board, null); } }
    return boardTasks.get(board)!;
  };
  const ctx = checkCtx(c);
  const rows = allProjects(c, c.pos[1]).filter((x) => !onlyId || x.project.id === onlyId).map(({ project: p, body }) => {
    const board = boardOf(c, p);
    let tasks: KTask[] = []; let reachable = true;
    if (board) { const all = tasksOn(board); if (all) tasks = all.filter((t) => t.tenant === p.tenant); else reachable = false; }
    const plan = readPlan(body) ?? [];
    const byKey = new Map(tasks.flatMap((t) => { const m = (t.body ?? '').match(WORK_MARKER); return m && m[1] === p.id ? [[m[2], t] as const] : []; }));
    const byKeyIds = new Set([...byKey.values()].map((t) => t.id));
    const autoOf = board && reachable ? autoSubtasks(c, board, tasks) : new Map<string, KTask[]>();
    const whyOf = new Map<string, { text: string; crashes: number }>();
    if (board && reachable) for (const t of tasks.filter((x) => x.status === 'blocked' || x.status === 'review').slice(0, 12)) { const w = explainTask(c, board, t); if (w) whyOf.set(t.id, w); }
    const usage = board && reachable ? taskUsage(c.hermesHome, board, [...byKeyIds]) : new Map();
    const usageOf = (id?: string) => { const u = id ? usage.get(id) : null; return u ? { runs: u.runs, seconds: Math.round(u.seconds), tokens: u.tokens, cost: Math.round(u.cost * 1000) / 1000, models: u.models } : null; };
    const limit = timeboxHours(p.timebox);
    // Which finished tasks ran without anyone stepping in? Read each done task's events once (cached for the process).
    const done = tasks.filter((t) => t.status === 'done' && byKeyIds.has(t.id));
    const touched = new Set<string>(); let unknown = 0;
    for (const t of done) {
      let v = touchCache.get(t.id);
      if (v === undefined) { try { v = needsHuman(JSON.parse(kanban(c, board!, ['show', t.id, '--json'])).events); touchCache.set(t.id, v); } catch { unknown++; continue; } }
      if (v) touched.add(t.id);
    }
    const counts = (st: string[]) => tasks.filter((t) => byKeyIds.has(t.id) && st.includes(t.status)).length;
    return {
      auto: { done: done.length, untouched: done.length - touched.size - unknown, touched: touched.size, running: counts(['running']), waiting_on_you: counts(['blocked', 'review']) },
      log: logOf(body).slice(-12),
      ...(() => { const info = board && !!tasksOn(board) ? adviseProject(c, p, body, tasksOn(board)!) : null; const pl = info?.planning.at(-1); return { planning: pl ? { id: pl.id, status: pl.status, assignee: pl.assignee, tries: info!.planning.length, created: iso(pl.created_at), started: iso(pl.started_at), completed: iso(pl.completed_at) } : null, advance: info ? { do: info.action.do, why: 'why' in info.action ? info.action.why : '' } : null, plan_errors: info?.planErrors ?? [] }; })(),
      pm: { profile: existsSync(join(c.hermesHome, 'profiles', 'pm')), skill: existsSync(join(c.hermesHome, 'profiles', 'pm', 'skills', 'project-planning', 'SKILL.md')) },
      charter: p.charter, findings: checkCharter(p, ctx), repo_path: p.repo, decisions: decisionsOf(body),
      id: p.id, name: p.name ?? null, portfolio: p.portfolio, status: p.status, priority: p.priority, repo: p.repo, owner: p.owner, objective: p.objective, outcome: p.charter.outcome, done_when: p.charter.done_when,
      timebox: p.timebox, approved: p.approved, hours_left: limit && p.approved ? Math.round(limit - hoursSince(p.approved, c.today)) : null,
      paused_reason: p.paused_reason, max_tasks: p.charter.max_tasks, team: p.charter.team, test_cmd: p.test_cmd, applied: !!p.plan_sha, kanban: reachable, board: boardOf(c, p),
      git: gitState(c, p.repo),
      folders: foldersOf(c, p.repo),
      plan: plan.map((t) => ({ usage: usageOf(byKey.get(t.key)?.id), key: t.key, title: t.title, owner: t.owner, lane: t.lane, needs: t.needs, accept: t.accept, outward: t.outward, parent: t.parent ?? null, task: byKey.get(t.key)?.id ?? null, why: whyOf.get(byKey.get(t.key)?.id ?? '')?.text ?? null, auto: (autoOf.get(byKey.get(t.key)?.id ?? '') ?? []).map((x) => ({ id: x.id, title: x.title, status: x.status, assignee: x.assignee, why: whyOf.get(x.id)?.text ?? null })), created: iso(byKey.get(t.key)?.created_at), started: iso(byKey.get(t.key)?.started_at), completed: iso(byKey.get(t.key)?.completed_at), human: t.owner === HUMAN, touched: byKey.get(t.key) ? touched.has(byKey.get(t.key)!.id) : false, status: byKey.get(t.key)?.status ?? 'not created' })),
      stray: tasks.filter((t) => !WORK_MARKER.test(t.body ?? '')).length,
    };
  }).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  c.out(JSON.stringify(rows));
}

/* ---------- new repo ---------- */

/** A new repo gets a private GitHub twin with the same name as its folder, so the git workflow (push, pull request) has somewhere to go. Never fatal: without gh the repo stays local-only and tasks commit locally. */
export function githubRepo(c: Ctx, dir: string, name: string) {
  try { c.run('gh', ['auth', 'status']); } catch { c.out('  ▲ GitHub repo not created: gh is not logged in on this machine (run `gh auth login` on the Mac). The repo stays local-only; its tasks will commit on a branch and not push.'); return; }
  try {
    const owner = c.run('gh', ['api', 'user', '--jq', '.login']).trim();
    c.run('gh', ['repo', 'create', `${owner}/${name}`, '--private', '--source', dir, '--remote', 'origin', '--push']);
    c.out(`  ✓ private GitHub repo ${owner}/${name} created; origin added and the first commit pushed`);
  } catch (e) { c.out(`  ▲ GitHub repo not created: ${(e as Error).message.split('\n').find((l) => l.trim()) ?? 'gh failed'}. The repo stays local-only.`); }
}

export function cmdRepoCreate(c: Ctx) {
  const [, , portfolio] = c.pos;
  if (!portfolio || !PORTFOLIOS.includes(portfolio)) throw new Error(`usage: work repo create <${PORTFOLIOS.join('|')}> --id slug --outcome "…" --done-when "…"`);
  const id = flag(c, 'id') ?? '';
  if (!SLUG.test(id)) throw new Error('--id must be a lowercase slug (letters, digits, dashes)');
  const outcome = flag(c, 'outcome') ?? '', done = flagAll(c, 'done-when');
  if (!outcome || !done.length) throw new Error('--outcome and at least one --done-when are required');
  const cfgPath = c.env.PROJECTS_CONFIG ?? liveConfig('projects.json', c.env);
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : { repos: {} };
  cfg.repos ??= {};
  if (Object.values(cfg.repos as Record<string, Array<{ id: string }>>).flat().some((r) => r.id === id)) throw new Error(`repo id "${id}" is already in ${cfgPath}`);
  const dir = join(codesDir(c), id);
  if (existsSync(dir)) throw new Error(`${dir} already exists; link it instead of creating it`);
  const r = { id, title: flag(c, 'name') ?? titleOf(id), portfolio, outcome, done_when: done, test_cmd: flag(c, 'test-cmd') ?? '', created: c.today };
  c.out(`  ${c.apply ? '+' : '·'} new repo ${dir.replace(homedir(), '~')}: README.md, AGENTS.md, .gitignore, git init + first commit`);
  if (c.flags.get('no-github') !== true) c.out(`  ${c.apply ? '+' : '·'} private GitHub repo ${id} (same name as the folder), origin added and the first commit pushed; skipped with a note if gh is not logged in`);
  c.out(`  ${c.apply ? '✓' : '·'} registered as "${id}" under ${portfolio} in ${cfgPath.replace(homedir(), '~')}`);
  if (!c.apply) { c.out('(dry run — add --apply)'); return; }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), renderReadme(r));
  writeFileSync(join(dir, 'AGENTS.md'), renderAgents(r));
  writeFileSync(join(dir, '.gitignore'), GITIGNORE);
  const git = (...a: string[]) => c.run('git', ['-C', dir, ...a]);
  git('init', '-b', 'main'); git('add', '-A'); git('commit', '-m', `Start ${r.title}: README and agent notes from the project charter`);
  if (c.flags.get('no-github') !== true) githubRepo(c, dir, id);
  (cfg.repos[portfolio] ??= []).push({ id, path: id, note: 'created from Cockpit', draft: { priority: 3, test_cmd: r.test_cmd, outcome, done_when: done } });
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
}

/* ---------- repos ---------- */

export function cmdRepos(c: Ctx) {
  const path = c.env.PROJECTS_CONFIG ?? liveConfig('projects.json', c.env);
  const repos = (JSON.parse(readFileSync(path, 'utf8')).repos ?? {}) as Record<string, Array<{ id: string; path: string | null; note?: string; draft?: unknown }>>;
  const base = c.env.CODES_DIR ?? join(homedir(), 'codes');
  if (c.flags.get('json') === true) { c.out(JSON.stringify(Object.entries(repos).flatMap(([portfolio, rs]) => rs.map((r) => ({ portfolio, id: r.id, path: r.path, exists: r.path ? existsSync(join(base, r.path)) : false, git: r.path ? gitState(c, r.path) : null, draft: r.draft ?? null }))))); return; }
  for (const p of c.pos[1] ? [c.pos[1]] : PORTFOLIOS) {
    if (!repos[p]?.length) continue;
    c.out(`\n${p}`);
    for (const r of repos[p]) c.out(`  ${r.id.padEnd(20)}${(r.path ?? '(not built yet)').padEnd(32)}${r.path && !existsSync(join(base, r.path)) ? '✗ folder missing' : r.note ?? ''}`);
  }
}
