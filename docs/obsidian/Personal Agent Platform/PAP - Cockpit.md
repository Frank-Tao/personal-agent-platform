---
title: PAP - Cockpit
tags: [personal-agent-platform, cockpit,dashboard]
created: 2026-11-01
source: ~/codes/personal-agent-platform
---

# Cockpit (apps/cockpit)

Read-mostly dashboard on `:3200` (loopback; published with `tailscale serve --https=8443`).

**Header:** search, refresh, theme, settings. Second row: lane + channel chips (hover cards) and **＋ New task**, **Hermes Dashboard ↗**.
**Sidebar:** Overview, Atlas, Agents, Usage & spend, Chat, Needs you, the five portfolios (each opens with its Team), Scheduled jobs.

**Atlas health.** Amber = degraded (failing job, secondary channel down, any limit ≥85%). Red = cannot work (gateway/main Telegram down,
a limit at 100%). Reasons are listed.

**Usage.** From every profile's `state.db` (counts, model, channel; never titles or text) + `hermes usage --json`. Chart split by Type /
Channel / Agent. Finding: reading only Atlas' ledger undercounted 10×; each profile has its own database.

**Chat.** Browser → Cockpit → Hermes API server (`:8642`, key server-side) as session `cockpit-…`. Same persona/memory/tools as Telegram.

**New task.** `hermes kanban create` with fixed args, title after `--`. Unowned → `blocked` (nothing starts); assigned → `ready` (starts within ~1 min).

**Agent detail.** SOUL.md prompt, skills (bundled / platform / written by the agent / hub / added; uses; stale) and memory (fill vs cap),
masked for PII and key-like strings.

**Security of writes.** Allowed Host (DNS rebinding), same-origin Origin, JSON content-type, optional `COCKPIT_TOKEN`.

Related: [[PAP - Agents and staffing]], [[PAP - Operations runbook]]
