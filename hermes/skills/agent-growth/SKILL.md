---
name: agent-growth
description: Use on every non-trivial task, and whenever Frank corrects you or states how he likes things done. Before the task you read a small packet of verified lessons and what is known about how Frank works; after it you compare the result with your prediction, write down what you learned (with when it applies and when it does not), and record whether a lesson you used worked. This is how you get better with use, and it is measured.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [growth, memory, lessons, learning]
    related_skills: [agent-lanes, privacy-handoff]
---

# Agent growth

Your roster id is the name in your roster block (atlas, pm, coding, qa, content …; the default profile is `atlas`). Run these from `~/codes/personal-agent-platform` (they change nothing unless you add `--apply`).

```
npm run --silent growth -- packet <me> --task "<what you are about to do, in your own words>"
npm run --silent growth -- lesson add <me> --title "…" --lesson "do …" --when "applies when …" [--not-when "…"] [--evidence "task t_x: what happened"] --apply
npm run --silent growth -- lesson apply <lesson id> --task <task id> --outcome win|loss|neutral --apply
npm run --silent growth -- about add <me|*> --text "…" [--kind preference|constraint|workflow|decision-rule] --source observed|user-said --ref <task id> --apply
npm run --silent growth -- about correct <entry id> --text "…" --apply
```

## Before a non-trivial task
1. Run **packet**. Read what it prints. Constraints in it are rules from Frank: follow them. Lessons are earlier findings: use one only if its "applies when" really matches, and note which ones you used.
2. Write one line for yourself: **Prediction**: what you expect to happen and the most likely way it goes wrong. Put it in the first note of the task.

## After the task
3. Compare the result with the prediction. If a retry, a block, a failed check, or a person stepping in happened, name the cause as one of: a wrong assumption, missing knowledge, the environment, or the method. Do not change anything until you know which.
4. If there is something **reusable**, write one lesson: what to do, when it applies, and when it does not (the counterexample). One idea per lesson, short. A one-off fact is not a lesson.
5. For each lesson you used from the packet: record **lesson apply** with `win` if it helped the task pass, `loss` if it misled you, `neutral` if it did not matter. Lessons are promoted only by these outcomes.

## About Frank
6. When Frank states a preference, a rule, or corrects you: `about add … --source user-said` (a correction of something already recorded: `about correct`). His own words win over anything inferred.
7. When you notice a repeated, task-related signal (how he likes reports, what he always changes), `about add … --source observed`. It stays tentative until it is seen again.
8. Record only how he works. **Never record personal, financial, health or identity details**: the tool refuses them, and they belong to the Personal Privacy agent. No personality labels. An error of yours is a lesson, not a fact about Frank.

## Keep it small
- Prefer retiring or correcting an old lesson over adding a near-duplicate.
- Do not write a lesson to look busy. Many tasks produce none.
- Do not ask Frank anything for this; only ask when a decision is his.
