import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { showCache } from '../packages/work/showcache.ts';

import { explainTask, parseArgs, recoverMarkers, root, show, type Ctx } from './shared.ts';
import { cmdAdvance, cmdNudge, cmdWatch } from './commands/automation.ts';
import { cmdFeedback, cmdWhy } from './commands/feedback.ts';
import { cmdBrief, cmdDecision } from './commands/decisions.ts';
import { cmdMailcopy } from './commands/mailcopy.ts';
import { cmdMail } from './commands/mail.ts';
import { cmdAct } from './commands/act.ts';
import { cmdDigest } from './commands/digest.ts';
import { cmdAutomation } from './commands/automation-defaults.ts';
import { cmdKb, cmdObjective } from './commands/kb.ts';
import { cmdOutbox } from './commands/outbox.ts';
import { cmdClose, cmdPlan, cmdStatus } from './commands/plan.ts';
import { cmdProject } from './commands/project.ts';
import { cmdProjects, cmdRepoCreate, cmdRepos } from './commands/projects.ts';
import { dataDir, liveConfig } from '../packages/paths/paths.ts';

// Tests and Cockpit import these from here.
export { explainTask, recoverMarkers } from './shared.ts';

// Objectives, project charters and plans (docs/design/work-model.md). Dry run unless --apply.
//
//   work kb init [--portfolio p]                       create ~/PortfolioKB/<portfolio>/ from kb-template (never overwrites)
//   work objective show [portfolio] | add <portfolio> --title T --kr "text" [--kr …] | review <portfolio>
//   work project retry-task <id> <key | -> [--task t_xxxx] [--note "…"]   unblock a blocked task; the note is recorded on it first so the agent reads it
//   work project propose <portfolio> --id slug --outcome "…" --done-when "…" [--done-when …] [--team a,b (default: pm + qa, plus whoever the outcome calls for)] [--objective O1] [--kr KR1.1,KR1.2]
//                        [--timebox 7d] [--deploy-targets x,y] [--publish no|draft-only|auto] [--repo path] [--new-agent slug:id:model:provider]
//   work project list [portfolio] | show <id> | approve <id> | pause <id> | resume <id> | cancel <id>
//   work project set <id> [--priority 1-5] [--repo id|path] [--test-cmd "npm test"] [--autonomy semi|full]      (no approval needed; re-prioritises open tasks)
//                        full: starts 4 h after proposal unless stopped, closes itself after QA, confirms agents' decisions the next day; never for deploy/spend/new agents
//   work plan check <id> | apply <id> | diff <id>
//   work plan edit <id> --op move --key k --to n | remove --key k | add --key k --title T --owner o --accept A [--needs a,b] [--lane l] | set --key k [--title T] [--owner o] [--accept A] [--lane l]
//   work projects --json                         everything Cockpit shows: status, priority, tasks, repo git state
//   work status [portfolio]
//   work close <id> [--force]
//   work outbox submit <project> --kind publish|deploy|spend --target T --summary S [--payload file] [--usd n] [--task id]
//   work outbox list [project] | show <id> | release <id> | deny <id> | run          (run executes `ready` items via config/outbox.json)
//   work repo create <portfolio> --id slug --outcome "…" --done-when "…" [--test-cmd c]   new folder under ~/codes with README, AGENTS.md, git; registers it in config/projects.json
//   work repos [portfolio]                      which code folders belong to which portfolio (config/projects.json)
//   work advance [--project id]                 move approved projects forward: ask pm to plan, apply a written plan, mark finished ones for review (--apply)
//   work feedback digest [--apply]   group open feedback, rank by count and recency, write proposals with evidence quotes
//   work plan regroup <id> [--headroom 2] [--apply]   over the limit of active tasks? group prerequisites under the task that needs them (subtasks do not count)
//   work feedback approve <proposal> --into <project> [--owner o] [--title t] [--accept a] [--apply]   approve a proposal and add it as one task to an active project's plan (refuses when the charter has no task slots left)
//   work feedback add --source telegram|cli|cockpit --by name [--ref chat:msg] [--page p] [--propose] (--stdin | --text T) [--apply]   record one piece of feedback (--propose: eligible for the next digest without waiting for a repeat or 7 days) (docs/design/feedback-loop.md)
//   work nudge [--project id] [--apply]          get stuck tasks moving: promote tasks whose parents are done, retry a blocked task once (or when someone reworded it), report the rest
//   work why <task | fb-… | fp-…>              how a task (or feedback note, or proposal) got here, what it waits for, its timeline and hop depth
//   work mail send --to a@x --subject S (--body-file f | --body T | --stdin) --by <agent> [--project id] [--apply]   email through the Atlas mailbox: allow-listed
//                        recipients go now, anything else is held for a person (work mail list | show <id> | policy | release <id> --by N | deny <id> --by N)
//   work act <CODE> yes|no [--via telegram]      answer a Needs-you item with the code from the daily digest (Atlas runs this for the owner)
//   work act --kind k --project p|--id x|--refs a,b --answer yes|no --by Name --apply     the same from Cockpit or a terminal
//   work digest [--due] [--preview] [--apply]   the owner's daily message (Telegram + email): up to 5 things to decide, each with a reply code
//   work automation show | default <portfolio> semi|full --by Name [--apply]     the automation level new projects in a portfolio start with
//   work watch                                  check every active project against its charter; --apply pauses offenders and holds their open tasks

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, out: (s: string) => void = console.log, run?: Ctx['run']): number {
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { out(`error: ${(e as Error).message}`); return 1; }
  const c: Ctx = {
    kb: env.PORTFOLIO_KB ?? join(homedir(), 'PortfolioKB'),
    layoutPath: env.COCKPIT_LAYOUT ?? join(root, 'config', 'cockpit.json'),
    registryPath: env.AGENTS_REGISTRY ?? liveConfig('agents.json', env),
    hermesBin: env.HERMES_BIN ?? join(homedir(), '.local', 'bin', 'hermes'),
    hermesHome: env.HERMES_HOME ?? join(homedir(), '.hermes'),
    templateDir: env.KB_TEMPLATE ?? join(root, 'kb-template'),
    today: env.WORK_TODAY ?? new Date().toISOString().slice(0, 10),
    out, apply: parsed.flags.get('apply') === true, flags: parsed.flags, pos: parsed.pos, env,
    run: run ?? ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })),
    // Only the read-only project list uses kept answers. A command that changes tasks and then looks at them must see Hermes' own answer.
    shows: (parsed.pos[0] === 'projects' || parsed.pos[0] === 'brief')
      ? showCache(env.WORK_SHOW_CACHE ?? join(dataDir(env), 'work-show-cache.json'), env.HERMES_HOME ?? join(homedir(), '.hermes'))
      : { get: () => undefined, set: () => {}, flush: () => {} },
  };
  c.rerun = (again, o) => main(again, env, o, c.run);
  try {
    const cmd = c.pos[0];
    if (cmd === 'kb') cmdKb(c);
    else if (cmd === 'objective') cmdObjective(c);
    else if (cmd === 'project') cmdProject(c);
    else if (cmd === 'plan') cmdPlan(c);
    else if (cmd === 'status') cmdStatus(c);
    else if (cmd === 'close') cmdClose(c);
    else if (cmd === 'outbox') cmdOutbox(c);
    else if (cmd === 'watch') cmdWatch(c);
    else if (cmd === 'advance') cmdAdvance(c);
    else if (cmd === 'nudge') cmdNudge(c);
    else if (cmd === 'feedback') cmdFeedback(c);
    else if (cmd === 'why') cmdWhy(c);
    else if (cmd === 'decision') cmdDecision(c);
    else if (cmd === 'brief') cmdBrief(c);
    else if (cmd === 'mailcopy') cmdMailcopy(c);
    else if (cmd === 'mail') cmdMail(c);
    else if (cmd === 'act') cmdAct(c);
    else if (cmd === 'digest') cmdDigest(c);
    else if (cmd === 'automation') cmdAutomation(c);
    else if (cmd === 'repos') cmdRepos(c);
    else if (cmd === 'repo' && c.pos[1] === 'create') cmdRepoCreate(c);
    else if (cmd === 'projects') cmdProjects(c);
    else { out('usage: work <kb init | objective | project | plan | status | close | outbox | watch | advance | why | decision | brief | mail | mailcopy | act | digest | automation | repos | projects> … [--apply]'); return cmd ? 2 : 0; }
    return 0;
  } catch (e) {
    out(`error: ${(e as Error).message}`);
    return 1;
  } finally {
    c.shows?.flush();
  }
}

// exitCode, not process.exit(): exit() can cut off output still being written to a pipe (a long `projects` list lost everything after 64 KB).
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) process.exitCode = main(process.argv.slice(2));
