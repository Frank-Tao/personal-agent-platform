import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDir, liveConfig } from '../../packages/paths/paths.ts';
import { pythonSender, type Sender } from '../../packages/mailcopy/mailcopy.ts';
import { appendLog, decideMail, insideAgent, listHeld, loadPolicy, newMailId, readHeld, saveHeld, sentSince, validate, type HeldMail, type MailRequest } from '../../packages/mail/mail.ts';
import { flag, root, type Ctx } from '../shared.ts';

/**
 * Email from agents, through the Atlas mailbox:
 *   work mail send --to a@x[,b@y] --subject "…" (--body-file f | --body "…" | --stdin) --by <roster id> [--project id] [--apply]
 *       allowed recipients, nothing private, under the hourly limit → sent now; otherwise held for a person to release
 *   work mail list [--all] | show <id> | policy
 *   work mail release <id> --by <person> --apply | deny <id> --by <person> [--reason "…"] --apply     (people only: Cockpit or your terminal)
 */
export function cmdMail(c: Ctx, sender?: Sender) {
  const [, sub, arg] = c.pos;
  const data = dataDir(c.env);
  const now = c.env.WORK_NOW ? new Date(c.env.WORK_NOW) : new Date();
  const policy = () => loadPolicy({
    hermesEnv: c.env.HERMES_ENV ?? join(c.hermesHome, '.env'),
    mailcopy: c.env.MAILCOPY_CONFIG ?? liveConfig('mailcopy.json', c.env),
    mailConfig: c.env.MAIL_CONFIG ?? liveConfig('mail.json', c.env),
  });
  const send = sender ?? pythonSender(join(root, 'infra', 'bin', 'send-mail.py'), c.env.PYTHON || undefined, { ...process.env, ...c.env });
  const deliver = (m: Outgoing) => deliverWith(send, m);

  if (sub === 'policy') {
    const p = policy();
    c.out(`allowed addresses: ${p.emails.join(', ') || '(none)'}`);
    c.out(`allowed domains:   ${p.domains.map((d) => '@' + d).join(', ') || '(none)'}`);
    c.out(`limit: ${p.maxPerHour} per hour; anything else is held for a person to release`);
    return;
  }
  if (sub === 'list') {
    const rows = listHeld(data, c.flags.get('all') === true);
    if (!rows.length) c.out('no mail waiting for release');
    for (const m of rows) c.out(`${m.id}  ${m.status.padEnd(7)}${m.by.padEnd(10)}${m.to.join(',').slice(0, 40).padEnd(42)}${m.subject.slice(0, 50)}  — ${m.reasons.join('; ')}`);
    return;
  }
  if (sub === 'show') { c.out(JSON.stringify(readHeld(data, arg ?? ''), null, 2)); return; }

  if (sub === 'send') {
    const to = String(flag(c, 'to') ?? '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    const file = flag(c, 'body-file');
    const body = file ? readFileSync(file.replace(/^~(?=\/)/, homedir()), 'utf8') : c.flags.get('stdin') === true ? readFileSync(0, 'utf8') : String(flag(c, 'body') ?? '');
    const req: MailRequest = { to, subject: String(flag(c, 'subject') ?? ''), body, by: String(flag(c, 'by') ?? ''), project: flag(c, 'project') ?? null };
    validate(req);
    const p = policy();
    const v = decideMail(req, p, sentSince(data, now.getTime() - 3_600_000));
    const base = { at: now.toISOString(), by: req.by, project: req.project, to: req.to, subject: req.subject, bytes: req.body.length };
    if (v.status === 'send') {
      c.out(`  ✓ allowed: ${req.to.join(', ')}`);
      if (!c.apply) { c.out('(dry run — add --apply to send)'); return; }
      const id = newMailId(now), r = deliver(req);
      appendLog(data, { ...base, id, status: r.ok ? 'sent' : 'failed', reason: r.error });
      if (!r.ok) throw new Error(`not sent: ${r.error ?? 'send failed'}`);
      c.out(`  ✓ sent (${id})`);
      return;
    }
    c.out(`  ▲ held for a person to release: ${v.reasons.join('; ')}`);
    if (!c.apply) { c.out('(dry run — add --apply to save the draft)'); return; }
    const id = newMailId(now);
    saveHeld(data, { ...req, id, created: now.toISOString(), reasons: v.reasons, status: 'held' });
    appendLog(data, { ...base, id, status: 'held', reason: v.reasons.join('; ') });
    c.out(`  ▲ saved as ${id}: it shows in Cockpit (Needs you). Do not send it another way; say in your hand-off that it waits for release.`);
    return;
  }

  if (sub === 'release' || sub === 'deny') {
    if (insideAgent(c.env)) throw new Error('releasing or denying mail is for a person (Cockpit or your own terminal), not an agent');
    settleMail(c, arg ?? '', sub, String(flag(c, 'by') ?? ''), flag(c, 'reason') ?? '', sender);
    return;
  }
  throw new Error('usage: work mail send|list|show|policy|release|deny');
}

type Outgoing = { to: string[]; subject: string; body: string; by: string; project: string | null };
const deliverWith = (send: Sender, m: Outgoing) =>
  send({ to: m.to, subject: m.subject, body: `${m.body}\n\n—\nSent by ${m.by === 'atlas' ? 'Atlas' : `the ${m.by} agent, through Atlas`}${m.project ? ` (project ${m.project})` : ''}. Reply to this address to reach Atlas.` });

/** Send or deny a held email. The caller has checked that a person asked for it (Cockpit, a terminal, or a reply code). */
export function settleMail(c: Ctx, id: string, sub: 'release' | 'deny', by: string, reason: string, sender?: Sender) {
  const data = dataDir(c.env);
  const now = c.env.WORK_NOW ? new Date(c.env.WORK_NOW) : new Date();
  const send = sender ?? pythonSender(join(root, 'infra', 'bin', 'send-mail.py'), c.env.PYTHON || undefined, { ...process.env, ...c.env });
  const deliver = (m: Outgoing) => deliverWith(send, m);
  {
    const m = readHeld(data, id);
    if (m.status !== 'held') throw new Error(`${m.id} is ${m.status}, not held`);
    if (!/^[A-Za-z][A-Za-z .'-]{0,40}$/.test(by)) throw new Error('--by <your name> is required');
    c.out(`  ${sub === 'release' ? '→ send' : '✗ deny'} ${m.id}: "${m.subject}" to ${m.to.join(', ')}`);
    if (!c.apply) { c.out('(dry run — add --apply)'); return; }
    const base = { at: now.toISOString(), id: m.id, by: m.by, project: m.project, to: m.to, subject: m.subject, bytes: m.body.length };
    if (sub === 'deny') {
      saveHeld(data, { ...m, status: 'denied', decided_by: by, decided_at: now.toISOString(), result: reason || undefined });
      appendLog(data, { ...base, status: 'denied', reason: `by ${by}${reason ? ': ' + reason : ''}` });
      c.out('  ✓ denied: it will not be sent');
      return;
    }
    const r = deliver(m);
    saveHeld(data, { ...m, status: r.ok ? 'sent' : 'held', decided_by: by, decided_at: now.toISOString(), result: r.ok ? 'sent' : r.error });
    appendLog(data, { ...base, status: r.ok ? 'released' : 'failed', reason: r.ok ? `released by ${by}` : r.error });
    if (!r.ok) throw new Error(`not sent: ${r.error ?? 'send failed'} (still held; try again)`);
    c.out('  ✓ sent');
  }
}
