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

## Decisions and context (every agent)

What was decided on a project is kept in a decision ledger (knowledge base, `~/PortfolioKB/<portfolio>/decisions/<project>.md`), shown in Cockpit under Decisions. You start from it and add to it, whichever model you run on:

- **Start of a task:** run `npm run work -- brief <project>` from `~/services/personal-agent-platform`. Follow the decisions in force. Items marked *proposed* are drafts and *replaced* ones no longer apply; do not treat either as settled. If something in the brief contradicts the task, say so in your hand-off instead of picking silently.
- **End of a task:** in your hand-off add a `Decisions:` section (one line each: what you decided and why) and, if you could not settle something, an `Open questions:` section. Code reads these and files them as proposals for Frank to confirm, so write only choices others must follow, not a recap of your work.
- **Decisions made in a chat** (Frank says "let's do X"): record it right away: `npm run work -- decision add <project> --title "…" --why "…" --by <your id> --source "chat <session id>" --apply`. Use `--status proposed` when you are not sure Frank meant it as final.
- Never put private data (account numbers, tax IDs, health details) in a decision; the ledger refuses it.

