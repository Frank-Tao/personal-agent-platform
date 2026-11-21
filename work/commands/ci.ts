import { isAbsolute, join } from 'node:path';
import { redact } from '../../packages/redact/redact.ts';
import { hermesPriority, type Project } from '../../packages/work/model.ts';
import { allProjects, boardOf, codesDir, kanban, tenantTasks, type Ctx } from '../shared.ts';

/**
 * work ci [--project id] [--apply]: watch each active project's main branch on GitHub. When a workflow's latest run on main failed
 * (tests, a deploy after a merge), make a fix task for the project's coding agent with the failing log, so an agent finds and fixes
 * it instead of Frank. One open fix task per workflow; nothing is created while one is open. Run by the work-watch job.
 */
interface Run { databaseId: number; workflowName: string; conclusion: string; status: string; headSha: string; url: string; createdAt: string }
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
export const ciTitle = (p: Project, workflow: string) => `[${p.id}] Fix failing CI on main: ${workflow}`.slice(0, 190);

export function githubSlug(c: Ctx, p: Project): string | null {
  if (!p.repo) return null;
  try {
    const url = c.run('git', ['-C', isAbsolute(p.repo) ? p.repo : join(codesDir(c), p.repo), 'remote', 'get-url', 'origin']).trim();
    return url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] ?? null;
  } catch { return null; }
}

/** The latest finished run of every workflow, from newest-first runs. */
export function latestPerWorkflow(runs: Run[]): Run[] {
  const seen = new Map<string, Run>();
  for (const r of runs) if (r.status === 'completed' && !seen.has(r.workflowName)) seen.set(r.workflowName, r);
  return [...seen.values()];
}

/** The failing part of a log, without colour codes and timestamps, with personal details masked. */
export function tidyLog(raw: string, lines = 60): string {
  return redact(raw.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m|\^\[\[[0-9;]*m/g, '').replace(/^[^\t]*\t[^\t]*\t\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, '')).filter((l) => l.trim()).slice(-lines).join('\n'));
}

export function cmdCi(c: Ctx) {
  const gh = c.env.GH_BIN ?? 'gh';
  let made = 0, failing = 0;
  for (const { project: p } of allProjects(c)) {
    if (!['active', 'review'].includes(p.status)) continue;
    const slug = githubSlug(c, p), board = boardOf(c, p);
    if (!slug || !board) continue;
    let runs: Run[];
    try { runs = JSON.parse(c.run(gh, ['run', 'list', '--repo', slug, '--branch', 'main', '--limit', '30', '--json', 'databaseId,workflowName,conclusion,status,headSha,url,createdAt'])) as Run[]; }
    catch (e) { c.out(`  ? ${p.id}: could not read GitHub runs (${(e as Error).message.split('\n')[0].slice(0, 80)})`); continue; }
    const open = tenantTasks(c, board, p.tenant).filter((t) => !['done', 'archived'].includes(t.status));
    for (const r of latestPerWorkflow(runs).filter((x) => FAILED.has(x.conclusion))) {
      failing++;
      const title = ciTitle(p, r.workflowName);
      if (open.some((t) => t.title === title)) { c.out(`  · ${p.id}: "${r.workflowName}" still failing; its fix task is open`); continue; }
      if (made >= 3) { c.out(`  · ${p.id}: "${r.workflowName}" failing; more fix tasks next pass`); continue; }
      let log = '';
      try { log = tidyLog(c.run(gh, ['run', 'view', String(r.databaseId), '--repo', slug, '--log-failed'])); } catch { log = '(the log could not be read; open the run)'; }
      const owner = p.charter.team.includes('coding') ? 'coding' : p.owner;
      const body = [`[ci:${p.id}:${r.databaseId}]`, '',
        `The "${r.workflowName}" workflow failed on main (${r.headSha.slice(0, 7)}, ${r.createdAt}): ${r.url}`,
        '', 'Failing log (last lines):', '```', log.slice(-6000), '```', '',
        'Fix the cause, not the symptom: on a feature branch, with a pull request (it merges after review). Do not weaken or skip the failing step.',
        `If it fails because a repository variable is missing and you know the right value, request it: npm run work -- outbox submit ${p.id} --kind access --target github-variable:NAME --value "…" --summary "why" --apply`,
        'If a secret or an outside account (Vercel, a token) is missing, do not guess: block the task and say exactly which one and where it is used. Frank sets secrets.',
        'Done when the workflow passes on main (or the fix PR is open and its checks are green, with the merge requested through the outbox).'].join('\n');
      c.out(`  ${c.apply ? '+' : '·'} ${p.id}: "${r.workflowName}" failed on main → fix task for ${owner}`);
      if (!c.apply) continue;
      try {
        kanban(c, board, ['create', '--json', '--assignee', owner, '--created-by', 'work', '--tenant', p.tenant, '--idempotency-key', `ci:${p.id}:${r.databaseId}`, '--priority', String(hermesPriority(p.priority) + 2), '--max-runtime', '2h', '--body', body, '--', title]);
        made++;
      } catch (e) { c.out(`    could not create it: ${(e as Error).message.split('\n')[0]}`); }
    }
  }
  if (!failing) c.out('ci: main is green everywhere it is watched');
  if (!c.apply && made + failing) c.out('(dry run — add --apply)');
}
