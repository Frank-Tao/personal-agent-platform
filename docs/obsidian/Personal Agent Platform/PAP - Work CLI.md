---
title: PAP - Work CLI
tags: [personal-agent-platform, work-model, cli]
created: 2026-11-01
source: ~/codes/personal-agent-platform/work/cli.ts
---
# Work CLI (phase 1 of the work model)

Design: [[PAP - Work model design]]. Code: `work/cli.ts`, `packages/work`. Dry run unless `--apply`.

**Files** (in `~/PortfolioKB/<portfolio>/`): `objectives.md` (rolling, reviewed weekly), `projects/<slug>.md` (front-matter = the **charter** you approve; body = decisions, the plan `pm` writes as a ```yaml block, a log).

**Commands:** `kb init` · `objective show|add|review` · `project propose|list|show|approve|pause|resume|cancel` · `plan check|apply|diff` · `status` · `close`.

**The only human gate** is `project approve`. After it: plan check (≤ 9 tasks, owners in the charter's team, acceptance test per task, no cycles, outward actions allowed) → `plan apply` creates Hermes tasks with tenant = project, `--parent` dependencies, owner, model/workspace overrides, idempotency key `project:<id>:<key>` and a `[work:<id>:<key>]` marker in the body (used by `plan diff`).

**Fixed floor** in every charter (cannot be removed): money-movement, private-finance-data, deleting-outside-workspace, changing-hermes-config, unapproved-recipients. Defaults: publish `draft-only`, spend `no`, timebox 7d.

**Hermes settings applied** (`hermes/apply-settings.sh`): `max_in_progress 2`, per profile 1, `orchestrator_profile pm`, decomposer on `glm-5.3-flash`; `auto_decompose` stays on. `kanban.auto_promote_children` is documented but unknown to Hermes v0.22.5, so it is not set.

**Phase 2 (built):** `work outbox submit|list|show|release|deny|run` (charter decides ready/held/denied; handlers in `config/outbox.json`), `work watch [--apply]` (pauses a project and blocks its open tasks over task cap / time box / lane minutes), skills `portfolio-planning` + `project-planning`, Cockpit Needs-you. **Still to do:** MicroPace pilot (propose charter; human approves).

Related: [[PAP - Overview]], [[PAP - Agents and staffing]]
