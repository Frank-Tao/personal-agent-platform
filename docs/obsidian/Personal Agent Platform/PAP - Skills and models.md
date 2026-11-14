---
title: PAP - Skills and models
tags: [personal-agent-platform, skills, models, agents]
created: 2026-11-08
source: ~/codes/personal-agent-platform
---

# Skills and models per agent (2026-11-08)

## Models
- Codex choices in `config/models.json`: **GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Luna** (GPT-5.6 Luna removed).
- Every former `glm-5.3-flash` agent (content, qa, course, research, marketer, support) and the kanban decomposer moved to `gpt-6.1-terra` (`openai-codex`). `glm-5.3-flash` is still a pickable model.
- Change a model: Cockpit → Agents → *change*, or `npm run agents -- set <id> --model m --provider p --apply` (updates registry and the live Hermes profile).

## Why skills were trimmed
- Hermes puts a one-line index of every **enabled** skill into each session's system prompt. The skill body loads only on demand (`skill_view`), so loading is already dynamic; the index is the cost.
- Before: ~98 enabled skills per profile ≈ **3,000 tokens per session**, plus a prompt that says "load anything even partially relevant". Archived skills (67) cost nothing: Hermes ignores `.archive`.
- After: **400–870 tokens** (personal ~420, qa ~565, content ~600, finance ~675, coding ~735, Atlas ~870).

## How it works
- `config/skills.json` = `mandatory` + per-agent keep list. Hermes has only a deny-list, so `agents sync` sets `skills.disabled = installed − keep` in each profile's `config.yaml`.
- **Mandatory in every roster agent:** `agent-growth`, `cockpit`, `kanban-worker`, `agent-lanes`. Source of truth is `hermes/skills/`; sync copies them in when missing (an existing copy is never overwritten, agents may have patched it).
- **Exception:** `personal` (local-only) gets `agent-growth` + `privacy-handoff` only: no external lanes, no cross-portfolio data.
- `agents add` runs the skill step too, so a new agent starts lean. Run alone: `npm run agents -- sync --skills-only [--only id] --apply`.
- A skill installed later stays hidden until added to that agent's list. Disabled skills stay installed; delete the name from `skills.disabled` in the profile's `config.yaml` to restore.
- Not covered: `diane`, `frank`, `zoe`, `default` profiles (people's assistants). Spotify is left enabled for them.

## Notable keep-list choices
- comfyui → content, course. polymarket → finance (new). store-availability → aso, growth, marketer. project-planning → pm. git-workflow → coding, qa.
- Disabled everywhere (not used by any portfolio): mlops (22), gaming, smart-home, red-teaming, data-science, yuanbao, godmode, obliteratus, …

## New agent: Finance Analyst (`finance`)
- Persona `finance/finance-financial-analyst` (agency-agents), serves Investments + Family, `gpt-6.1-terra`, lane codex. Intended for Family Portfolio Tracker and Investments projects.

Related: [[PAP - Agents and staffing]], [[PAP - Decisions]], [[PAP - Worker lanes]]
