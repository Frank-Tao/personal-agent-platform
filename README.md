# Personal AI Agent Platform

**Atlas** (Hermes as chief of staff: chat, memory, skills, kanban, cron) plus this repo: **Cockpit** (dashboard, chat, new task),
the **agent roster**, **worker lanes** and the **private local-model pipeline**. Paperclip was dropped on 2026-10-31.
Docs: `requirement.md` (what), `solution.md` (how), `implement_plan.md` (status and next steps), `docs/OPERATIONS.md` (runbook), `docs/design/work-model.md` (proposal: objectives → projects → tasks), `docs/obsidian/` (the same knowledge as Obsidian notes).

```
npm run cockpit:demo  # fake data → http://127.0.0.1:3200 (COCKPIT_PORT=… to change)
npm run cockpit       # real: Atlas, Hermes boards, jobs, usage, lanes, agents, private summaries
npm run agents -- …   # roster setup (dry run unless --apply)
npm run work -- …     # objectives, project charters, plans (dry run unless --apply)
npm run pipeline      # private pipeline (watches ~/Private/inbox, local Ollama only)
npm test              # 153 tests, zero dependencies (Node ≥ 24.11, built-in TS + sqlite)
```

## Cockpit

Header, row 1: search, refresh, theme, settings. Row 2: worker-lane and channel chips (hover for login, limits, models, runs) and,
on the right, **＋ New task** and **Hermes Dashboard ↗**. Left sidebar: **Overview** (Atlas health, subscription limit, tokens,
traffic, API spend, earnings, token chart by Type/Channel/Agent), **Atlas**, **Agents** (roster matrix; each agent's prompt, skills
and memory), **Usage & spend**, **Chat**, **Needs you**, the portfolios **AI Thrival · MicroPace · Investments · Research · Family**
(each opens with its Team), and **Scheduled jobs**. `config/cockpit.json` maps boards and cron jobs to portfolios and lists the
channels, lanes and allowed hostnames.

Atlas is amber when degraded (failing job, secondary channel down, a provider limit ≥85%) and red when it cannot work (gateway or
main Telegram down, a limit at 100%). Every reason is listed.

## Objectives, projects and plans

Design: `docs/design/work-model.md`. Rolling **objectives** per portfolio; **projects** of about a week and at most 9 tasks; you approve
objectives and each project's **charter** once, and `pm` plus Atlas decide everything below that. Files live in `~/PortfolioKB/<portfolio>/`
(`objectives.md`, `projects/<slug>.md`); tasks are Hermes kanban tasks grouped by a tenant named after the project.

```
npm run work -- kb init --apply                                   # create ~/PortfolioKB/<portfolio>/ from kb-template (never overwrites)
npm run work -- objective add micropace --title "…" --kr "…" --apply
npm run work -- project propose micropace --id notice-v1 --outcome "…" --done-when "…" --team coding,qa --deploy-targets preview.example.com --apply
npm run work -- project approve notice-v1 --apply                 # the human gate: charter → active (creates any pre-approved new agents)
npm run work -- plan check notice-v1                              # ≤ 9 tasks, owners in the team, acceptance tests, no cycles, outward actions allowed
npm run work -- plan apply notice-v1 --apply                      # idempotent: tenant, dependencies, assignees, models, markers
npm run work -- plan diff notice-v1 | status [portfolio] | close notice-v1 --apply
```

The charter always includes a fixed floor that cannot be removed (money movement, private finance data, deleting outside the workspace,
changing Hermes config, unapproved recipients). Publishing defaults to `draft-only`; spending to `no`.

**Projects in Cockpit.** Each portfolio page shows its projects as cards: outcome, progress, how many tasks ran without you, a plain
"What to do" line (approve, resume, nothing), the repo's git state, **Edit** and **Tasks & history →**. The task table (reorder, rename,
add, remove, Pause/Resume, Sync plan) and the project log live on the project's own page, `#/project/<id>`, for when you want to see how
it ran. A task counts as "ran without you" when its events show no unblock, reassign, reopen or change request. **Edit** changes
priority, repo and test command any time, and the outcome and checks only while the charter is still proposed. Every button runs the same
`work` command agents use. Repos: `config/projects.json` maps code folders to portfolios (`work repos`); priority maps to the Hermes task
priority (1 → 50 … 5 → 10).

**Token usage by portfolio and project.** Usage & spend adds *Portfolio* and *Project* chart splits and two 30-day tables. A session is tied to a
project when it starts inside a kanban run of the same agent (run window from the board's `task_runs`, project = the task's tenant, portfolio = its
board); everything else (Atlas chat, scheduled jobs) is "No project". Each portfolio shows six project slots (three rows of two) by
priority; more go to a backlog list.

