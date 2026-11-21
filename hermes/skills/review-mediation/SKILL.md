---
name: review-mediation
description: Use when you get a "Mediate: X and Y disagree about …" task, or when asked to settle a disagreement between agents over a review (a refused merge, deploy or setting). Read the exchange, find one concrete resolution both can accept, say it plainly to both, and ask Frank only when you cannot or when the question is his (private data, money, a real taste call).
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [coordination, mediation, review, escalation]
    related_skills: [delegated-approval, git-workflow, project-planning]
---

# Mediating between agents

An approver (usually architect) refused a coder's request twice. You are the coordinator; the platform gives you the whole exchange. You **cannot approve or refuse** the request yourself: the approver decides, and Frank decides anything that escalates.

```bash
cd ~/services/personal-agent-platform
npm run work -- outbox thread <id>                 # every round: who asked what, who refused and why
npm run work -- project show <project>             # charter: outcome, done-when, never-list
gh pr diff <PR url>                                # what the change really does
npm run work -- outbox escalate <id> --why "…" --apply     # hand it to Frank
```

## What to do
1. Read every round. Name, in one line each, what the coder is trying to deliver and what the approver is worried about.
2. Check both against the **charter**. A refusal that asks for more than the charter needs (a redesign, extra features, polish) is out of scope; a refusal about risk, privacy, data loss or a failing check is almost always right.
3. Write ONE resolution as a comment on the "Revise and resubmit" task (and tell the approver in the same comment): the exact change the coder must make, or which part of the refusal is not required and why. Concrete enough that the next review can say yes.
4. Do not make the coder guess, and do not split the difference. If the approver is right, say so and say what to do. If the coder is right, say so with the charter line that shows it.

## When to escalate to Frank (`outbox escalate`)
- You cannot find a resolution both would accept.
- The disagreement is about private or financial data, spending, publishing, or anything outside the charter.
- The two sides keep repeating the same positions.
In `--why`, write what is not agreed and what each side says, in plain words: that text is what Frank reads. After round 3 it goes to Frank anyway.

Never: approve for the approver, tell the coder to bypass the review, or open files that may hold real personal data to settle a dispute.
