---
title: PAP - Architecture
tags: [personal-agent-platform, architecture]
created: 2026-11-01
source: ~/codes/personal-agent-platform
---

# Architecture

```
You ── Telegram · Cockpit chat
        │
   Atlas (Hermes default profile): chat · memory · skills · kanban dispatch · cron
        │ assigns tasks to agents by profile name
   Agents (config/agents.json) ↔ portfolios, many-to-many
        │ run work through
   Lanes: claude · codex · opencode-zen · openrouter · openai · ollama
        │
   Owned state: PortfolioKB (git) · kanban boards · PrivateSummaries · config/*.json · data/lanes.jsonl
        │
   Cockpit: dashboard · chat · new task · agent detail
```

**Principle: rent the plumbing, own what matters.** Hermes supplies channels, chat, skills and the dispatcher. We own the lanes,
the roster, the memory (KB repos), the private pipeline and the dashboard, so replacing Hermes only changes adapters.

**Why Hermes, not Paperclip:** Paperclip ran as an unpinned foreground `npx` process and both companies stalled. Hermes already
has channels (Telegram, WeChat, Slack…), a kanban with a dispatcher, skills that the agent writes itself, and searchable history.

**Memory ("smarter with use"):** Hermes' notes are tiny (2,200 / 1,375 chars); durable knowledge goes in `~/PortfolioKB/<portfolio>/`
(goals, decisions, context). Skills the agent writes are the real learning signal.

**Privacy:** raw financial files only reach the local model; the model returns numbers only and code writes the text; a regex PII gate
runs on write and on read; cloud lanes refuse `~/Private`.

Related: [[PAP - Overview]], [[PAP - Worker lanes]]
