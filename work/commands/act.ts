import { join } from 'node:path';
import { dataDir } from '../../packages/paths/paths.ts';
import { insideAgent } from '../../packages/mail/mail.ts';
import { ANSWERS, CodeError, cleanAct, needKey, redeemCode, snooze, type NeedAct } from '../../packages/needs/needs.ts';
import { fileAudit } from '../../apps/cockpit/src/audit.ts';
import { csv, flag, type Ctx } from '../shared.ts';
import { settleMail } from './mail.ts';

/**
 * Answer a Needs-you item with yes or no.
 *   work act <CODE> yes|no [--via telegram|email]     a reply code from the daily digest (Atlas runs this when the owner replies); acts at once
 *   work act --kind K (--project p | --id x | --refs a,b) --answer yes|no --by <name> [--via cockpit] --apply
 *                                                      the same, from Cockpit or a terminal; refused inside an agent session
 * "Not now" answers snooze the item for a day. Every answer is written to the audit log.
 */
export function cmdAct(c: Ctx) {
  const data = dataDir(c.env);
  const via = (flag(c, 'via') ?? 'cli').replace(/[^a-z]/g, '').slice(0, 12) || 'cli';
  const code = c.pos[1];
  let act: NeedAct | null, answer: string, by: string, label: string;
  if (code) {
    answer = (c.pos[2] ?? '').toLowerCase();
    if (!['yes', 'no'].includes(answer)) throw new Error('usage: work act <CODE> yes|no');
    try { ({ act, label } = redeemCode(data, code)); } catch (e) {
      audit(c, data, { who: 'Frank', via, action: 'act.code', target: code.slice(0, 12), ok: false, detail: { error: (e as Error).message } });
      throw e;
    }
    by = 'Frank';                       // codes are only ever sent to the owner
    c.apply = true;                     // the reply is the confirmation; a used code cannot be replayed
  } else {
    if (insideAgent(c.env)) throw new Error('an agent answers Needs-you items only with a reply code the owner sent (work act <CODE> yes|no)');
    act = cleanAct({ kind: flag(c, 'kind'), project: flag(c, 'project'), id: flag(c, 'id'), refs: csv(flag(c, 'refs')) });
    answer = (flag(c, 'answer') ?? '').toLowerCase();
    by = flag(c, 'by') ?? '';
    if (!act) throw new Error('give --kind and the item (--project, --id or --refs)');
    if (!['yes', 'no'].includes(answer)) throw new Error('--answer yes|no');
    if (!/^[A-Za-z][A-Za-z .'-]{0,40}$/.test(by)) throw new Error('--by <your name> is required');
    label = `${act.kind} ${act.project ?? act.id ?? act.refs?.join(',')}`;
  }
  const word = ANSWERS[act.kind][answer as 'yes' | 'no'];
  c.out(`  ${word}: ${label}`);
  if (!c.apply) { c.out('(dry run — add --apply)'); return; }
  try {
    perform(c, act, answer === 'yes', by, via);
    audit(c, data, { who: by, via, action: `act.${act.kind}.${answer}`, target: act.project ?? act.id ?? (act.refs ?? []).join(','), ok: true, detail: { label } });
    c.out(`  ✓ done: ${word.toLowerCase()} — ${label}`);
  } catch (e) {
    audit(c, data, { who: by, via, action: `act.${act.kind}.${answer}`, target: act.project ?? act.id ?? '', ok: false, detail: { error: (e as Error).message.slice(0, 200) } });
    throw e;
  }
}

function audit(c: Ctx, data: string, e: { who: string; via: string; action: string; target: string; ok: boolean; detail?: Record<string, unknown> }) {
  fileAudit(c.env.AUDIT_LOG ?? join(data, 'audit.jsonl')).log({ who: e.who, device: e.via, action: e.action, target: e.target, ok: e.ok, detail: e.detail });
}

/** Run another work command; its errors become this one's. */
function step(c: Ctx, argv: string[]) {
  const lines: string[] = [];
  const code = c.rerun ? c.rerun(argv, (s) => lines.push(s)) : 1;
  for (const l of lines) if (/^\s*(✓|→|▶|✗|▲)/.test(l)) c.out('    ' + l.trim());
  if (code !== 0) throw new CodeError(lines.filter((l) => l.startsWith('error:')).map((l) => l.slice(7)).join('; ') || `${argv.slice(0, 2).join(' ')} failed`);
}

function perform(c: Ctx, a: NeedAct, yes: boolean, by: string, via: string) {
  const later = () => { snooze(dataDir(c.env), needKey({ act: a, kind: 'approval', portfolioId: '', title: '' }), 1); c.out('    snoozed for a day'); };
  const p = a.project ?? '', id = a.id ?? '';
  switch (a.kind) {
    case 'approve-charter':
    case 'auto-start':
      if (!yes) { if (a.kind === 'auto-start') step(c, ['project', 'set', p, '--autonomy', 'semi', '--by', by, '--reason', `stopped by ${by} (${via})`, '--apply']); else later(); return; }
      step(c, ['project', 'approve', p, '--by', by, '--note', `Approved by ${by} (${via}).`, '--apply']);
      step(c, ['advance', '--project', p, '--apply']);          // ask pm to plan now rather than at the next timer pass
      return;
    case 'close-project': if (!yes) return later(); step(c, ['close', p, '--by', by, '--reason', `marked done by ${by} (${via})`, '--apply']); return;
    case 'resume-project': if (!yes) return later(); step(c, ['project', 'resume', p, '--apply']); return;
    case 'outbox': step(c, ['outbox', yes ? 'release' : 'deny', id, '--apply']); return;
    case 'mail': settleMail(c, id, yes ? 'release' : 'deny', by, yes ? '' : `denied by ${by} (${via})`); return;
    case 'decisions':
      if (!yes) return later();
      for (const ref of a.refs ?? []) step(c, ['decision', 'confirm', ref, '--by', by, '--apply']);
      return;
  }
}
