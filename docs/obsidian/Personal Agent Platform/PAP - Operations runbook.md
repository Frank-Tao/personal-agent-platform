---
title: PAP - Operations runbook
tags: [personal-agent-platform, runbook]
created: 2026-11-01
source: ~/codes/personal-agent-platform
---

# Operations runbook

- **Pieces:** Hermes gateway (Atlas, `:8642` API), Hermes dashboard `:9119` (login user `Frank`), Cockpit `:3200`, Ollama `:11434`.
- **Use:** Cockpit Overview for status; Chat or Telegram to talk to Atlas; ＋ New task (leave owner empty for a staffing check); approve tasks in `review`.
- **Remote:** `tailscale serve --bg --https=8443 3200` (Cockpit) and `--https=9443 9119` (Hermes dashboard). Cockpit answers only `allowedHosts`.
- **Files:** `config/cockpit.json`, `config/agents.json`, `lanes/models.conf`, `infra/env`.

## Troubleshooting
- Atlas red "Codex weekly limit 100%" → plan exhausted until reset; give new agents a different model.
- Chat "no Hermes API key" → set `HERMES_API_KEY` in `infra/env`, restart Cockpit.
- 403 "host not allowed" → add the hostname to `allowedHosts`.
- New task "no board mapped" → `hermes kanban boards create <slug>` + list it in `config/cockpit.json`.
- Lane chip red → hover for the reason; check `claude auth status`, `codex login status`, `opencode auth list`.
- `gh`/keychain errors over SSH → the keychain is locked in SSH; push from the Mac.

## To do next
Install skills (`hermes/install.sh --apply`), create roster agents (`agents sync --apply`) with chosen models, run Cockpit under launchd,
5-task coding gate, retire Paperclip, set up OpenAI lane, move Diane's heavy cron jobs to a cheaper model.

Related: [[PAP - Overview]]
