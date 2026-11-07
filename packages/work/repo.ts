// Files for a brand-new repo that starts life as a project. Deterministic text from what the human typed: no model involved.

export interface NewRepo { id: string; title: string; portfolio: string; outcome: string; done_when: string[]; test_cmd: string; created: string }

export const titleOf = (id: string): string => id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export function renderReadme(r: NewRepo): string {
  return `# ${r.title}

${r.outcome}

## Goal (v1)

${r.done_when.map((d) => `- [ ] ${d}`).join('\n')}

## Status

Created ${r.created} from a Cockpit project charter (portfolio: ${r.portfolio}). Nothing is built yet; the plan lives in the project file in \`~/PortfolioKB/${r.portfolio}/projects/\`.

## Develop

${r.test_cmd ? `Run the checks with:\n\n\`\`\`sh\n${r.test_cmd}\n\`\`\`` : 'No test command yet. The first task is to add one and record it here.'}

## Layout

Fill this in as the structure appears. Keep decisions that are hard to reverse in \`docs/decisions.md\`.
`;
}

export function renderAgents(r: NewRepo): string {
  return `# ${r.title}: notes for agents

Outcome: ${r.outcome}

How to work here
- Work on a feature branch linked to the task (never on the default branch). When the acceptance test and the tests pass, commit.
- Every repo needs a remote. Push the branch and raise a pull request into the default branch; resolve merge conflicts yourself and re-run the tests. Do not merge your own PR. If there is no remote or the push fails, block the task with the error.
- ${r.test_cmd ? `Run \`${r.test_cmd}\` before you hand a task back, and say what it printed.` : 'Add a test command first, record it in README.md, then use it on every task.'}
- Update the checklist in README.md when a goal is met, with evidence (test name, URL, screenshot path).
- Never commit secrets, real personal or financial data, or generated build output.
- Publishing, deploying and spending go through the outbox; do not do them yourself.
`;
}

export const GITIGNORE = `.DS_Store
node_modules/
.env
.env.*
*.xcconfig
!*.example.xcconfig
__pycache__/
.venv/
dist/
build/
DerivedData/
`;
