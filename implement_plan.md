# Implementation Plan

Principle: build trust before autonomy. Read-only first, approvals everywhere outward.

## Repo layout

```
personal-agent-platform/
├── requirement.md  solution.md  implement_plan.md
├── infra/
│   ├── bin/setup.sh            # idempotent bootstrap checks + dirs
│   ├── launchd/*.plist.tmpl    # paperclip, hermes, portfolio-hq, pipeline
│   ├── bin/install-launchd.sh
│   ├── bin/backup-postgres.sh
│   └── env.example
├── apps/
│   ├── portfolio-hq/           # collector + rollup + dashboard + brief (TypeScript)
│   └── private-pipeline/       # inbox → Ollama → regex redact → summaries
├── hermes/
│   ├── skills/portfolio-hq/SKILL.md
│   └── cron/morning-brief.md
├── kb-template/                # per-portfolio knowledge repo skeleton
└── data/portfolio/             # manual/exported KPI json (gitignored except examples)
```

## Phase 0 — Foundations (today)
- [x] Project folder, requirement/solution/plan docs
- [x] `infra/bin/setup.sh` (checks + dirs; run, dirs created)
- [x] launchd templates + installer for HQ and pipeline (dry-run default; **not applied**)

## Discovered on this Mac (2026-10-25) — changes to Phase 1
- **Paperclip is already running** (`npx paperclipai run`, v2026.1012.0, authenticated/private mode,
  since Oct 15) as a foreground process, *not* a service. Next: `paperclipai service install`
  (stop the foreground process first; data lives in `~/.paperclip`, DB backup already enabled).
- **Hermes v0.22.5 already installed** with its own launchd gateway and profiles
  (`coding`, `default`, `diane`, `frank`, `zoe`). We do **not** modify these: integration is a new
  skill + cron + a new `personal` profile (`hermes/install.sh`). Hermes also has a built-in `kanban`
  board; Paperclip stays the system of record for tasks.
- An `ai.openclaw.gateway` launchd job exists; unused by this platform — decide whether to retire it.
- Ollama has `qwen3.6:27b`, `qwen3.8:27b`, `gemma3:12b`; pipeline defaults to `qwen3.8:27b` (gemma3:12b as lighter fallback)
  (both tested: identical correct extraction of a synthetic statement; qwen3.8 ~51 s cold, gemma ~9 s).

## Phase 1 — Control plane + chief of staff (week 1)
- [x] Paperclip already installed and running (see above)
- [ ] Pin Paperclip version, run it as a service (`paperclipai service install`), bind to localhost/Tailscale
- [ ] Create company **Software** + CEO agent; connect Claude Code adapter; budget set
- [ ] Hermes: configure Telegram gateway (allowlist = my user id only), brief cron
- [ ] Verify end-to-end: ticket → worker → approval → Telegram notification
- [ ] Nightly Postgres backup job

## Phase 2 — Portfolio HQ v1 (week 1–2)  ✅ built, awaiting board API key
- [x] Typed source adapters; Paperclip adapter (companies, dashboard, approvals)
- [x] File adapters: private summaries (PII-gated), manual KPI json
- [x] SQLite snapshot store; rollup builder; `needsYou` aggregation
- [x] Dashboard UI at `:3200` (light/dark, mobile) + demo mode
- [x] `/api/brief` + Hermes skill + cron (installer dry-run; not applied)
- [x] 21 tests green
- [ ] Create board key, verify against live Paperclip, add real companies

## Phase 3 — Private pipeline (week 2)  🟡 core built
- [x] Inbox watcher → Ollama (numbers-only schema) → validation → code-generated summary → PII gate
- [x] Redaction + extraction + summary unit tests; verified end-to-end on synthetic data
- [ ] PDF input (pdftotext); real-statement accuracy check
- [ ] Separate macOS user (`private-user.sh`, written, not applied); Personal Hermes bot on Ollama only
- [ ] Manual verification against originals for first months

## Phase 4 — More companies (weeks 3–4)
- [ ] Content & Ventures (approvals on all outbound), knowledge-repo MCP
- [ ] Weekly skill-diff review routine for Hermes learned skills

## Phase 5 — Investments, then Personal (later)
- [ ] Investments: read-only holdings export → card; research agents; no trade tools
- [ ] Personal company: Ollama-only, summaries only

## Definition of done per phase
Runs under launchd, survives reboot, documented in README, tests green, no secrets in repo.
