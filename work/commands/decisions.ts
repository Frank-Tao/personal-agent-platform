import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DecisionError, PORTFOLIO_SCOPE, STATUSES, addDecision, findDecision, readDecisions, setStatus, type AddInput, type Decision, type DecisionStatus } from '../../packages/work/decisions.ts';
import { briefBudget, buildBrief, type BriefResult } from '../../packages/work/handover.ts';
import { PORTFOLIOS, boardOf, flag, kanban, loadProject, tenantTasks, type Ctx } from '../shared.ts';

/** Record a decision that an action of ours already is (an approval, a setting change). Never blocks the action it describes. */
export function noteDecision(c: Ctx, i: Omit<AddInput, 'date'>): void {
  if (!c.apply) return;
  try {
    const r = addDecision(c.kb, { ...i, date: c.today });
    c.out(`  ✓ ${r.duplicate ? 'already in' : 'added to'} the decision ledger: ${r.decision.ref}`);
  } catch (e) { c.out(`  ▲ not added to the decision ledger: ${(e as Error).message}`); }
}

const show = (d: Decision) => `${d.ref}  ${d.date}  [${d.status}${d.kind === 'question' ? ', question' : ''}]  ${d.by || '—'}  ${d.title}${d.why ? `\n      why: ${d.why}` : ''}${d.source ? `\n      source: ${d.source}` : ''}`;

export function cmdDecision(c: Ctx) {
  const sub = c.pos[1];
  if (sub === 'list' || !sub) {
    const project = c.pos[2];
    const portfolio = flag(c, 'portfolio') ?? (project ? loadProject(c, project).project.portfolio : undefined);
    const st = flag(c, 'status');
    if (st && !(STATUSES as string[]).includes(st)) throw new Error(`--status must be one of ${STATUSES.join(', ')}`);
    const rows = readDecisions(c.kb, { portfolio, project, status: st as DecisionStatus | undefined, includeLegacy: !project });
    if (c.flags.get('json')) { c.out(JSON.stringify(rows)); return; }
    if (!rows.length) { c.out('no decisions recorded' + (project ? ` for ${project}` : '')); return; }
    for (const d of rows) c.out(show(d));
    return;
  }
  if (sub === 'add') {
    const project = c.pos[2];
    const portfolio = flag(c, 'portfolio') ?? (project ? loadProject(c, project).project.portfolio : '');
    if (!portfolio || !PORTFOLIOS.includes(portfolio)) throw new Error('usage: work decision add <project> | --portfolio <p>  --title "…" [--why "…"] [--by who] [--source "task t_…"] [--status proposed] [--question] [--supersedes D1] [--apply]');
    const input: AddInput = { portfolio, ...(project ? { project } : {}), title: flag(c, 'title') ?? '', why: flag(c, 'why'), by: flag(c, 'by'), source: flag(c, 'source') ?? 'manual', status: flag(c, 'status') === 'proposed' ? 'proposed' : 'active', kind: c.flags.get('question') ? 'question' : 'decision', supersedes: flag(c, 'supersedes'), date: c.today };
    if (!c.apply) {
      // Same checks, nothing written (a throw-away folder would hide a duplicate; the ledger is read for that).
      if ((flag(c, 'title') ?? '').trim().length < 6) throw new DecisionError('say what was decided (at least a few words)');
      c.out(`· would record in ${portfolio}/${project ?? PORTFOLIO_SCOPE}: ${input.title} (${input.status}, by ${input.by ?? 'unknown'})`); c.out('(dry run — add --apply)'); return;
    }
    const r = addDecision(c.kb, input);
    c.out(`${r.duplicate ? '· already recorded' : '✓ recorded'}: ${show(r.decision)}`);
    return;
  }
  if (sub === 'confirm' || sub === 'reject' || sub === 'revert') {
    const ref = c.pos[2] ?? '';
    const found = findDecision(c.kb, ref);
    if (!found) throw new Error(`no decision ${ref || '(give a reference like micropace/notice-v1/D3)'}`);
    const status: DecisionStatus = sub === 'confirm' ? 'active' : sub === 'reject' ? 'rejected' : 'reverted';
    if (!c.apply) { c.out(`· would mark ${ref} ${status}`); c.out('(dry run — add --apply)'); return; }
    c.out(`✓ ${show(setStatus(c.kb, ref, status, flag(c, 'by') ?? 'unknown', flag(c, 'reason')))}`);
    return;
  }
  throw new Error('usage: work decision list [project] | add <project> --title … | confirm|reject|revert <ref>');
}

/** Models can be told apart by how much brief they can take: `--model` looks the model up in config/models.json (context window, or private = local). */
function budgetFor(c: Ctx): number {
  const n = flag(c, 'budget');
  if (n && Number(n) > 0) return Math.max(1000, Math.min(20_000, Math.floor(Number(n))));
  const m = flag(c, 'model');
  if (!m) return briefBudget();
  try {
    const cfg = JSON.parse(readFileSync(join(c.templateDir, '..', 'config', 'models.json'), 'utf8')) as { choices?: Array<{ model: string; private?: boolean; context?: number }> };
    return briefBudget(cfg.choices?.find((x) => x.model === m) ?? null);
  } catch { return briefBudget(); }
}

export function cmdBrief(c: Ctx) {
  const { project: p } = loadProject(c, c.pos[1] ?? '');
  const board = boardOf(c, p);
  const results: BriefResult[] = [];
  if (board) {
    try {
      const done = tenantTasks(c, board, p.tenant).filter((t) => t.status === 'done' && !/^Plan project /.test(t.title)).sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0)).slice(0, 5);
      for (const t of done) {
        let summary = '';
        try { summary = String((JSON.parse(kanban(c, board, ['show', '--json', t.id])) as { latest_summary?: string }).latest_summary ?? ''); } catch { /* no summary */ }
        results.push({ title: t.title.replace(/^\[[^\]]+\]\s*/, ''), status: 'done', assignee: t.assignee, completed: t.completed_at ? new Date(t.completed_at * 1000).toISOString() : null, summary });
      }
    } catch { /* Hermes unreachable: the brief still has the charter and the decisions */ }
  }
  const decisions = [...readDecisions(c.kb, { portfolio: p.portfolio, project: p.id }), ...readDecisions(c.kb, { portfolio: p.portfolio, project: PORTFOLIO_SCOPE, includeLegacy: false }), ...readDecisions(c.kb, { portfolio: p.portfolio, includeLegacy: true }).filter((d) => d.legacy)];
  const { text } = buildBrief({ project: { id: p.id, portfolio: p.portfolio, status: p.status, priority: p.priority, outcome: p.charter.outcome, done_when: p.charter.done_when, repo: p.repo, team: p.charter.team }, today: c.today, decisions, results, budget: budgetFor(c) });
  c.out(text);
}
