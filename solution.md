# Solution Design

## 1. Evaluation summary

| | Paperclip | Hermes Agent (Nous Research) | OpenClaw |
|---|---|---|---|
| Role | The **company**: org chart, CEO, tickets, budgets, approvals, routines, multi-company, adapters | The **employee**: persistent memory, self-written skills, 20+ chat platforms, cron, subagents | Gateway: channel routing, per-agent workspaces |
| Strengths | MIT, ~107k stars, one install hosts many companies, adapters for Hermes/Claude Code/Codex/etc., web UI, API | MIT, 175k+ stars, FTS5 recall + Honcho user model, skills (agentskills.io), MCP | Mature routing, DM pairing/allowlists |
| Weaknesses | Memory/knowledge partial; Agent Chat experimental; no cross-company layer; budget stop can lag spend | Self-improvement can be fragile; memory files size-capped; state lives in chats/files, not structured | Overlaps Hermes; ecosystem supply-chain/credential incidents; single trust boundary |
| Decision | **Use** | **Use** | **Skip** |

Sources: github.com/paperclipai/paperclip, hermes-agent.nousresearch.com/docs,
docs.openclaw.ai, docs.paperclip.ing, arXiv 2608.18066 (fragility of self-improving
agents), arXiv 2603.12644 (OpenClaw threat case study).

**Paperclip vs Hermes are not duplicates.** Hermes has a brain but no durable task
structure; Paperclip has structure and governance but no brain/learning. The dashboard
requirement needs structured state (tasks, approvals, spend, agent health), which only
Paperclip provides through an API.

## 2. Architecture

```
You (Telegram on phone / Mac)
        │
        ▼
Hermes "Chief of Staff" (cloud model)          Hermes "Personal" bot (Ollama only)
  memory + skills + Telegram gateway + cron      money questions, private summaries
        │  Paperclip API / MCP                          ▲
        ▼                                               │ summaries only
Paperclip (control plane, Postgres)              Private pipeline (Ollama/Qwen)
  Company: Software   Content   Investments        inbox → extract → regex-redact
           Ventures   Personal                      → private DB → summaries
        │
Workers: Claude Code / Codex (coding)  ·  Hermes agents (research/content/ops)

Portfolio HQ (we build): pulls Paperclip (all companies) + private summaries +
portfolio data → dashboard + rollup JSON → feeds the Hermes morning brief.

Knowledge: one git/markdown repo per portfolio, exposed to agents via MCP.
All on one Mac mini, reached over Tailscale.
```

## 3. Components

| Component | Source | Notes |
|---|---|---|
| Paperclip | npx `paperclipai` (pinned) | launchd service, embedded or local Postgres, port 3100 |
| Hermes (chief of staff) | existing install in `~/.hermes` | Telegram gateway, cron, custom `portfolio-hq` skill |
| Hermes (Personal) | separate Hermes profile/home | Ollama provider only, no cloud keys |
| Ollama | installed | private pipeline model |
| **Portfolio HQ** | **this repo** (`apps/portfolio-hq`) | Node/TypeScript: collector, store, dashboard, brief |
| **Private pipeline** | **this repo** (`apps/private-pipeline`) | watches inbox, Ollama extraction, regex redaction, emits summaries |
| Knowledge repo | `~/PortfolioKB/<portfolio>/` | markdown, git |

## 4. Portfolio HQ design

- **Collector:** for each Paperclip company, GET `/api/companies/<id>/dashboard` (and
  tasks/approvals/agents endpoints as they exist in the pinned version); reads
  `~/PrivateSummaries/*.json` (output of the private pipeline) and
  `data/portfolio/*.json` (manual/exported KPIs: holdings, MRR, followers).
- **Store:** SQLite snapshots (time series) → trend/sparkline support, no extra service.
- **Rollup:** normalises everything into one schema: `needsYou[]`, per-portfolio cards,
  spend, activity feed.
- **Dashboard:** static single-page UI served by the same Node process; reads `/api/rollup`.
- **Brief:** `/api/brief` returns Markdown for Hermes cron to deliver to Telegram; also
  published as a Hermes skill so the chief of staff can answer "how are things?".
- Adapter pattern: each source is a small module returning typed `PortfolioCard`s, so
  Paperclip API drift only affects one file.

## 5. Privacy architecture (enforced, not promised)

1. Raw files land in `~/Private/inbox`, owned by a **separate macOS user** (`agentpriv`);
   cloud-model agents run as the normal user and cannot read it.
2. Private pipeline: Ollama extracts structured fields → **deterministic regex pass**
   rejects/redacts account numbers, SSN/TIN, emails, phones, addresses → writes
   `summaries/*.json` containing only aggregate figures.
3. Only the summaries directory is world-readable; the dashboard/brief read only it.
4. Personal Paperclip company and the Personal Hermes bot are configured with only the
   Ollama endpoint — no cloud API keys, no payment/bank-write tools.
5. Chief-of-staff cloud chat: policy "never paste financial details"; money chat goes to
   the Personal bot.
6. Tailscale-only access; no ports forwarded.

## 6. Local model sizing (32 GB)

Installed: `qwen3.6:27b`, `qwen3.8:27b` (17 GB each), `gemma3:12b` (8 GB),
`qwen2.5-coder:14b`. A 17 GB model plus Paperclip, Postgres, Hermes, Claude Code workers
and macOS will pressure 32 GB. Recommendation: default the private pipeline to a
≈12–14B model (e.g. `gemma3:12b`, or pull a `qwen3` 14B) and set `OLLAMA_KEEP_ALIVE`
short so the model unloads when idle; use the 27B only for hard documents on demand.
Configurable via `PRIVATE_MODEL`.

## 7. Cost routing

- Subscription: Claude Code / Codex via official CLIs (coding workers).
- API: CEO agents, chief of staff, planning.
- Ollama: heartbeats, triage, summarising, all financial data.
- Paperclip budgets per company from day one.

## 8. Risks

Token cost from scheduled wake-ups; prompt injection via inbound channels; fast-moving
upstreams (pin versions, integrate only via API); self-improving skills drifting (review
skill diffs weekly); single Mac mini as single point of failure (nightly backups).
