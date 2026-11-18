# Operations runbook

How to run and use the platform day to day. Architecture is in `solution.md`; status in `implement_plan.md`.

## The pieces and where they run (Mac mini)

| Piece | Port / location | Starts how |
|---|---|---|
| Hermes gateway (Atlas, Telegram bots, kanban dispatcher, API server `:8642`) | `~/.hermes`, launchd `ai.hermes.gateway` | already a service |
| Hermes dashboard (kanban UI, sessions, config) | `:9119` (login: user `Frank`) | launchd `ai.hermes.dashboard` |
| Cockpit (prod) | `:3200` (loopback), runs from `~/services/personal-agent-platform` | launchd `com.franktao.pap.cockpit`; updates itself from `main` (see Prod and dev) |
| Utility Portal (prod clone `~/services/utility-portal`: Voicebox TTS and future tools; Cockpit lists its tools in the sidebar) | `:8888`, all interfaces | launchd `com.franktao.pap.utility-portal`: starts at login, restarted within about 20 s if it stops. Needs the Voicebox app running for TTS. Logs `~/Library/Logs/pap/utility-portal*.log` |
| Ollama | `:11434` | installed |
| Tailscale | tailnet `tailc8c7e9`; host `franks-mac-mini` | `tailscale serve` routes below |

## Using it

- **See everything:** Cockpit → Overview. Red/amber Atlas tile lists the reasons. Hover any lane or channel chip for details.
- **Talk to Atlas:** Cockpit → Chat, or Telegram (the bot that sends the Saturday analyses). Useful: "How is everything?",
  "What needs me?", "Which agents are busy?", "Do we need a new agent for what's waiting?".
- **Add work:** Cockpit **＋ New task** (leave the owner empty to get a staffing check), or ask Atlas, or the Hermes dashboard Kanban.
- **Approve:** a task in `review` is waiting for you. Telegram: `/kanban show <id>`, `/kanban comment <id> "approved"`,
  `/kanban unblock <id>`.
- **Unowned task in Needs you:** *Ask Atlas* (it judges the team and asks you before creating an agent) or *Assign* to an agent.
- **Inspect an agent:** Agents → an agent → Prompt, Skills, Memory.

## Run a project (objectives → projects → tasks)

1. `npm run work -- kb init --apply` once; add a rolling objective: `work objective add <portfolio> --title … --kr …`.
2. Propose a charter: `work project propose <portfolio> --id <slug> --outcome … --done-when … --team … [--deploy-targets …] [--publish draft-only|auto|no]`.
3. **Approve it** (`work project approve <slug> --apply`): this is your only approval for the project. Pre-approved new agents are created now.
4. `pm` writes the plan into the project file's `## Plan` block; `work plan check <slug>` validates it; `work plan apply <slug> --apply` creates the tasks.
5. Watch with `work status [portfolio]`; `work plan diff <slug>` shows plan vs Hermes; `work close <slug> --apply` when everything is done.
Outward actions go through the outbox (`work outbox submit …`; task bodies say so). Handlers in `config/outbox.json` are empty, so `ready` items wait until you add one. The watchdog (`work watch`) runs every 10 min once `install-launchd.sh --apply` is done.

## Set up or change agents

Dry run first, then add `--apply` (see README). Typical flow for a gap: `suggest` → `catalog show <slug>` → `models` → `add … --model … --provider … --apply`.
Creating an agent costs nothing until it works; its persona adds prompt tokens to every turn it takes. Choose a model per agent:
Codex is a subscription with a weekly limit; OpenCode Zen has free models; Ollama is private and slower; money questions stay local.

## Remote access

```
tailscale serve --bg --https=8443 3200   # Cockpit
tailscale serve --bg --https=9443 9119   # Hermes dashboard (header link)
```
Cockpit only answers allowed hostnames (`allowedHosts` in `config/cockpit.json`). Add the tailnet name there if you change it.

