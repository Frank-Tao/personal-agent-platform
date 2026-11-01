---
title: Personal Agent Platform
tags: [personal-agent-platform, moc,agents]
created: 2026-11-01
source: ~/codes/personal-agent-platform
---

# Personal Agent Platform

A private multi-agent system on the Mac mini: **Atlas** (Hermes as chief of staff) takes requests on Telegram or in
**Cockpit**, routes tasks to **agents** (Hermes profiles) working across five **portfolios**, using **worker lanes**
(Claude Code, Codex, API models, local Ollama). Repo: `~/codes/personal-agent-platform` (private GitHub repo).

## Notes
- [[PAP - Architecture]] — rented vs owned, the layers
- [[PAP - Cockpit]] — the dashboard, chat, new task, agent detail, security
- [[PAP - Agents and staffing]] — roster, agency-agents personas, how Atlas decides on a new agent
- [[PAP - Worker lanes]] — the six lanes and how their status is checked for real
- [[PAP - Operations runbook]] — daily use, remote access, troubleshooting
- [[PAP - Work model design]] — objectives → projects → tasks across agents (proposal)
- [[PAP - Work CLI]] — objectives, charters, plans from the command line (phase 1, built)
- [[PAP - Decisions]] — what was decided and why
- [[PAP - Lessons and gotchas]] — things that bit us

## Portfolios
AI Thrival (content & brand: iOS apps, Udemy courses) · MicroPace (greenfield, not yet consumer-ready) · Investments · Research · Family (includes household finance summaries).

## Status (2026-11-01)
Built and tested (83 tests); Hermes-side steps pending: install skills, create roster agents, run Cockpit under launchd. See the repo's `implement_plan.md`.
