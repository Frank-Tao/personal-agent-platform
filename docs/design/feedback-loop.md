# Design: the Cockpit feedback loop

Status: **design, 2026-11-07** (project `cockpit-improvement`, task `feedback-design`). Not implemented yet; the other plan tasks
build it (§11). Builds on [work-model.md](work-model.md): charters, the ≤ 9-task cap, `plan apply`, the watchdog, Needs-you.

## 1. Problem and constraints

You notice things while using Cockpit and the agents ("the project page hides blocked tasks", "Atlas answers too long"). Today
those notes are lost in Telegram scroll-back. The charter asks for: feedback **collected continuously** from Cockpit and Telegram
into **one store**, **consolidated weekly** into **ranked proposals**, **you approve / defer / reject** each, and an approved
proposal **becomes tasks** — without breaking the work model (approval at the charter, ≤ 9 tasks per project, fixed floor).

Constraints that shape the design:

| Constraint | Consequence |
|---|---|
| One person gives almost all feedback; volume is tens per week, not thousands | flat files, deterministic grouping, no search index, no model calls |
| Approval happens at the charter (work-model D4); tasks are not approved | an approved proposal is a *scope* decision; tasks are derived and checked by code |
| A project has ≤ 9 top-level tasks for its lifetime; `cockpit-improvement` already uses **9 of 9** | conversion must have somewhere to go when a project is full (§7) — this is the main design problem |
| Feedback text is read by cloud agents (pm, coding) | private text is refused at intake (same `privacyCheck` as Cockpit chat) |
| Cockpit is a read-only view of truth held elsewhere (D8); writes are guarded | the store is a file the `work` CLI owns; Cockpit writes through the same code path |
| No outward action, no Hermes config change by agents | the weekly notice goes to the existing owner chat only; installing the schedule is your step |

**Non-goals:** a product-feedback system for MicroPace apps' end users, a ticket tracker, automatic prioritisation without you.

## 2. Overview

```
 Cockpit "Feedback" button ─┐   POST /api/feedback (guarded)
 Telegram → Atlas skill  ───┼──▶ work feedback add ──privacyCheck──▶ data/feedback.jsonl        (items, append-only)
 CLI (you / pm / qa)     ───┘        └─ exact-duplicate guard (§4.1)
                                                  │
                    weekly (Mon 07:30) work feedback digest --apply
                                                  │  group near-duplicates (§4.2), rank (§5), cap 5 pending
                                                  ▼
                                    data/feedback-proposals.jsonl                              (proposals, append-only)
                                                  │
                   Cockpit sidebar "Feedback" + Needs you ── you: Approve ▸ target | Defer ▸ until | Reject ▸ reason
                                                  │ approve
                                                  ▼
                        work feedback convert ── capacity check (§7) ──▶ plan edit add + plan apply  (project with room)
                                                                     ├─▶ one ad-hoc task             (small-thing rule)
                                                                     └─▶ refuse: "needs a new charter" + draft charter
                                                  │ tasks done
                                                  ▼
                                    proposal and its items → done (visible in Cockpit; nobody is messaged)
```

One module owns every rule: `packages/work/feedback.ts` (pure: normalise, dedupe, group, rank, fold, capacity). The CLI
(`work feedback …`) and Cockpit (`apps/cockpit/src/feedbackApi.ts`) both call it, so the rules are tested once.

## 3. Records

Two append-only JSON-lines files, one JSON object per line. **The last line for an `id` wins** (a status change appends a full
new copy of the record). Nothing is rewritten or deleted, so concurrent appends from Cockpit and the CLI are safe (one `appendFileSync`
per line, lines < 4 KB), history is kept, and a reader that meets a torn or unparseable line skips it and reports the count.
Both files are **git-ignored** (`data/feedback*.jsonl`): they hold your own words.

### 3.1 Feedback item — `data/feedback.jsonl`

```json
{"v":1,"id":"fb-20261107-3f9a1c","time":"2026-11-07T09:12:44.120Z","source":"cockpit","by":"frank",
 "text":"Project page hides blocked tasks unless I scroll","page":"#/p/micropace/cockpit-improvement",
 "ref":null,"key":"a41c09e2b7d5","status":"open","proposal":null,"note":""}
```