## Settings files

`config/cockpit.json` (portfolio mapping, channels, lanes, dashboard URL, allowed hosts) · `config/agents.json` (roster; use the CLI) ·
`lanes/models.conf` (lane models) · `infra/env` (ports, `HERMES_API_KEY`, `COCKPIT_TOKEN`; copy from `infra/env.example`) ·
`data/portfolio/*.json` (manual KPIs; add `"earnings": {"monthCents": …}` and `"group"`).

## Backups

- Nightly at 03:10 by launchd (`com.franktao.pap.backup`), into `~/Backups/pap/<date>/`: `cockpit.sqlite`, `portfolio-kb.tgz`, `hermes-state.tgz` (agent memory, prompts, config, cron, skill files; no secrets) and `boards/*.db` (the kanban boards). Kept 14 days.
- Run it by hand: `infra/bin/backup.sh`. The result is in `data/backup-status.json` and `~/Library/Logs/pap/backup.log`.
- Cockpit shows a Needs-you item when a step failed or there has been no backup for 36 hours.
- Restore: copy `cockpit.sqlite` back to `data/`; untar `portfolio-kb.tgz` in `~`; untar `hermes-state.tgz` in `~/.hermes`; copy a board's `.db` to `~/.hermes/kanban/boards/<board>/kanban.db` (stop the Hermes gateway first).
- The same script trims launchd logs over 5 MB, keeping one previous copy.

## Email copies of Hermes job messages

Every Hermes job that delivers to Telegram also gets a copy by email, to the person whose chat it went to. `work mailcopy --apply` runs every 10 minutes in the work-watch job.