**Approving.** *Approve charter* opens the project page with everything you are approving on one sheet: outcome, checks, repo and test command, team (and agents
that will be created), limits, what may go outside, the never-list, when you are asked again, and any warnings. An optional **comment** is appended to the
project's "Context and decisions" (so it is stamped into every task body) and the log, and goes into pm's planning task; choose *Atlas* to also open a chat with
the note. Every save shows a progress banner and only the changed project is re-read (a full project list takes seconds, one project under a second).

**What happens after you approve.** `work advance` (run by Cockpit right after approval and every minute, and by the launchd job every ten) drives
each active project: (1) no plan → it creates a kanban task "Plan project …" for `pm`, with your note, and Hermes' dispatcher starts pm within a
minute (a second try if pm finishes without a plan, then it reports the project as stalled); (2) pm writes the plan into the project file and runs
`plan check`; (3) a plan that passes its checks is applied by code, so the tasks exist in Hermes; (4) agents run them, and when every task is done
the project moves to *ready for your review*, which appears in Needs-you with a **Mark done** button. The project page shows this chain
(approved → pm asked → plan written → tasks created → agents working → review → done), who triggers each step, and where it is stuck.
The page layout is: status and "what to do / needs you" first, the automation timeline, overview, tasks; History sits in the right column.

**＋ New project** sits on each portfolio page (portfolio fixed): outcome, "done when" checks, optional repo, priority, deploy hosts. The
team is chosen by code. **Approve charter** then hands planning to pm as a task, so nobody adds tasks by hand. *Start a project* on a repo
row links the repo and prefills the stored draft. **No repo yet:** pick *Create a new repo*; `work repo create` makes `~/codes/<name>` with
a README, `AGENTS.md`, `.gitignore` and a first commit and registers it. No GitHub remote is created (that would be an outward action).

**Outbox** (agents never publish, deploy or spend themselves): `work outbox submit <project> --kind publish|deploy|spend --target T --summary S`
→ code checks the charter and marks it `ready` (deploy to a charter target; auto-publish to an approved channel), `held` (draft-only publish,
any spend, over a limit: you release it with `work outbox release <id> --apply`) or `denied`. `work outbox run --apply` executes `ready` items
through the handlers in `config/outbox.json` (empty until you add one) and re-checks the charter first.

**Watchdog** (`work watch [--apply]`, launchd job `com.franktao.pap.work-watch` every 10 min): an active project over its task cap, time box or
lane-minute budget is paused and its open tasks blocked; Cockpit's Needs-you shows it. Cockpit's Needs-you also lists charters to approve and
held outbox items; nothing below that reaches you. Skills: `portfolio-planning` (Atlas) and `project-planning` (pm).
## Chat, tasks and the Hermes dashboard

- **Chat** streams to Atlas through Cockpit's server and Hermes' API server (same persona, memory and tools as Telegram, but its own
  session). The API key stays server-side.
- **＋ New task** creates a kanban task. Unowned tasks are created `blocked` so nothing starts by itself, and Cockpit shows a staffing
  check. Picking an agent starts work within about a minute.
- Add work from Cockpit, from Atlas (chat or Telegram), or from the Hermes dashboard's Kanban page; all drive the same kanban. Only
  the first two run the staffing check automatically; unowned tasks from anywhere appear in **Needs you** with *Ask Atlas* and *Assign*.
- Writes are same-origin JSON only, for allowed hostnames (`allowedHosts`); set `COCKPIT_TOKEN` to require a shared secret too.

## Agents and portfolios

An **agent** is a Hermes profile; a **portfolio** is a Cockpit section. Many agents can serve one portfolio and one agent can serve
several (`coding` serves MicroPace and AI Thrival). Roster: `config/agents.json`. Personas come from
[agency-agents](https://github.com/msitarzewski/agency-agents), pinned to a commit and recorded with a hash.

```
npm run agents -- catalog sync --apply                      # fetch the catalog (pinned commit)
npm run agents -- catalog search "app store"                # find a specialist
npm run agents -- catalog show marketing/marketing-seo-specialist
npm run agents -- suggest --task "Build the login screen in SwiftUI" --portfolio ai-thrival
npm run agents -- models                                    # models that exist here, with rate-limit status
npm run agents -- add marketing/marketing-seo-specialist --id seo --portfolios ai-thrival --model glm-5.3-flash --provider opencode-zen --apply
npm run agents -- link coding family --apply                # one agent, another portfolio
npm run agents -- sync --apply                              # create Hermes profiles for proposed agents
```

Everything is a dry run until `--apply`. Personas are untrusted prompt text: linted for red flags (refused unless
`--accept-warnings`), and `sync` refuses a persona that changed upstream (`--accept-drift`). Atlas' `agent-staffing` and `agent-roster`
skills do the same from chat: judge who fits, propose a persona and a model, and ask before creating anything.

**Models per agent.** The Agents page has a Model column and a **change** button on every agent: pick from `config/models.json` (Claude Sonnet / Opus / Haiku 5.5,
GPT, free OpenCode Zen models, the local model; rate-limited providers are flagged). It runs `agents set`, which updates the roster and the live Hermes profile;
new work uses the new model, running tasks keep theirs. Hovering an agent's name in *Who serves which portfolio* shows its card (model, lanes, portfolios, open
tasks, 7-day usage). `pm` and `coding` run on `claude-sonnet-5-5` (provider `anthropic`) and use the `claude` lane (`lanes/models.conf`: Sonnet 5.5); both draw
on the Claude plan limits shown in the lane chip.

