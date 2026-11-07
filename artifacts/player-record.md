# Adaptive learning player — record of current state

**Recorded:** 2026-11-05 by pm (task t_60b195c4, project connected-ld-demo)

## Statement
The current adaptive learning player is a **Claude artifact prototype**, published at
**usc-unit11-adaptive-learning-poc.netlify.app**. Its **source is not on GitHub**.

## Evidence
- Live check (curl, 2026-11-05): HTTP 200 from Netlify; page title "EDUC 731 | Unit 11 — Alternatives to Cost-Benefit Analysis".
- Repo check: `Dihanzhang/diane-zhang-site` (HEAD cbc983f) only references the player as an outbound link ("Try the learning player ↗", index.html line 609). A grep of the repo found no player source.
- "Claude artifact prototype" comes from the project charter (Diane's description); I did not inspect the Netlify build to confirm independently.
- Only the repo was searched; Diane's other accounts or local folders were not.

## Implications
- Nothing in the repo can be diffed or ported; v1 is a rebuild, not a migration.
- The prototype is the behavioural reference only. Player outcome claims stay limited to Phillips Levels 1–2 (see 70 - Diane/learner-scenario-spec.md).

## December charter (proposed, not approved)
- Project id: `adaptive-player-v1` (ai-thrival), status **proposed**, file `~/PortfolioKB/ai-thrival/projects/adaptive-player-v1.md`.
- Outcome: rebuild the player as v1 in a new GitHub repo and connect it to the ROI Calculator; branch + Netlify deploy preview only.
- Team: pm, coding, architect, course, qa. Deploy no, publish draft-only, spend no. Timebox 14d.
- Approval command (Diane/Frank): `npm run work -- project approve adaptive-player-v1 --apply`.
- No rebuild work has started; no plan is written or applied; no repo created.

## Open points for approval
- New repo name and owner (Diane to decide).
- Charter warns that the pm/coding/architect/course/qa profiles are not found by the work tool's profile lookup. The existing connected-ld-demo charter has the same team, so this is probably a lookup artefact; check before the plan is applied.