- **How it decides:** from the Telegram chat the job delivers to (`telegram:<chat id>`, or `telegram` = that profile's home channel), not from the job's name. The chat is matched to a person, and the person to their addresses. Jobs under every profile (default, diane, coding, …) are covered, including new ones, with nothing to set up per job. `local` jobs and jobs that deliver elsewhere are not copied.
- **What is sent:** the text under "## Response" in the output Hermes saved (`~/.hermes/cron/output/<job>/<time>.md`), one email per run to the person's addresses, subject `[Atlas] <job name> — <date>`, with a one-line footer. `[SILENT]` runs are not sent (nothing went to Telegram either). A `[CRON_FAILURE]` run is sent with FAILED in the subject. It sends from the Atlas mailbox through `infra/bin/send-mail.py`, which reads the mailbox settings from `~/.hermes/.env` itself.
- **The people** live in `<data>/config/mailcopy.json` (not in git, because it holds personal addresses):
  `{ "people": { "<Name>": { "telegram": ["<chat id>"], "emails": ["<address>", "<address>"] } }, "exclude": ["<job name to leave out>"] }`
- **Starting point:** the first run records the time and mails nothing from before it. Copies are tracked per output and person in `<data>/mailcopy-state.json`, so nothing is mailed twice. A copy that fails is retried on the next pass, five times in all.
- **Watch it:** `<data>/mailcopy-status.json` and Cockpit's Needs-you (copies that could not be sent, a pass that stopped running for an hour, a job that delivers to a chat no person is mapped to). `npm run work -- mailcopy` is a dry run.
- **Privacy:** a copy goes to two mail accounts instead of one Telegram chat, and email is less private than Telegram. Leave a job out with `exclude` if its text should stay in Telegram.

## The limit of active tasks (20), and grouping when a project needs more

- **The rule:** a project may have at most 20 **active** top-level tasks at a time (`max_tasks` in the charter; the ceiling is 20). Active means not done and not archived: a finished task frees its slot at once, so pm can add new tasks as long as no more than 20 are active. Subtasks never count. Before this change the limit was 9 tasks for a project's whole life, finished ones included.
- **Where it is checked:** `plan check` / `plan apply` / `plan edit` (they ask the board which tasks are finished), the watchdog (`over-scope: N active tasks`, pauses the project), accepting feedback into a project (it says how many active slots are left), `status` and the project page (`N/20 active tasks`). A plan may hold at most 100 top-level tasks in all, finished ones included; after that, start a follow-up project.
- **Above 20? Group them:** `npm run work -- plan regroup <project>` (dry run) or the **Group tasks** button on the project page (shown when 3 or fewer slots are left). Tasks that only ONE other task needs become that task's subtasks, so only the parent counts. It is safe by construction: a task is only moved when that makes it wait for nothing new, so there are no cycles; running or in-review tasks are never touched; at most 9 subtasks per parent; one level only. Applying it rewrites the Hermes tasks (a "Subtask of" line in the body) and adds the dependency link from the subtask to its parent. It aims for 2 free slots (`--headroom`). If no safe grouping exists it says so; then finish or archive tasks, or split the project in two.
- **Change one project's limit:** `npm run work -- project set <id> --max-tasks N --apply` (1 to 20, recorded as a decision). Existing projects were moved from 9 to 20 on 18 Nov.

## Email (Atlas)

Atlas reads and answers email at the AI Thrival mailbox (Spacemail: IMAP/SMTP at `mail.spacemail.com`), through Hermes' built-in email channel. Set up 15 Nov.

- **Where it is configured:** `~/.hermes/.env` (mode 600, never in git or the backups): `EMAIL_ADDRESS`, `EMAIL_IMAP_HOST`, `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_ALLOWED_USERS`, `EMAIL_AUTHSERV_ID`, and `EMAIL_PASSWORD`, which is typed in by hand and never written by an agent or pasted into a chat. The channel switches itself on when address, password and both hosts are present; changes need `hermes gateway restart` (do it when no task is running).
- **Who may instruct Atlas:** only the exact addresses in `EMAIL_ALLOWED_USERS` (Hermes has no domain wildcard on purpose). Mail from anyone else, automated and no-reply mail, and any message whose sender the mail server's SPF/DKIM/DMARC result does not confirm (`EMAIL_AUTHSERV_ID` names the server that stamps it) is ignored.
- **Outbound:** Atlas replies only to those allowed senders. Mail to anyone else is drafted and sent to Frank for approval first (the platform rule that nothing goes outside without approval).
- **Privacy:** email text goes to Atlas's cloud model, like Telegram. Cockpit's privacy filter does not cover this channel, so no tax, bank or health details by email.
- **Check it:** Cockpit shows an Email chip under Channels. `grep '\[Email\]' ~/.hermes/logs/agent.log | tail` shows connection tests and any dropped sender with the reason.
- **Add or change a sender:** edit `EMAIL_ALLOWED_USERS` (comma-separated, full addresses) and restart the gateway.

## Models per agent (1st choice, 2nd choice, fallback)

- **What it is:** each agent runs on up to three models, in order. Hermes uses the 1st choice; if that fails (rate limit, overload or a connection error) it tries the 2nd, then the fallback. Every Hermes profile already had a two-entry fallback chain (set once, the same for all agents); Cockpit now shows the real chain per agent and lets you choose it.
- **Change it:** Agents page, **change** on an agent: three slots with ↑ ↓ to reorder and ✕ to clear the 2nd or the fallback. Each model once; the first is required. From a terminal: `npm run agents -- set <id> --chain '[{"provider":"anthropic","model":"claude-sonnet-5-5"},{"provider":"openai-codex","model":"gpt-6.1-terra"}]' --apply` (dry run without `--apply`).
- **Where it is stored:** the roster (`model`, `provider`, `fallbacks`, in `<data>/config/agents.json` in prod) and the live Hermes profile (`model.default`, `model.provider`, `fallback_providers` in the profile's `config.yaml`). Cockpit shows what Hermes will actually try (the profile's config), so a change made with `hermes fallback` also shows up.
- **Rules:** only models in `config/models.json`; at most three; no repeats; the Privacy agent (`personal`) may only use models that run on this Mac, as a fallback too (otherwise the first local failure would send private text to a cloud model). Providers that need an endpoint (OpenCode Zen) carry a `base_url` in the catalog.
- **Effect:** new work uses the new order; a task already running keeps its model. Every change is in the audit log (`npm run audit`) with the whole chain before and after. Diane may change it, like a single model before.

## Audit log (who changed what)

- Diane (and any other member) may change an agent's model, prompt (`SOUL.md`) and memory files from Cockpit; an unknown device (Guest) may not. Every such change, and every write that was refused, is appended to `data/audit.jsonl` (owner-readable only, not in git, included in the nightly backup).
- Read it: `npm run audit -- --last 20` (filters: `--who Diane`, `--action agents.doc|agents.model|denied`, `--json`), or `GET /api/audit?limit=100` as Frank or Admin.
- Each line has the time, who, device, action, target and ok/refused. A model change records `from` → `to`; a prompt or memory change records the removed and added lines. Secrets typed into a prompt are masked before they are logged.
- Undo a prompt change: Cockpit keeps the previous file next to it as `SOUL.md.bak-<time>` (or `memories/MEMORY.md.bak-<time>`); copy it back. Undo a model change from the Agents page or `npm run agents -- set <agent> --model … --provider … --apply`.
- A limited viewer cannot save a file that contains lines they are not allowed to see (for Diane: lines about Investments), because saving her view would delete those lines. Frank edits those files.

## Prod and dev

Two copies of each service, so editing never touches what is running:

| | Prod | Dev |
|---|---|---|
| Code | `~/services/personal-agent-platform`, `~/services/utility-portal`: clones of `main`, marked by a `.pap-prod` file, never edited by hand | your working copies `~/codes/personal-agent-platform`, `~/codes/utility-portal`, on any branch |
| Ports | Cockpit `:3200`, portal `:8888` (what Tailscale and bookmarks use) | Cockpit `:3201`, portal `:8889` (loopback only) |
| Data | `~/services/data/personal-agent-platform` and `.../utility-portal` | `<repo>/data` (Cockpit dev uses demo data unless you pass `--live`) |
| Started by | launchd (starts at login, restarts if it stops) | you: `npm run cockpit:dev`, `npm run cockpit:dev:live`, `npm run portal:dev` |
| Page header | quiet `prod · main · abc1234` | `DEV · branch · abc1234` (amber) or `DEMO` (blue) and the tab title starts with `[DEV]` |

**Data and rewritten config live outside the code.** `PAP_DATA_DIR` (set in the prod clone's `infra/env`) holds the database, audit log, feedback, ledgers and the files the platform rewrites itself: `config/agents.json` (the roster), `projects.json` (the repo list) and `privacy.json` (the allow-list) live in `<data>/config/`, seeded once from the repo copy. A deploy replaces code only, so it can never overwrite them. The repo's `config/agents.json` etc. are the starting copy; roster changes are made with `npm run agents` (or Cockpit), not by editing the repo.

**Deploy.** A merge to `main` on GitHub reaches prod by itself, within about 5 minutes:
1. launchd job `com.franktao.pap.deploy` runs `infra/bin/deploy.sh all` every 5 minutes: fetch `origin/main`; nothing new means nothing happens.
2. The new commit is checked in a scratch copy (type check and tests; for the portal a syntax check). The live files are not touched while this runs.
3. Only if that passes, the prod clone is fast-forwarded and the service restarted (not for documentation-only changes; changed job definitions reload the jobs instead).
4. If the service does not answer within 45 seconds, the previous version is put back and restarted.
5. The result is in `<data>/deploy-status-<target>.json` and `~/Library/Logs/pap/deploy.log`. A failed deploy, or a checker that stopped running, appears in Cockpit's Needs-you. A commit that failed is not retried until `main` moves on; `infra/bin/deploy.sh platform --force` retries it.

**Git hook.** `.githooks/post-merge` runs in the prod clone after any `git pull`/merge there (it does nothing in a dev copy, which has no `.pap-prod`): it checks the new code in place, restarts, and undoes the pull if the check fails. A merge on GitHub is not a local git event, so the 5-minute checker above is what notices it; the hook covers a manual pull. The portal's prod clone has the same hook, written by the setup script.

**Everyday.** Develop on a branch in `~/codes/...`; run `npm run cockpit:dev` to look at it; push, open a PR, merge. Prod follows. To deploy right now: `npm run deploy` (from the prod clone) or `infra/bin/deploy.sh all`. To see what prod runs: the header badge, or `git -C ~/services/personal-agent-platform log -1`. To roll back: revert on `main` (the checker deploys the revert), or `git -C ~/services/personal-agent-platform reset --hard <sha>` then `launchctl kickstart -k gui/$(id -u)/com.franktao.pap.cockpit` (until `main` moves, the checker will move prod forward again, so revert on `main` for anything lasting).

**Reaching prod and dev.** Prod Cockpit is `https://franks-mac-mini.tailc8c7e9.ts.net:8443` (Tailscale serve to `:3200`); the portal is `http://<host>:8888`. Dev is loopback only: `http://127.0.0.1:3201` and `:8889` on the Mac itself. Checked 15 Nov: after the move prod reports `prod · main · <sha>`, both services run from `~/services`, and the deploy checker's heartbeat updates every 5 minutes.

**Set up or repair.** `infra/bin/setup-services.sh` (dry run) then `--apply`, from your working copy: creates the clones, copies the data, re-renders every launchd job to point at prod, and undoes itself if prod does not answer. Agents run the CLIs (`npm run work` and the rest) from `~/services/personal-agent-platform`; the work they do on the platform's code happens in worktrees of the dev copy, which is why the "never plan inside the platform repo" guard knows both folders.

## Decisions and handover between sessions and models

**What is kept where.** Chat and task transcripts stay in Hermes (one database per profile, searchable); task hand-offs and comments stay on the kanban boards; what matters across sessions is written to the knowledge base, in files that do not depend on any model or app.

- **Decision ledger:** `~/PortfolioKB/<portfolio>/decisions/<project>.md` (and `_portfolio.md` for the whole portfolio). Each entry says what was decided, why, who, where it came from, and its status: *proposed* (a draft), *active* (in force), *superseded*, *rejected* or *reverted*; an open question stays active until answered. The files are markdown, in git (the KB is a repo), in the nightly backup, readable in Obsidian and by an agent with a file tool. Older one-line entries in `<portfolio>/decisions.md` are shown too.
- **How decisions get in:** a charter approval, a priority or team change, closing a project and accepting feedback record themselves. Agents add a `Decisions:` and an `Open questions:` section to their hand-off; `work decision harvest` (run every 10 minutes by the work-watch job) files them as *proposals*. Agents also record decisions made in chat with `work decision add`. Frank records one in Cockpit (Decisions, "Record a decision"). Nothing a model drafts counts until you confirm it.
- **In Cockpit:** the Decisions page (filters, search, counts), a Decisions tab in each project's Automation area (next to Pipeline). Portfolio pages do not list decisions. Confirm, Reject, Revert and Record are for the owner. Diane sees every decision except those in Investments or that talk about it. A proposed decision appears in Needs-you.
- **Conversations page (owner only):** a read-only window onto Hermes' own history (every agent's `state.db`: chats with Atlas, task sessions, scheduled jobs), with full-text search and transcripts. Sensitive values are masked, a model's reasoning is never shown, tool output is cut short. The Privacy agent (`personal`) and the profiles of other people (`diane`, `zoe`) are never opened; change that with `conversationExcludeProfiles` in `config/cockpit.json`. A decision that came from a task or conversation links to it.
- **Commands:** `npm run work -- decision list [project]`, `decision add <project> --title … --why … --apply`, `decision confirm|reject|revert <ref> --apply`, `decision harvest --apply`, `brief <project>`.

**The brief.** `work brief <project>` prints what a model needs to pick the project up cold: the outcome and checks, the decisions in force (newest first), open questions, proposals (marked *not settled*), recent results and what was replaced, sized to the model that will read it (`--model` uses config/models.json: a local model gets less). It is built by code from the ledger, the charter and the boards, so it is the same whichever model reads it, and it is fresh whenever it is run. Every task body tells the agent to run it first. Changing an agent's model changes nothing about what it knows; the change itself is recorded in the audit log (`npm run audit`).

**What does not carry over:** a model's own reasoning traces and provider caches. Anything an agent needs next time must be in the ledger, the hand-off, the project file or its memory.

## After a restart

This Mac logs in by itself (auto-login, FileVault off), and every service above is a user-level launchd job that starts at login, so nothing needs to be started by hand. Check with `launchctl list | grep -E 'pap|hermes'` (a PID in the first column means running) and look at Cockpit's Needs-you, which lists a backup that failed, a portal that is not answering and a Hermes problem.

If `git` or `python3` print "You have not agreed to the Xcode license agreements", a macOS update reset the licence: run `sudo xcodebuild -license accept` once. Until then every `git` call (Cockpit's git state, agents committing, the pre-push hook) fails. The install script uses Homebrew's Python for the same reason.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Atlas red: "Codex weekly limit 100%" | The ChatGPT plan is exhausted until the reset time shown. Atlas falls back to another provider; give new agents a different model. |
| Chat says "no Hermes API key" / "rejected the API key" | Set `HERMES_API_KEY` in `infra/env` (the `API_SERVER_KEY` from `~/.hermes/.env`) and restart Cockpit. |
| "Could not reach Hermes" in chat | Gateway down: `hermes gateway status`. |
| Page 403 "host not allowed" | You used a hostname not in `allowedHosts`. |
| New task says no board mapped | Create the board (`hermes kanban boards create <slug>`) and list it under `boards` in `config/cockpit.json`. |
| Task stuck `blocked`, no owner | By design: assign it (Needs you → Assign) or ask Atlas. |
| Lane chip red | Hover: login problem, limit at 100%, or last run failed (the failure line is shown). Run `claude auth status`, `codex login status`, `opencode auth list`. |
| OpenAI lane "not set up" | `opencode auth login` → OpenAI, then confirm the model name in `lanes/models.conf`. |
| Dashboard login fails | User is `Frank`; the password is whatever was set; reset steps are in the README of this repo's history (hash via `plugins.dashboard_auth.basic.hash_password`). |
| `gh`/keychain errors over SSH | The login keychain is locked in SSH sessions; push from the Mac itself or `security unlock-keychain`. |
| Cockpit shows stale data | Refresh; check `~/Library/Logs/pap-cockpit.log`. |

## Safety rules worth remembering

Everything that changes anything is a dry run until `--apply`. Persona and catalog text is untrusted. Atlas never creates an agent,
profile or assignment without your explicit yes. Raw financial documents go only to the local model. Outward-facing actions
(publish, send, deploy, spend) wait in `review` for you.

## Why is this stuck? / runaway guard

- `npm run work -- why <t_… | fb-… | fp-…>` prints the story of a task (project, plan task, what it waits for, timeline, last failure, hop depth), a feedback note (and what it waits for), or a proposal.
- The watchdog (`work watch`) also counts hops: tasks created by agents (not by you, Cockpit or `work`) that create more tasks. A chain deeper than 8 pauses the project and holds its open tasks.
- Feedback: the same words sent again while the first is still waiting count as a repeat of it (one item). Notes added in Cockpit → Feedback with "next digest" ticked (or `--propose`) become a proposal at the next `work feedback digest` instead of waiting for a second note or 7 days.