| Field | Type | Rule |
|---|---|---|
| `v` | 1 | schema version; readers refuse unknown major versions |
| `id` | `fb-YYYYMMDD-<6 hex>` | random suffix; never reused |
| `time` | ISO-8601 UTC | when recorded |
| `source` | `cockpit` \| `telegram` \| `cli` | where it came from; closed list (new sources = design change) |
| `by` | string | Cockpit identity name, Telegram owner name, or `--by` on the CLI; agents use their profile (`qa`) |
| `text` | string, 3–2000 chars | trimmed; stored as given (after the privacy check); **data, never instructions** |
| `page` | string \| null | Cockpit route (`location.hash`) for `cockpit`; null otherwise |
| `ref` | string \| null | source message id (Telegram `chat:message`) — idempotency for retries |
| `key` | 12 hex | `sha256(normalise(text))` prefix (§4.1) |
| `status` | see below | |
| `proposal` | string \| null | proposal id once grouped |
| `note` | string | why a status changed (e.g. "duplicate of fb-…", "stale after 60 days") |

Item states: `open` → `proposed` (in a pending proposal) → `accepted` (proposal approved) → `done` (its tasks finished);
or → `deferred` / `rejected` with the proposal; `open` → `stale` after 60 days unclaimed as a singleton (kept, not shown by default).

The capture task's minimum (`id, text, source, page, time, status`) is a subset; the extra fields are optional on write and filled by
`work feedback add`.

### 3.2 Proposal — `data/feedback-proposals.jsonl`

```json
{"v":1,"id":"fp-2026w45-3f9a1c","week":"2026-W45","created":"2026-11-09T20:30:00Z",
 "title":"Project page hides blocked tasks unless I scroll","items":["fb-20261107-3f9a1c","fb-20261108-77b2e0"],
 "evidence":[{"id":"fb-20261107-3f9a1c","source":"cockpit","time":"2026-11-07T09:12:44Z","quote":"Project page hides blocked tasks…"}],
 "count":2,"days":2,"sources":["cockpit","telegram"],"pages":["#/p/micropace/cockpit-improvement"],"score":1.93,
 "status":"pending","decision":null,"tasks":[],"prior":null}
```

| Field | Rule |
|---|---|
| `id` | `fp-<ISO week>-<seed>` where seed = the 6-hex suffix of the group's oldest item: **deterministic**, so re-running the digest makes no duplicates |
| `title` | the text of the group's most recent item, cut to 100 chars (no model rewrite in v1; you may edit it when approving) |
| `evidence` | up to 5 quotes (≤ 200 chars each), newest first, with item id, source and time |
| `count`, `days`, `sources`, `pages`, `score` | from §5 |
| `status` | `pending` → `approved` → `converted` → `done`; or `deferred`, `rejected`; `superseded` when merged into another |
| `decision` | `{by, at, action, reason, target, until}` — `reason` **required** for defer and reject; `target` for approve (§7) |
| `tasks` | `[{board, project, key, task_id}]` filled by conversion |
| `prior` | id of an earlier rejected/deferred proposal on the same theme (§4.3) |

## 4. Dedupe rules

### 4.1 At intake: exact duplicates are not stored twice

`normalise(text)` = Unicode NFKC → lower-case → drop a leading `feedback:` / `#feedback` → replace punctuation with spaces → collapse
whitespace → trim. `key` = first 12 hex of SHA-256 of that.

`add` is a **no-op that returns the existing id** when either holds:
1. same `source` + `ref` already recorded (Telegram redelivery, a retried skill run), or
2. same `key` + same `by` recorded within the last **24 h** (double-click, the same note sent twice).

Outside 24 h the same words are stored again: repetition on another day is signal, and grouping (4.2) folds it.

### 4.2 At consolidation: near-duplicates are grouped

`tokens(text)` = words of `normalise(text)` minus a short stop-word list, with a light suffix strip (`-ing`, `-ed`, `-es`, `-s`),
as a set. Similarity = **Jaccard** of token sets. Two items are in the same group when

