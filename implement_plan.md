# Implementation Plan

Principle: build trust before autonomy. Read-only first, approvals everywhere outward. Status as of 2026-11-01.

## Repo layout

```
personal-agent-platform/
├── requirement.md  solution.md  implement_plan.md  README.md  docs/OPERATIONS.md
├── agents/cli.ts               # roster setup: catalog, add, link, set, sync, suggest, models (dry run unless --apply)
├── work/cli.ts                 # objectives, project charters, plans: kb init, objective, project, plan, status, close
├── lanes/{lane.sh,models.conf} # one contract for claude · codex · opencode-zen · openrouter · openai · ollama
├── apps/
│   ├── cockpit/                # src/{app,server,chat,tasks,security,rollup,config}.ts, src/sources/*, public/index.html
│   └── private-pipeline/       # inbox → Ollama → regex redact → summaries
├── packages/{redact,roster,work}/   # PII filter · roster, catalog, staffing · YAML subset, charter/plan model and checks
├── config/{cockpit.json,agents.json}   # sections/boards/hosts · the roster (agents ↔ portfolios)
├── hermes/{install.sh,atlas-persona.md,skills/*,cron/}
├── infra/{bin/*,launchd/*,env.example}
├── kb-template/  data/portfolio/  docs/
```

## Done

- **Foundations:** docs, `setup.sh`, launchd templates and installers (dry run by default; **not applied**).
- **Backbone switch:** Paperclip dropped; Hermes kanban is the task system; `retire-paperclip.sh` written (**not applied**).
- **Cockpit:** Atlas health with reasons; usage and Codex limit; token chart split by Type / Channel / Agent across all profile
  ledgers; real lane checks with hover cards; sidebar of portfolios; Agents page and per-portfolio Team; agent detail (prompt, skills,
  memory); chat with Atlas; **＋ New task** with staffing check; Needs-you actions; header with search, refresh, theme, settings and
  a second row of lane/channel chips plus New task and Hermes Dashboard link. 83 tests; checked live in light, dark and phone widths.
- **Portfolios:** AI Thrival, MicroPace, Investments, Research, Family (Personal merged into Family).
- **Roster:** `config/agents.json`; agency-agents catalog pinned to `b37b5bb` (268 personas); starter agents registered
  registry-only (content, aso, course, architect, pm, qa) plus Atlas, coding, personal.
- **Lanes:** Gemini removed; OpenCode Zen, OpenRouter, OpenAI added through `opencode`; timeout and empty-answer checks; run ledger.
- **Atlas skills (written):** cockpit, agent-lanes, agent-roster, agent-staffing.

## Phase 1 of the work model — done 2026-11-01

- `packages/work`: YAML subset reader/writer; charter, plan, objectives formats; validation (≤ 9 tasks, owners in the team, acceptance tests,
  no cycles, outward actions allowed, fixed floor); `work` CLI (kb init, objective, project propose/approve/pause/resume/cancel, plan
  check/apply/diff, status, close). 112 tests; the full flow was also run against the real Hermes CLI in an isolated home.
- `kb-template` refreshed for the five portfolios (objectives, context, decisions, projects, playbooks).
- Hermes settings applied (`hermes/apply-settings.sh`, config backed up): `max_in_progress 2`, `max_in_progress_per_profile 1`,
  `orchestrator_profile pm`, decomposer on `glm-5.3-flash` (opencode-zen); `auto_decompose` stays on. Restart the gateway if it does not re-read config.

## To do, in order

1. `hermes/install.sh --apply` (skills, boards, kanban tools, persona, skill-write approval, morning brief) and restart the gateway.
2. ~~Create agents~~ **Done 2026-11-01:** qa, content, course, pm, research created on `glm-5.3-flash` (opencode-zen); `aso` and `architect` stay proposed until there is work for them.
3. Run Cockpit under launchd (`infra/bin/install-launchd.sh --apply`); publish with `tailscale serve` (8443 Cockpit, 9443 Hermes dashboard).
4. **Gate:** 5 real coding tasks through kanban → claude lane; ≥4 complete with tests green and no manual rescue. If it fails, fix the
   lane prompt / worktree handling before migrating.
5. Move the live MicroPace and AI Thrival tickets to their boards; then `infra/bin/retire-paperclip.sh --apply`.
6. OpenAI lane: `opencode auth login` → OpenAI.
7. Move the `diane` agent's heavy scheduled jobs to a cheaper model (they dominate token use).
8. Private pipeline: PDF input; `infra/bin/private-user.sh --apply` before any real statement goes in; local-only personal bot.
9. **Work model phase 2 — built (2026-11-01):** outbox (`work outbox submit|list|release|deny|run`, `config/outbox.json` handlers, empty), watchdog (`work watch`, launchd `work-watch` every 10 min; pauses + blocks on task cap, time box, lane minutes), skills `portfolio-planning` (Atlas) and `project-planning` (pm), Cockpit Needs-you for charters / paused projects / held outbox items. **Still to do:** install (`hermes/install.sh --apply`, `install-launchd.sh --apply`), the MicroPace pilot "Notice → Calendar v1" (propose the charter; you approve), real outbox handlers once a deploy/publish target exists, then phase 3 (Cockpit project pages).
10. Later: KB repos per portfolio from `kb-template/`; weekly skill-diff review; investments read-only holdings card; spend panel.

## Definition of done per phase
Runs under launchd, survives reboot, documented, tests green, no secrets in repo.
10. **Agent growth (2026-11-01):** built `growth` (about-you evidence, lessons with promotion rules, context packets, daily/weekly closes, metrics), the `agent-growth` skill (installed in every roster profile), Cockpit tabs *Memory / About you / Growth*, nightly launchd job. **To do:** run `infra/bin/install-launchd.sh --apply` for the nightly job; let agents run for a few weeks; then decide on weekly experiment proposals (Propose–Probe–Compose lite) once the Growth tab has enough data.
