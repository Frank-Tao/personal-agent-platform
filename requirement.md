# Requirements — Personal AI Agent Platform

Captured from the design conversation of 2026-10-25/26.

## 1. Vision

A personal platform, similar in spirit to Paperclip, that **represents me** and lets
multiple AI agent teams work on my different projects and portfolios. The teams operate
daily, report to a CEO agent, and the CEO/chief-of-staff communicates with me.

## 2. Portfolios (one agent "company" each)

| Portfolio | Scope | Autonomy |
|---|---|---|
| Software products | Coding, shipping, deploying | High for code/PRs; **deploys need my approval** |
| Content / personal brand | Writing, LinkedIn, video, research publishing | Drafts only; **I approve every post** |
| Investment portfolio | Market research, holdings monitoring, reports | Read-only; **never places trades** |
| Business ops / side ventures | Sales outreach, support, admin, finance | Can draft; **sending needs approval** |
| Personal (assistant, tax, cash management) | Bills, tax estimates, cash runway | Read-only; **never moves money or files anything** |

## 3. Functional requirements

- **FR1 Multi-team orchestration:** per-portfolio teams with org chart, CEO agent, tickets,
  budgets, approvals, scheduled routines.
- **FR2 Chief of staff:** one agent that represents me, remembers my preferences, learns
  over time, sends a morning brief and evening report, escalates approvals, converts my
  replies into tickets.
- **FR3 Channel:** I talk to the chief of staff on **Telegram**.
- **FR4 Overall dashboard:** one view showing the overall picture of **all** portfolios
  (needs-you items, per-portfolio KPIs, agent health, spend vs. budget, activity feed,
  goal progress). Not just agent activity — also real portfolio data (holdings, product
  metrics, content stats, cash summary).
- **FR5 Worker agents:** Claude Code / Codex for coding; Hermes agents for
  research/content/ops (they accumulate skills).
- **FR6 Shared knowledge:** a markdown/git repository per portfolio as source of truth
  (goals, decisions, context), readable by agents (MCP).
- **FR7 Approvals:** every outward-facing action (send, post, spend, deploy) is gated by
  an approval that reaches me.

## 4. Privacy and security requirements

- **PR1** Personal/financial information must **not** be processed directly by cloud LLMs.
  A local Ollama model pre-handles raw documents (extract, categorise, redact).
- **PR2** Only a **summary layer** (e.g. "cash runway 7.2 mo, Q4 est. tax due Jan 15") may
  reach cloud agents, the dashboard, or Telegram.
- **PR3** Enforcement by system design (filesystem permissions / separate OS user / no
  credentials), not by prompts. Deterministic regex filter as second pass after the LLM.
- **PR4** Personal company has **no cloud API keys**, **no payment tools**, read-only data.
- **PR5** Chat is a leak channel: money questions go to a separate **Ollama-only Personal
  bot**; sensitive details are never typed into the cloud chief-of-staff chat.
- **PR6** No public exposure; access only via Tailscale.
- **PR7** Untrusted inbound messages (DMs, emails) are prompt-injection risks: allowlists
  and tool policies on.

## 5. Non-functional requirements

- Runs 24/7 on an always-on **Mac mini (32 GB RAM)**; MacBook/phone are clients.
- Services supervised by launchd; auto-restart; nightly Postgres backup.
- Model cost control: subscriptions (Claude Code / Codex CLIs) for coding, API for CEO /
  chief-of-staff / planning, local Ollama for heartbeats, triage, summarising, and all
  financial data. Per-company budgets from day one.
- Do not fork Paperclip or Hermes — integrate via their APIs/adapters/MCP so upgrades are
  safe. Pin versions.
- Check provider terms before routing consumer subscriptions through third-party harnesses
  (official CLIs only).

## 6. Decisions made

- **Build on existing projects:** Paperclip (control plane) **and** Hermes Agent (chief of
  staff + evolving workers), both from the start. OpenClaw is **not** used (overlaps
  Hermes' gateway; extra attack surface).
- **Build ourselves:** only "Portfolio HQ" — rollup + dashboard + brief generator + the
  private local-model pipeline.
- Hosting: Mac mini always-on; Tailscale.
- Local model: Ollama on the 32 GB Mac mini.

## 7. Open items

- Which local Qwen size? Installed: `qwen3.6:27b`/`qwen3.8:27b` (17 GB each) — may be too
  heavy alongside everything else on 32 GB; consider a ~12–14B model for the private
  pipeline (see solution.md §6).
- Data sources for each portfolio's real numbers (broker export, product analytics, social
  stats, bank CSV) — to be specified per portfolio.
- Exact Paperclip API surface (verify at install; pin version).