**Personal Privacy** (profile `personal`, local model only). Anything personal (finances, identity, health, legal, or values that identify a person) never goes to a
cloud model. In **Cockpit chat** this is enforced in code: a message with PII (account, card, TFN, BSB, passport, email, phone, address, date of birth) or a private topic
is answered by the Personal Privacy agent on this Mac, the answer passes the deterministic PII filter, and Atlas never receives the message. On **Telegram** Atlas'
`privacy-handoff` skill and persona rule do the same by hand (`printf '%s' "<question>" | npm run privacy -- ask --stdin`), but Atlas' own model does see the incoming
message first, so for truly sensitive items prefer Cockpit chat. Only kinds and counts are logged (`data/privacy.jsonl`). The agent refuses any non-local model.

## Agents that grow

Design: `docs/design/agent-growth.md` (ideas from KarmenLoop/personal-agent-growth, independently implemented). Records live in `~/AgentGrowth` (plain Markdown, own git repo).
Before a task an agent reads `growth packet` (rules Frank gave, plus verified lessons that match the task); after it, it compares the result with its prediction and records a
lesson with *when it applies / when not*. Lessons are promoted only by outcomes (worked once → reused on two tasks; retired after losses). **About you** keeps evidence about how Frank
works with a computed confidence; you can correct, forget or add entries in Cockpit → agent → *About you*. **Growth** shows, per week, finished tasks, the share that ran without
anyone, retries, minutes and tokens per task: the measure of whether an agent is improving. `growth close` runs nightly (launchd) and writes daily and weekly reports. Records refuse
private details. Commands: `npm run growth -- packet|about|lesson|show|daily|weekly|close`.

## Worker lanes

```
lanes/lane.sh <claude|codex|opencode-zen|openrouter|openai|ollama> <workdir> <prompt-file> <out-dir>
```

`claude` and `codex` are subscription CLIs that may edit files; `opencode-zen`, `openrouter` and `openai` are API models run through the
`opencode` CLI in its read-only `plan` agent (text only); `ollama` is local and private. Same contract for all: `result.md`, `log.txt`,
`meta.json`; exit code = the CLI's (3 = privacy refusal, 142 = timeout; an empty answer counts as failure). Default models:
`lanes/models.conf`. Each run is logged to `data/lanes.jsonl`, which Cockpit reads. Cloud lanes refuse `~/Private`.

## Tasks and approvals

One kanban board per portfolio (`ai-thrival`, `micropace-labs`, `investments`, `research`, `family`); tasks are assigned to an agent by
profile name. A task in `review` is an approval waiting for you.

## Remote access (Tailscale only)

```
tailscale serve --bg --https=8443 3200     # Cockpit  → https://franks-mac-mini.<tailnet>.ts.net:8443
tailscale serve --bg --https=9443 9119     # Hermes dashboard (has its own login), used by the header link
```

## Privacy model (what is enforced today)

- The local model returns **numbers only**; code writes all summary text. Every private summary passes a deterministic PII gate
  before it is written *and* before Cockpit reads it; it fails closed.
- Agent prompts and memory are masked (PII and key-like strings) before Cockpit shows them.
- **Not yet an OS boundary:** until `infra/bin/private-user.sh` is applied, the pipeline runs as your user. Do that before real
  statements go in. Drop `<account>-<anything>.txt|csv|md` files into `~/Private/inbox`; PDFs are not handled yet.

## Install order

`infra/bin/setup.sh` → `npm test` → `hermes/install.sh [--apply]` → `hermes/apply-settings.sh [--apply]` (kanban throttles) → `npm run work -- kb init --apply` → `npm run agents -- catalog sync --apply` →
`npm run agents -- sync [--apply]` → `infra/bin/install-launchd.sh [--apply]` → `infra/bin/private-user.sh [--apply]` →
(after tickets are moved) `infra/bin/retire-paperclip.sh [--apply]`. All installers are dry runs unless you pass `--apply`.
