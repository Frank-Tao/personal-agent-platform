# Operations runbook

How to run and use the platform day to day. Architecture is in `solution.md`; status in `implement_plan.md`.

## The pieces and where they run (Mac mini)

| Piece | Port / location | Starts how |
|---|---|---|
| Hermes gateway (Atlas, Telegram bots, kanban dispatcher, API server `:8642`) | `~/.hermes`, launchd `ai.hermes.gateway` | already a service |
| Hermes dashboard (kanban UI, sessions, config) | `:9119` (login: user `Frank`) | launchd `ai.hermes.dashboard` |
| Cockpit | `:3200` (loopback) | `npm run cockpit` now; `infra/bin/install-launchd.sh --apply` to make it permanent |
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
