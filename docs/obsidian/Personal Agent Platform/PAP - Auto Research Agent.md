---
title: PAP - Auto Research Agent
tags: [personal-agent-platform, auto-research-agent, research, project]
created: 2026-11-09
source: ~/codes/auto-research-agent, ~/PortfolioKB/research/projects/auto-research-agent.md
---

# Auto Research Agent (project doc)

## In plain words (for sharing)
A researcher that works every morning. Each cycle it looks up new facts on our topics, writes each one with the web page that supports it, gets a score, **keeps** the notes if they beat the best so far and **discards** them if not. Nobody sits there. Diane gets a track on *AI in Org Learning* and *AI Agency*; Frank gets *AI Coding* and *Responsible AI*. The idea is Andrej Karpathy's `autoresearch` (an agent edits one file, runs a fixed 5-minute cycle, keeps or discards, repeats), pointed at research instead of model training.

## What it is, technically
- Repo: `~/codes/auto-research-agent` (private GitHub twin `Frank-Tao/auto-research-agent`). Project `auto-research-agent` in the Research portfolio, priority 1, team pm, research, coding, qa.
- **Fixed harness** (`harness.py`, `cycle.py`): the agent never edits it. **One editable file** per track: `tracks/<person>/plan.md`, lines `claim | source URL | yes/no`. `program.md` holds the agent rules. `results.tsv` is the append-only log; `seen_claims.txt` remembers earlier claims.
- **Score** = 0.7 × verified share (claims backed by a source) + 0.3 × novelty (claims not seen before). Fixed 300 s budget per cycle. Keep when it beats the best so far, else restore the plan.
- **Agent:** the default online command (`claude -p` with Read/Edit/Write/WebFetch/WebSearch). Local Ollama is not used (it belongs to the private Personal Privacy agent).
- **Schedule:** Hermes cron on the `coding` profile: `auto-research-diane` daily 07:00, `auto-research-frank` daily 07:30, one cycle each. A failed cycle is logged and never retried in a loop.
- **Sources:** the agent finds them itself (so far arXiv papers 2023-24: Self-Refine, MemGPT, AutoGen, GAIA). Topics are the only fixed input. Improvement idea: a preferred-sources list.

## How quality is judged
- Since PR #7 the harness opens each "yes" source and downgrades what it cannot verify; logged time covers the whole run; edits outside the plan file are reverted and logged; per-track fixtures (`tests/fixtures`) pin a seen-state, a candidate and the expected row, and the score test matches within ±0.001.
- QA (re-run from merged main, default Claude agent, 12 tests pass) reproduced both fixture scores. Remaining limits it recorded: lexical checks do not prove factual support; discarded live plans cannot be audited; logged time omits some cycle work. **Not certified for production.**
- The score means "sourced and new", not "true, relevant or useful". The real measure is the reader: a 1-5 rating (useful, new to me, trustworthy) per digest (built in the follow-up project).

## Tokens
- Build so far: about 385k tokens over 14 Hermes runs (~$2 at API prices): gate 121k, QA 119k, summaries 84k.
- The research cycles run through the Claude Code plan and are not in Cockpit's ledger. Estimate 30-100k tokens per cycle, two cycles a day: about 60-200k a day, 2-6M a month. Not measured: the follow-up logs real usage per cycle.

## Output formats
- Today: the claims list and results log per person, plus a plain-language summary (`artifacts/diane-summary.md`, `frank-summary.md`) with a "how much trust" line and the scoring caveat; copies in the KnowledgeBase vault.
- Chosen direction (project `auto-research-output`): in the KnowledgeBase vault, `/Users/franktao/Documents/knowledge vault/auto-research/<person>/`: a weekly **digest** note (3-5 findings, source link, confidence, "so what for you", rating line), one **note per kept claim** (tags by topic; source, cycle id, score as properties) so Obsidian's graph links them, and a monthly **mindmap canvas** (topic, theme, claim, source). Write only inside that folder; never the Personal Obsidian vault.

## Timeline and what we learned
1. **Create:** the New project form silently refused to submit because a hidden "required" task field blocked the form. Fixed; the form now lists every problem and scrolls the message into view. The project and repo were then created from the command line.
2. **First task blocked** (no GitHub remote vs "no outward action"). Fixes: new repos get a private GitHub twin named like the folder (`gh repo create --private`; local-only with a warning if `gh` is not logged in); with no remote, tasks commit locally instead of blocking.
3. **Retry button:** added ↻ Retry (note, then unblock) on blocked plan tasks, subtasks and the steps Hermes split off.
4. **Task "disappeared":** Hermes' auto-decomposer rewrote the task body and dropped the `[work:project:key]` link. Cockpit now restores the link from the creation key kept in the board database, shows the steps Hermes split a task into (nested), and shows "Why it is stuck".
5. **Worker crashed on every retry** (`kanban_skills_unavailable`): the skills curator had archived Hermes' own `sdlc-review` skill, which the review lane always loads. Restored in all agents, `curator.prune_builtins` set to false, `sdlc-review` made mandatory.
6. **Watchdog paused the project** ("over-scope: 11 tasks, charter allows 9") because decomposer steps were counted as new scope. They no longer count.
7. **Policy clarified (Frank):** "nothing sent out" means email or messages to people outside the approved list, public posts, deploys, spending. **Not** outward and never to be blocked: commits, pull requests and merging them on the project's repo (once tests pass, with the evidence in the PR), KnowledgeBase writes, Telegram to Frank or Diane. Updated in agent operating rules, Atlas's prompt, task bodies and the `git-workflow` skill.
8. **QA blocked** (no tolerance or fixtures, trust in "yes" markers, wrong elapsed time, scheduler pointed at a task worktree, prompt-only isolation). QA had used a hand-made local Ollama stand-in because it read the old wording as forbidding model calls. Decision: tolerance ±0.001; fixtures per track; remediation task fixed items 2-5 and merged PRs #1-#7; QA re-ran and passed with the limits above.

## Platform changes made along the way
Cockpit: blocked-tasks panel on the project page (what, why, what it holds up, Retry), split-step list, auto-reload when the page changes, watchdog fix, `work project retry-task`, restored plan links. Agents: skills trimmed to 400-870 tokens per session, `sdlc-review` mandatory, SOUL operating rules rewritten. See [[PAP - Skills and models]] and [[PAP - Decisions]].

## State on 2026-11-09
- `auto-research-agent`: all 9 plan tasks done, project in **review**. PR #8 (README and `docs/decisions.md`) was open and unmerged; two done-when items were only partly evidenced (scheduled jobs and the KnowledgeBase summary copies).
- `auto-research-output`: charter approved by Frank on 2026-11-09; pm plans the tasks (digest, claim notes, canvas, token logging, ratings).

## Open questions
- Does the output actually help? Ask Diane and Frank to rate the first digests; stop or change topics if "new to me" stays low.
- Add a preferred-sources list? Real per-cycle token numbers after a week of scheduled runs.

Related: [[PAP - Work model design]], [[PAP - Worker lanes]], [[PAP - Agents and staffing]]
