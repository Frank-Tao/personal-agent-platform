---
title: PAP - Agents and staffing
tags: [personal-agent-platform, agents,roster]
created: 2026-11-01
source: ~/codes/personal-agent-platform
---

# Agents and staffing

**Agent** = Hermes profile (own memory, skills, model). **Portfolio** = Cockpit section. Many agents per portfolio, many portfolios per agent
(`coding` serves MicroPace + AI Thrival). Roster: `config/agents.json`; states: *active* (profile exists), *proposed* (in roster only), *unlisted*.

**Personas** come from github.com/msitarzewski/agency-agents (268 personas, pinned to commit `b37b5bb`, cloned to `~/.local/share/agency-agents`).
Treated as **untrusted prompt text**: linted (curl|sh, "ignore previous instructions", secrets, base64, sudo, rm -rf), hashed, drift refused,
size reported (15–22 KB is added to every turn). Starter roster (registry-only): content, aso, course (AI Thrival); architect (MicroPace);
pm, qa (both).

**CLI** (dry run unless `--apply`): `catalog sync|search|show`, `add`, `link`, `unlink`, `sync`, `list`, `suggest`, `models`.

**Staffing flow.** New task → Cockpit keyword check (no tokens; needs 2 distinct matched words to say "covered") → Atlas' `agent-staffing` skill
judges → if no fit: shortlist ≤2 personas + recommend a model (from `agents models`: working before rate-limited; free/cheap for drafting,
strongest available for code, local only for money) → **ask the user** → only then `add … --apply`.

**Model setting** works via `hermes -p <profile> config set model.default <m>` and `model.provider <p>`. New agents otherwise copy the default
profile's model, which is rate-limited now.

Related: [[PAP - Worker lanes]], [[PAP - Decisions]]
