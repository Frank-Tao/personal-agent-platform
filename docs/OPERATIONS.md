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

**Deploy.** A merge to `main` on GitHub reaches prod by itself, within about 3 minutes:
1. launchd job `com.franktao.pap.deploy` runs `infra/bin/deploy.sh all` every 3 minutes: fetch `origin/main`; nothing new means nothing happens.
2. The new commit is checked in a scratch copy (type check and tests; for the portal a syntax check). The live files are not touched while this runs.
3. Only if that passes, the prod clone is fast-forwarded and the service restarted (not for documentation-only changes; changed job definitions reload the jobs instead).
4. If the service does not answer within 45 seconds, the previous version is put back and restarted.
5. The result is in `<data>/deploy-status-<target>.json` and `~/Library/Logs/pap/deploy.log`. A failed deploy, or a checker that stopped running, appears in Cockpit's Needs-you. A commit that failed is not retried until `main` moves on; `infra/bin/deploy.sh platform --force` retries it.

**Git hook.** `.githooks/post-merge` runs in the prod clone after any `git pull`/merge there (it does nothing in a dev copy, which has no `.pap-prod`): it checks the new code in place, restarts, and undoes the pull if the check fails. A merge on GitHub is not a local git event, so the 3-minute checker above is what notices it; the hook covers a manual pull. The portal's prod clone has the same hook, written by the setup script.

**Everyday.** Develop on a branch in `~/codes/...`; run `npm run cockpit:dev` to look at it; push, open a PR, merge. Prod follows. To deploy right now: `npm run deploy` (from the prod clone) or `infra/bin/deploy.sh all`. To see what prod runs: the header badge, or `git -C ~/services/personal-agent-platform log -1`. To roll back: revert on `main` (the checker deploys the revert), or `git -C ~/services/personal-agent-platform reset --hard <sha>` then `launchctl kickstart -k gui/$(id -u)/com.franktao.pap.cockpit` (until `main` moves, the checker will move prod forward again, so revert on `main` for anything lasting).

**Reaching prod and dev.** Prod Cockpit is `https://franks-mac-mini.tailc8c7e9.ts.net:8443` (Tailscale serve to `:3200`); the portal is `http://<host>:8888`. Dev is loopback only: `http://127.0.0.1:3201` and `:8889` on the Mac itself. Checked 15 Nov: after the move prod reports `prod · main · <sha>`, both services run from `~/services`, and the deploy checker's heartbeat updates every 3 minutes.

**Set up or repair.** `infra/bin/setup-services.sh` (dry run) then `--apply`, from your working copy: creates the clones, copies the data, re-renders every launchd job to point at prod, and undoes itself if prod does not answer. Agents run the CLIs (`npm run work` and the rest) from `~/services/personal-agent-platform`; the work they do on the platform's code happens in worktrees of the dev copy, which is why the "never plan inside the platform repo" guard knows both folders.

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
