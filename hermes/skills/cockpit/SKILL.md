---
name: cockpit
description: Answer "how is everything?" — Atlas' own health (gateway, channels, workers, scheduled jobs) and every portfolio (AI Thrival, MicroPace, Investments, Research, Family), the agent roster and the worker lanes — and produce the morning/evening brief from Cockpit (local service on 127.0.0.1:3200). Use for status questions, for listing what needs the user's approval, and for spend-vs-budget questions. Never use for raw financial documents.
---

# Cockpit

Cockpit is a local read-only service. It rolls up Atlas' own status (Hermes gateway, chat
channels, running kanban workers, scheduled jobs, worker lanes), every Hermes kanban board
(one per portfolio), research/family jobs, the PII-gated private summaries and manual KPIs,
grouped into AI Thrival · MicroPace · Investments · Research · Family (household finance summaries
land in Family). It is the single source of truth for status.

## How to use

- Brief (Markdown, ready to send): `curl -s http://127.0.0.1:3200/api/brief`
- Structured data: `curl -s http://127.0.0.1:3200/api/rollup` (add `?fresh=1` to force a refresh)
  - `.atlas` — gateway state, heartbeat age, platforms, workers running, jobs, lanes
  - `.portfolios[]` — cards with `.group` (ai-thrival, micropace, investments, research, family)
  - `.agents[]` — roster: who serves which portfolio, their task counts, 7-day tokens, state (active/proposed)
  - `.lanes[]` — worker lanes: login, limits, default model, Ollama's loaded model, recorded spend
  - `.needsYou[]` — approvals (kanban `review`), blockers, failed jobs, deadlines, and `staffing` items (unowned tasks)
  - `.staffing[]` — keyword-heuristic staffing check per unowned task (use the agent-staffing skill to judge it)
- Trend: `curl -s 'http://127.0.0.1:3200/api/history?days=14'`

## Rules

1. Report what the service says; do not invent numbers. If `errors` is non-empty, say so.
2. Lead with **Needs you** items; keep the brief under ~15 lines on Telegram. For "how is
   <section>?" answer from that group only.
3. Approvals are kanban tasks in `review`. Send the user the board, task id and what will
   happen, and wait for their explicit decision. Never approve on their behalf.
4. **Privacy:** never ask the user to paste financial documents or account details into this
   chat (cloud model). Personal/finance detail questions belong to the local-only Personal bot.
   Only summary-layer figures from `/api/rollup` may be repeated. Family items: titles only.
5. Never place trades, move money, send external messages or deploy from this skill.
