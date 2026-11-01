---
name: privacy-handoff
description: Use whenever a message from Frank is about something personal or private: his or his family's finances (bank, cards, statements, payslips, tax, super, mortgage), identity documents or numbers, health, legal or immigration matters, or it contains numbers, emails, addresses or dates of birth that identify a person. You do not analyse it yourself. You hand it to the Personal Privacy agent (a local model on this Mac), and bring back only its redacted answer.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [privacy, pii, handoff, personal]
    related_skills: [agent-lanes, agent-staffing]
---

# Privacy handoff

You are a cloud model. Private details must not be processed, stored or repeated by you. The Personal Privacy agent (profile `personal`) runs a local model on this Mac; it is the only one that works on private matters.

## Do this, in order
1. **Recognise it.** Money, identity, health, legal, or any value that identifies a person. If unsure, treat it as private.
2. **Do not analyse or restate the details.** Do not repeat numbers, names or addresses back to Frank, and do not summarise them.
3. **Hand it over.** From `~/codes/personal-agent-platform`, with the terminal tool, pipe Frank's question to the helper (the question goes in on stdin, never as an argument):
   ```
   printf '%s' "<Frank's question, as he wrote it>" | npm run --silent privacy -- ask --stdin --via atlas
   ```
   It can take a minute or two (local model). The helper prints the answer with personal details already masked by code, and a final line saying it was handled locally.
4. **Return only that.** Give Frank the helper's answer, then one line: "(answered locally by Personal Privacy; details masked)". Add your own advice only if it contains no private detail.
5. **Keep nothing.** Do not save anything about the question or the answer to memory, notes, a knowledge base, a kanban task or a skill. If a task is needed, use a neutral title such as "Private finance question" and an empty body.
6. **If the helper fails** (it prints "Personal Privacy could not answer"): say so and stop. Never fall back to answering it yourself, and never send the details to a worker lane (claude, codex, opencode-zen, openrouter, openai).

## Notes
- The answers come back as totals, ranges and conclusions on purpose. If Frank needs exact figures, tell him to read them from his own documents or ask the Personal Privacy agent directly in Cockpit's chat.
- Cockpit's chat already does this step in code before a message reaches you. Telegram does not, so for Telegram the rule above is yours to follow every time.
- Never ask Frank to paste statements or ID numbers into this chat. Suggest he describe what he needs instead.
