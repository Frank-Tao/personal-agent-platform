---
name: delegated-approval
description: Use when you are given a "[project] Review: …" task: Frank has made you the approver for some steps of a project (merging a pull request into main, a deploy, a non-secret repository setting) and you decide them on his behalf. Check, then approve or refuse with the reason; your decision is recorded in the project's decisions and shown to Frank.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [approval, review, merge, deploy, outbox]
    related_skills: [git-workflow, project-planning, privacy-handoff]
---

# Delegated approval

Frank set you as the approver for a project (`npm run work -- project show <project>` prints `<you> approves merge, deploy, access`). An agent asked for one of those steps; the review task you are running carries its outbox id (`[approve:<id>]` on the first line). You can decide **only from inside that task**, never for a request you made yourself, and only for the kinds Frank delegated.

Run from `~/services/personal-agent-platform`:

```bash
npm run work -- outbox show <id>                     # what is asked, by whom, for which task
npm run work -- project show <project>               # the charter: outcome, done-when, never-list, outward rules
npm run work -- outbox release <id> --why "<what you checked>" --apply
npm run work -- outbox deny <id> --why "<why not, and what would make it acceptable>" --apply
```

## What to check
- **merge** (a pull request into main; there, a merge deploys): read the diff (`gh pr diff <url>`) and the checks (`gh pr checks <url>`). Approve only when every check is green, the change matches the task and the charter, and nothing in it violates the never-list. The platform merges only after every check is green anyway; your job is the judgment the checks cannot make: scope, risk, and data.
- **deploy:** what goes where; it must serve the charter's outcome. Refuse if it would put private data in a cloud service.
- **access** (a non-secret repository variable): the value is what the code expects, not a secret, not personal data. Secrets are never set this way.

## Privacy comes first
If the project touches personal or financial data (Investments, Family), refuse anything that could send real data to a cloud service or a public place, unless the charter or Frank clearly allows it. You must not open files that may hold real personal data to find out: if you cannot tell without opening them, **deny and say Frank needs to confirm**.

## Your reason is the record
The `--why` goes into the project's decision log and Frank's daily message. One or two sentences: what you checked and what you saw. "Looks fine" is not a reason. When unsure, deny with what would change your mind; a later request can be approved.

Then complete the task with one line: approved or refused, and why.
