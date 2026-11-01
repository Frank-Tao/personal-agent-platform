# Portfolio knowledge base template

`npm run work -- kb init --apply` copies this into `~/PortfolioKB/<portfolio>/` (never overwriting existing files) and `git init`s each
portfolio. Agents read it; you can open the folder in Obsidian.

Per portfolio:
- `objectives.md` — rolling objectives and key results (you approve them; reviewed weekly)
- `projects/<slug>.md` — one file per project: the **charter** (front-matter, what you approve), the plan `pm` writes, and a log
- `context.md` — what every agent on this portfolio must know
- `decisions.md` — dated one-liners; project retrospectives land here
- `playbooks/` — how recurring work is done

No account numbers, tax IDs, statements or credentials — ever. Design: `docs/design/work-model.md`.
