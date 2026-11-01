# Agent growth: getting better with time and use

Status: built 2026-11-01 (first version). Code: `packages/growth`, `growth/cli.ts`, skill `hermes/skills/agent-growth`, Cockpit agent tabs *Memory*, *About you*, *Growth*.

## Source of the ideas

[KarmenLoop/personal-agent-growth](https://github.com/KarmenLoop/personal-agent-growth) (AGPL-3.0-only, v0.4.4, read 2026-11-01: README, SKILL, architecture and Markdown-learning documents). **No code or text was copied**; this is an independent implementation of ideas. Because the licence is AGPL, keep it that way: if code from that repository is ever reused, the AGPL terms apply to what it is combined with.

## What an agent needs to grow (from that work, adapted)

| Idea in the repo | What we built | Where |
|---|---|---|
| Markdown is the single source of learning semantics; the user can read and correct it | Plain Markdown with front matter under `~/AgentGrowth` (own git repo): `<agent>/experience/*.md`, `<agent>/about-you.md`, `_shared/about-you.md`, daily and weekly reports | `packages/growth/store.ts` |
| Prediction before action; review compares outcome with prediction; diagnose the cause class (wrong assumption, missing knowledge, environment, method) before changing anything | The `agent-growth` skill makes every non-trivial task start with a one-line prediction and end with a cause classification | `hermes/skills/agent-growth` |
| Experience carries scope, counterexamples and sources; downgrade or retire rather than erase | A lesson requires *applies when*; *not when* is encouraged; retired lessons stay in the file with the reason | `model.ts` (`Lesson`, `settle`) |
| Do not promote a lesson by repeating it; independent reuse is the evidence | A lesson is *unverified* until it wins once (*worked once*), *reused* after wins on two different tasks, *retired* after two losses that outnumber wins | `settle()` |
| User understanding from observable, sourced signals with scores, confidence, support/opposition and correction chains; no personality labels | *About you*: entries from "Frank said so" (0.9, never ages), "your correction", or "observed" (0.4, +0.15 per confirmation, −0.25 per contradiction, −5% a month unsupported). Below 0.5 an entry is tentative and not used. Corrections supersede (old one kept) | `aboutConfidence`, `about correct/retract` |
| Read memory on demand: filter by validity and scope, then rank; constraints first and never silently truncated | `growth packet`: shared + own constraints always first, then relevant about-you entries and lessons ranked by overlap with the task, within a budget; a constraint set that does not fit is an error | `packet.ts` |
| Daily and weekly closes; a Monday check that last week's lessons were actually applied; missing coverage is unknown, not zero | `growth close` nightly (launchd `com.franktao.pap.growth`, 23:40); weekly report on Sundays with trends, unverified lessons older than 14 days, and the "given but no outcome recorded" check. Re-running with no new facts rewrites nothing | `report.ts` |
| "A larger prompt or a growing pile of notes is not evidence of improvement" | The *Growth* tab measures finished tasks, share that ran without anyone stepping in, extra attempts, minutes and tokens per task, per week; a week under 5 tasks is flagged as noise | `metrics.ts` |
| Contact the user only for a decision that is theirs | Skill rule: never ask Frank about growth records | skill |

## Safety rules we added

- Growth records are read by cloud agents, so `growth` **refuses text that looks private** (the Personal Privacy filter: identifiers, finance, health, identity topics). Private matters stay with the local agent.
- `growth packet` logs lesson ids, never the task text.
- Only task-related signals about how Frank works; an agent's own mistake is a lesson, not a fact about Frank.
- The Personal Privacy agent gets no growth skill (it stays minimal and local).
- Profiles that belong to other people (diane, zoe, frank) are not touched.

## What we did not take, and why

- **Propose–Probe–Compose** (running a baseline against general and domain variants of a changed prompt/skill on frozen tasks, composing, and adopting with transfer and regression tests). It needs frozen task sets, budgets and a way to replay tasks; Hermes does not give us that yet. The promotion rules above are the cheap stand-in. Next step if wanted: weekly *experiment proposals* for one prompt change, tested on replayed finished tasks, adopted only if quality holds and tokens do not rise.
- **Weekly model reflection.** Reports are deterministic (no tokens). A reflection task for pm could be added once there is enough data for it to say something.
- **Cross-host handoff stores, schedulers, Windows tooling.** Hermes and launchd already do those jobs here.

## How it connects to the rest

- Hermes' own memory (`MEMORY.md`, `USER.md`, session search, self-written skills with approval) is unchanged. Growth is the owned, sourced, measured layer on top, and survives replacing Hermes.
- Projects feed it: every finished kanban task counts, and "ran without you" uses the same events as the project cards.
- To use it by hand: `npm run growth -- packet pm --task "…"`, `npm run growth -- about list pm`, `npm run growth -- weekly --apply`.