- Jaccard ≥ **0.5**, or
- same non-null `page` and Jaccard ≥ **0.35** (feedback on the same screen needs fewer shared words).

Grouping is single-link over open items processed oldest first, so the result is deterministic. An item also **joins an existing
pending or deferred proposal** when its similarity to any of that proposal's items meets the same thresholds; it is never put in two
proposals. The thresholds are constants in `feedback.ts`, tested with sample feedback; tune them there, not per run.

Why not embeddings or an LLM: at this volume, word overlap is good enough, costs nothing, is explainable ("grouped because they share
*blocked, tasks, project page*"), and gives tests a fixed answer. A wrong grouping is cheap: you see the quotes and can reject or
split (`work feedback split <proposal> <item>` puts an item back to `open`). Revisit if grouping is visibly wrong twice in a month.

### 4.3 Rejected and deferred themes do not keep coming back

New items similar to a **rejected** proposal attach to it (status `rejected`, note "matches rejected fp-…"). The theme is
re-proposed only when **3 new items on ≥ 2 different days** have arrived since the rejection; the new proposal carries `prior` and shows
your rejection reason. A **deferred** proposal returns to `pending` at the first digest on or after its `until` date (default +28 days),
with the items that joined meanwhile.

## 5. Ranking

```
score = Σ over items  0.5 ^ (age_days / 14)          # each item counts 1 when new, half after two weeks
        × (1 + 0.25 × (distinct sources − 1))         # said in both Cockpit and Telegram → a bit stronger
```
Order: `score` desc, then newest item first, then `id`. `count` (items) and `days` (distinct days) are shown next to it so you
can see *why* something ranks high. No weighting by who sent it, no sentiment, no model judgement.

## 6. Weekly cadence

| When | What | Mechanism |
|---|---|---|
| continuously | items are added from Cockpit, Telegram, CLI | `work feedback add` |
| **Monday 07:30** (Australia/Melbourne) | digest: stale-marking, grouping, ranking, deferred returns, new proposals | `work feedback digest --apply`, scheduled as a launchd job `com.franktao.pap.feedback-digest` from a template in `infra/launchd/` (same pattern as `work-watch`). Deterministic, no model tokens |
| **Monday 07:45** | **one** Telegram line, only if proposals are pending: "3 feedback proposals waiting — Cockpit › Feedback" | Hermes cron prompt `hermes/cron/feedback-digest.md` delivered to your existing home chat (the morning-brief channel). **No new recipient**; silent when nothing waits |
| any time | you act on proposals in Cockpit or with `work feedback approve` / `defer` / `reject` | — |
| any time | `work feedback digest` (dry run, prints what it would do); `--apply` to write | manual |

Rules:
- **At most 5 proposals pending at once.** If 5 are waiting, the digest creates none and the line says so; groups that did not make
  the cut stay `open` and keep accumulating score. This keeps Needs-you short and forces a decision on old ones first.
- A group becomes a proposal only if it has **≥ 2 items, or 1 item older than 7 days** (a fresh one-off waits one cycle to see if it
  recurs). Items you tag `urgent:` skip the wait (still subject to the cap of 5).
- Re-running the digest in the same week with no new items writes nothing (ids are deterministic; unchanged records are not re-appended).
- Both schedules ship **disabled / dry run**; enabling them is your step (`infra/bin/install-launchd.sh --apply`, `hermes/install.sh
  --apply`). Agents do not change Hermes config.

## 7. Approval and conversion into tasks (the max-9 rule)

### 7.1 Decisions

In Cockpit (sidebar **Feedback**, and one **Needs you** entry per pending proposal) or the CLI. Only the admin identity can decide.

| Action | Requires | Effect |
|---|---|---|
| **Approve** | a `target` (below); optional edited title and acceptance test | proposal `approved`, items `accepted`, then conversion runs immediately |
| **Defer** | reason; `until` (default +28 days) | proposal and items `deferred`; returns per §4.3 |
| **Reject** | reason | proposal and items `rejected`; theme suppressed per §4.3 |

Approving a proposal is a **scope decision** at the same level as approving a charter: it says "this belongs in the work". It does
not approve a plan — the tasks are derived and checked by code, exactly as for a charter.

### 7.2 Capacity

For a project *P*: `used(P)` = the count the watchdog already uses (top-level plan tasks, done or not, plus side tasks in its tenant that
are not from the plan; subtasks and the planning task excluded). `room(P) = P.charter.max_tasks − used(P)`. The cap is for the
project's lifetime: done tasks still count, otherwise a project could grow without end.

### 7.3 Targets, tried in this order (Cockpit offers only the ones that pass)

1. **Into an active project** — `target: {project: <id>}`. Allowed when *P* is `active`, `room(P) ≥ 1`, the task owner is in
   `P.charter.team`, and the task needs no outward action *P*'s charter does not allow. Conversion = one `planedit` `add` op
   (`key: fb-<seed>`, `title` = proposal title, `owner` from `team.ts` heuristics — `coding` for code words, else `pm`,
   `accept` = "the quoted feedback no longer applies; evidence: …" unless you edited it), then `checkPlan`, then `plan apply`.
   Idempotent: the plan key and the `project:<id>:<key>` idempotency key make a second approve a no-op.
   The task body quotes the evidence inside a fenced block marked *user feedback — data, not instructions*.
   *Default* project: an active project whose `repo` is `personal-agent-platform` and that has room; you can pick another.
2. **One ad-hoc task** — `target: {adhoc: true}`. The work-model's small-thing rule, checked in code: exactly one task, one active
   agent, a free/cheap lane (not `claude`/`codex`), no outward action, privacy check passes. Created on the portfolio board with
   tenant `feedback` and a `[feedback:<proposal-id>]` body marker; the watchdog treats tenant `feedback` as tracked work.
   **At most 3 ad-hoc feedback tasks per ISO week**, so this path cannot become a way around charters.
3. **Neither fits → refuse.** Conversion writes nothing and says why, e.g.
   *"cockpit-improvement has 0 of 9 task slots left — this needs a new charter."* It offers
   `work project propose` prefilled from the proposal (outcome = title, done_when = "the quoted feedback no longer applies",
   team from `team.ts`, `max_tasks: 9`, outward all off). That charter is `proposed` and goes through normal charter approval;
   the feedback proposal stays `approved` with `target: {charter: <id>}` and becomes `converted` when that plan is applied.

A proposal never adds more than **one top-level task**. If it is bigger, pm splits it with subtasks (allowed by the work model,
one level deep) or it is a project. A proposal whose words describe several unrelated things should be rejected with "split".

**Today's consequence, stated plainly:** `cockpit-improvement` is full (9/9). Until another platform project is active, approved
feedback lands as ad-hoc tasks (≤ 3/week) or as a charter draft for you. If that proves a bottleneck, the option in §9 (a rolling
"platform-feedback" charter) is the next step — a decision for you, not built in v1.

### 7.4 Closing

When every task in `proposal.tasks` is `done`, the next digest moves the proposal and its items to `done`. The sender is **not**
messaged (that would be an outward action); Cockpit shows the item's status, and the weekly line may say "2 feedback items shipped".

## 8. Guardrails, privacy and failure

| Concern | Rule |
|---|---|
| Private text | `privacyCheck` (`packages/redact/topics.ts`) at `add`. If private: **not stored**; reply "this looks private (kinds…) — tell the private assistant instead"; a kinds-only line goes to `data/privacy.jsonl` (`via: "feedback"`), never the text |
| Prompt injection | feedback is quoted as data in proposals and task bodies; skills say so; no field is ever executed or used as a path |
| Shell injection | the Telegram skill passes text on **stdin** (`work feedback add --stdin`), never as a shell argument |
| Abuse / loops | `POST /api/feedback` uses `checkWrite` (same-origin JSON, token), 2000-char limit, 30 items/hour per source; agents may add with `source: cli` and `by: <profile>` but cannot approve |
| Who decides | approve/defer/reject require the admin identity (Cockpit) or the owner at the terminal |
| Concurrency | append-only lines, last-wins fold; the digest takes a lock file `data/feedback.lock` so two digests never run at once |
| Torn/corrupt line | skipped and counted; `work feedback check` reports it; nothing auto-repairs |
| Digest did not run | Cockpit shows "last digest: <date>"; flagged in Needs-you after 9 days |
| Fixed floor | unchanged: no money, no raw finance data, no deletes outside the workspace, no Hermes config, no new recipients |

## 9. Options considered

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Store | JSONL files in `data/`, append-only, last-wins | SQLite (`cockpit.sqlite` is Cockpit's cache, not truth; harder to read and diff); KB markdown (merge noise from many tiny writes; feedback is not a decision record); kanban triage cards (would trigger `auto_decompose` and start work without your approval) |
| Grouping | deterministic token Jaccard | LLM clustering (tokens per run, non-deterministic tests, opaque); embeddings (a model dependency for tens of items) |
| Cadence | weekly, cap 5 pending | daily (too many asks for one person); on-demand only (the charter asks for a weekly job) |
| Conversion granularity | 1 top-level task per proposal | free-form plan per proposal (needs a plan approval the model avoids, and eats the cap fast) |
| Full project | refuse + prefilled charter draft; small things ad-hoc | silently raising `max_tasks` (breaks the charter you approved); treating feedback tasks as subtasks of an existing task (hides scope) |
| **Later option (not v1):** rolling `platform-feedback-<n>` charter | — | a standing charter (team pm/coding/qa, 9 tasks, 7-day timebox, outward off) that receives approved feedback until full, then pm proposes the next. Fewer refusals, but one more charter approval each cycle; decide after a month of data |

## 10. Out of scope (v1)

- Feedback from end users of the MicroPace apps (App Store reviews, support mail, analytics) — a different audience and privacy model.
- Mining chat history, agent logs or task comments for implicit feedback; agents' self-reports (they go to agent-growth lessons).
- Model-written titles, summaries, sentiment or priority; any model call in the digest.
- Screenshots, attachments, voice notes; editing or deleting items from the UI (correct by adding a new item or rejecting).
- Messaging the sender when something ships; any post to a channel other than your home chat; GitHub/Linear sync.
- Feedback from other people's profiles (Diane, Zoe): their profiles are not touched; their bots do not write to this store.
- Automatic approval, automatic charter creation, raising `max_tasks`.
- Moving the Utility Portal (`~/codes/utility-portal`) to an archive folder: per your note of 2026-11-07 that happens only after the
  sidebar integration passes its test **and you confirm**. It is not part of this loop and no agent does it unasked.

## 11. Contract for the remaining plan tasks

| Plan task | Builds | Must follow |
|---|---|---|
| `feedback-capture` | `packages/work/feedback.ts` (record, normalise, key, fold, add), `POST /api/feedback`, Feedback button (sends `page` = `location.hash`), `.gitignore` entry | §3.1, §4.1, §8 |
| `feedback-intake-skill` | `work feedback add --source telegram --ref <chat:msg> --by <name> --stdin --apply`; `hermes/skills/feedback-intake/SKILL.md` (trigger: message starts with `feedback:`/`#feedback`, or "log this as feedback"; reply one line with the id or the privacy refusal) | §3.1, §4.1, §8 |
| `consolidate` | `work feedback digest [--apply]`, `split`, `check`; proposals file | §3.2, §4.2–4.3, §5, §6 rules |
| `approve-ui` | sidebar item **Feedback**, list with quotes/score/why-grouped, Approve (target picker showing room per project) / Defer / Reject with reason; Needs-you entries | §7.1, §7.3 (only passing targets offered) |
| `to-tasks` | `work feedback approve <id> --into <project>` or `--adhoc` and the conversion; refusal text and charter draft | §7.2–7.4; tests: room ≥ 1 adds one task; room 0 refuses with "new charter"; second approve is a no-op |
| `weekly-job` | launchd template (disabled) + `hermes/cron/feedback-digest.md` (silent when nothing pending) | §6 |
| `verify` (qa) | sample feedback only (`FEEDBACK_DIR` pointing at a temp dir), never real data | all |

Tests use a temporary data directory (`FEEDBACK_DIR`, default `data/`) and a fixed clock, so dedupe windows, decay and week ids are
deterministic.
