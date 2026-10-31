---
name: portfolio-hq
description: Answer "how are my portfolios?" and produce the morning/evening brief from Portfolio HQ (local service on 127.0.0.1:3200). Use for status questions across Software, Content, Investments, Ventures and Personal, for listing what needs the user's approval, and for spend-vs-budget questions. Never use for raw financial documents.
---

# Portfolio HQ

Portfolio HQ is a local read-only service that rolls up every Paperclip company plus the
PII-gated private summaries. It is the single source of truth for portfolio status.

## How to use

- Brief (Markdown, ready to send): `curl -s http://127.0.0.1:3200/api/brief`
- Structured data: `curl -s http://127.0.0.1:3200/api/rollup` (add `?fresh=1` to force a refresh)
- Spend/needs-you trend: `curl -s 'http://127.0.0.1:3200/api/history?days=14'`

## Rules

1. Report what the service says; do not invent numbers. If `errors` is non-empty, say so.
2. Lead with **Needs you** items; keep the brief under ~15 lines on Telegram.
3. Approvals live in Paperclip. To act on one, send the user the Paperclip link/ID and wait for
   their explicit decision. Never approve on their behalf.
4. **Privacy:** never ask the user to paste financial documents or account details into this
   chat (cloud model). Personal/finance detail questions belong to the local-only Personal bot.
   Only summary-layer figures from `/api/rollup` may be repeated.
5. Never place trades, move money, send external messages or deploy from this skill.
