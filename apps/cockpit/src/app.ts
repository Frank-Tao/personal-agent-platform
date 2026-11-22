import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { buildBrief } from './brief.ts';
import { streamChat, streamPrivate, validateChat, type ChatOptions } from './chat.ts';
import { privacyCheck } from '../../../packages/redact/topics.ts';
import { BodyError, checkHost, checkWrite, readJson, type GuardOptions } from './security.ts';
import type { Workload } from './workload.ts';
import type { NowWorking } from './working.ts';
import { assignTask, createTask, findTask, searchTasks, showTask, TaskError, type TaskDeps } from './tasks.ts';
import { evaluateStaffing } from '../../../packages/roster/staffing.ts';
import type { CatalogEntry } from '../../../packages/roster/catalog.ts';
import { DocError, maskSensitive, type AgentDetail } from './sources/agentDetail.ts';
import { ANYONE, type Person } from './identity.ts';
import { AGENT_PATH, GROWTH_PATH, checkAccess, roleOf } from './access.ts';
import { cleanAct } from '../../../packages/needs/needs.ts';
import type { StaffingRecord } from '../../../packages/work/scorecard.ts';
import { lineDiff, type AuditLog } from './audit.ts';
import type { VersionInfo } from './version.ts';
import { adminSession, handleAdminParam, type AdminStore } from './admin.ts';
import { blurTopics, canSee, hiddenNotice, mentionsHidden, redactRollup, scrubDeep, scrubText } from './visibility.ts';
import type { Rollup } from './types.ts';
import { listChoices, loadLanes, requestedChain, setAgentModel, type AgentsRun } from './agentsApi.ts';
import { growthAct, showGrowth, type GrowthRun } from './growthApi.ts';
import { FeedbackError, type AddInput, type FeedbackItem } from '../../../packages/work/feedback.ts';
import type { PortfolioPanel } from '../../../packages/portfolio/panel.ts';
import type { ListOpts, getSession as GetSession, listSessions as ListSessions } from './sources/sessions.ts';
import { readDecisions, STATUSES } from '../../../packages/work/decisions.ts';
import { WorkError, actOnProject, decisionArgs, listProjects, listRepos, proposeProject, type WorkRun } from './work.ts';

export interface AppDeps {
  publicDir: string;
  /** Remember who gave a task its owner and why (data/staffing.jsonl). */
  recordStaffing?: (r: StaffingRecord) => void;
  /** Track record (work scorecard --json), cached by the caller. */
  scorecard?: (days: number) => Promise<unknown>;
  /** Hide a Needs-you item for `days` (0 = show it again); returns until when. */
  snooze?: (key: string, days: number) => string;
  guard: GuardOptions;
  chat: ChatOptions;
  tasks: Omit<TaskDeps, 'assignable'>;
  getRollup: (fresh: boolean) => Promise<Rollup>;
  history: (days: number) => unknown;
  agentDetail: (id: string) => AgentDetail | null;
  /** Saves an edit to one of an agent's text files (SOUL.md, MEMORY.md, USER.md); absent in demo mode. */
  saveAgentDoc?: (id: string, file: string, text: unknown, base: unknown) => AgentDetail;
  catalog: () => CatalogEntry[];
  /** Answers a private message locally (Personal Privacy agent); the redacted answer only. */
  privacyAsk: (text: string) => Promise<{ answer: string; masked: number }>;
  /** Runs the `growth` CLI (what each agent has learned, about you, and how it is improving). */
  growthRun: GrowthRun;
  /** Runs the `agents` CLI and where the switchable models are listed. */
  agentsRun: AgentsRun;
  modelsPath: string;
  /** Runs the `work` CLI (injected so tests need no Hermes). */
  work: WorkRun;
  /** Who is asking (from the tailscale proxy's forwarded address). Absent = everyone is Frank (tests, demo). */
  identify?: (req: import('node:http').IncomingMessage, admin: boolean) => Person | Promise<Person>;
  /** The Admin view (?admin=<secret>): where the secret comes from and where its last use is kept; absent = no admin view. */
  admin?: { token: () => string | undefined; store: AdminStore };
  /** The family portfolio panel (read from the tracker's snapshot file); absent = the panel reports unavailable. */
  portfolio?: () => PortfolioPanel;
  /** Which Cockpit this is (prod, dev, demo), its branch and commit; absent = the route reports unknown. */
  version?: () => Promise<VersionInfo>;
  /** Hermes conversation history, read-only (injected; absent in demo mode). Owner only. */
  sessions?: { list: (o: ListOpts) => ReturnType<typeof ListSessions>; get: (id: string, o: { offset?: number; limit?: number }) => ReturnType<typeof GetSession> };
  /** The knowledge base folder the decision ledger is read from (changes go through the work CLI); absent = no decisions. */
  decisionsKb?: string;
  /** The trace of who changed what (agent prompts, memory, models) and of refused writes; absent = nothing is recorded (tests, demo). */
  audit?: AuditLog;
  /** Which portfolio (group) a kanban board belongs to. */
  groupOfBoard?: (board: string) => string | undefined;
  /** The agent workload timeline (see workload.ts); absent = the chart says there is no data. */
  workload?: () => Workload;
  /** Tasks with a live run right now (see working.ts), for the header. */
  working?: () => NowWorking;
  /** Every kanban board slug Cockpit knows (task-id search looks on each). */
  boardSlugs?: () => string[];
  /** Opens a folder in Finder on this Mac (injected; absent in tests and demo mode). */
  openPath?: (path: string) => void;
  /** Records one feedback item (injected; absent in demo mode). The caller stamps source and who. */
  addFeedback?: (input: AddInput) => { item: FeedbackItem; duplicate: boolean };
  /** The Feedback view: proposals with their evidence, and the decision on one (injected; absent in demo mode). */
  feedbackProposals?: () => unknown[];
  /** Notes still waiting to become a proposal (injected; absent in demo mode). */
  feedbackNotes?: () => FeedbackItem[];
  decideProposal?: (input: { id: unknown; action: unknown; reason?: unknown; by?: unknown }) => unknown;
  /** Called after a task changes so the next dashboard refresh shows it. */
  invalidate: () => void;
}

/** The page's own files. */
const STATIC: Record<string, { name: string; type: string }> = {
  '/styles.css': { name: 'styles.css', type: 'text/css' },
  '/app.js': { name: 'app.js', type: 'text/javascript' },
  '/favicon.svg': { name: 'favicon.svg', type: 'image/svg+xml' },
  '/favicon.ico': { name: 'favicon.svg', type: 'image/svg+xml' },
};

/** Newest change to any of the page's files: an open tab that sees a different number reloads itself. */
async function uiVersion(publicDir: string): Promise<number> {
  const times = await Promise.all(['index.html', 'styles.css', 'app.js'].map((f) => stat(join(publicDir, f)).then((x) => x.mtimeMs, () => 0)));
  return Math.max(0, ...times);
}

/** All of Cockpit's HTTP behaviour, with its dependencies injected so it can be tested without Hermes. */
export function createApp(d: AppDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
      res.end(body);
    };
    const json = (status: number, v: unknown) => send(status, 'application/json', JSON.stringify(v));
    if (d.admin && req.method === 'GET' && !url.pathname.startsWith('/api/') && handleAdminParam(req, res, url, d.admin.token(), d.admin.store)) return;
    const session = d.admin ? adminSession(req, d.admin.token(), d.admin.store) : { ok: false, renew: false };
    if (session.cookie) res.setHeader('set-cookie', session.cookie);   // sliding expiry: using the admin view keeps it alive
    const who: Person = (await d.identify?.(req, session.ok)) ?? ANYONE;
    const forbidden = () => json(403, { error: `${who.name} cannot see that.` });
    try {
      if (url.pathname.startsWith('/api/')) {
        const host = checkHost(req, d.guard);
        if (!host.ok) return json(host.status, { error: host.message });
        // Who may call what: one table (access.ts), deny by default, checked before any body is read or handler runs.
        const access = checkAccess(who, req.method, url.pathname);
        if (!access.ok) {
          // A refused write is worth a line (a refused read is not): who tried what.
          if (req.method === 'POST' && access.status === 403) d.audit?.log({ who: who.name, device: who.device, action: 'denied', target: url.pathname, ok: false, detail: { status: 403 } });
          return json(access.status, { error: access.status === 404 ? 'not found' : access.status === 405 ? 'method not allowed' : `${who.name} cannot ${req.method === 'POST' ? 'do' : 'see'} that.` });
        }
      }

      // ---- writes (guarded: same-origin JSON only, optional token) ----
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        const g = checkWrite(req, d.guard);
        if (!g.ok) return json(g.status, { error: g.message });
        const body = await readJson(req);

        if (url.pathname === '/api/chat') {
          const v = validateChat(body);
          if (!v.ok) return json(400, { error: v.message });
          // Hidden portfolios: a question about one is refused here, and Atlas is told who is asking for anything else.
          if (mentionsHidden(who, v.req.message)) return json(403, { error: `Atlas cannot discuss that portfolio with ${who.name}.` });
          // Private values or topics never go to Atlas' cloud model: the local Personal Privacy agent answers, in code, before Atlas is involved.
          // Checked on the message as written (a share-ok: tag must be at its start); only then is the note for Atlas added.
          if (privacyCheck(v.req.message).private) return await streamPrivate(res, d.privacyAsk, v.req.message);
          if (who.hide.length) v.req = { ...v.req, message: `${hiddenNotice(who)}\n${v.req.message}` };
          const ctl = new AbortController();
          res.on('close', () => ctl.abort()); // closing the tab stops the upstream request
          return await streamChat(d.chat, v.req, res, ctl.signal);
        }

        if (url.pathname === '/api/feedback') {
          if (!d.addFeedback) return json(501, { error: 'feedback is not available here' });
          const text = typeof body.text === 'string' ? body.text : '';
          // Private text is not stored (design §8): refuse it; the words are never kept.
          const pv = privacyCheck(text);
          if (pv.private) return json(422, { error: `This looks private (${pv.reasons.join(', ')}), so it was not saved. Tell the private assistant instead.` });
          const r = d.addFeedback({ text, source: 'cockpit', by: who.name, page: body.page, promote: body.promote === true });
          return json(r.duplicate ? 200 : 201, { id: r.item.id, duplicate: r.duplicate });
        }
        if (url.pathname === '/api/feedback/decide') {
          if (!d.decideProposal) return json(501, { error: 'feedback decisions are not available here' });
          if (who.hide.length) return forbidden();   // a limited view cannot decide
          const proposal = d.decideProposal({ id: body.id, action: body.action, reason: body.reason, by: who.name });
          d.invalidate();   // the Needs-you count changes
          return json(200, { proposal });
        }
        if (url.pathname === '/api/growth/act') {
          const r = growthAct(d.growthRun, body);
          d.invalidate();
          return json(200, { ...r, growth: showGrowth(d.growthRun, String(body.agent === '*' ? 'atlas' : body.agent)) });
        }
        if (url.pathname === '/api/needs/act') {
          // Yes / no on a Needs-you item (owner only, access.ts). The work CLI carries it out and writes the audit line.
          const act = cleanAct(body.act);
          const answer = body.answer === 'yes' ? 'yes' : body.answer === 'no' ? 'no' : '';
          if (!act || !answer) return json(400, { error: 'bad request' });
          const r = await d.work(['act', '--kind', act.kind, ...(act.project ? ['--project', act.project] : []), ...(act.id ? ['--id', act.id] : []), ...(act.refs ? ['--refs', act.refs.join(',')] : []),
            '--answer', answer, '--by', who.name, '--via', 'cockpit', '--apply']);
          if (r.code !== 0) throw new WorkError(r.output.split('\n').filter((l) => l.startsWith('error:')).map((l) => l.slice(7)).join('; ') || 'not done', 422);
          d.invalidate();
          return json(200, { ok: true, output: r.output });
        }
        if (url.pathname === '/api/needs/snooze') {
          if (!d.snooze) return json(501, { error: 'not available here' });
          const key = String(body.key ?? ''), days = Number(body.days);
          if (!/^[a-z-]+:[A-Za-z0-9:_-]{1,120}$/.test(key) || !Number.isFinite(days) || days < 0 || days > 30) return json(400, { error: 'bad request' });
          const until = d.snooze(key, days);
          d.audit?.log({ who: who.name, device: who.device, action: 'needs.snooze', target: key, ok: true, detail: { days } });
          d.invalidate();
          return json(200, { ok: true, until });
        }
        if (url.pathname === '/api/automation/default') {
          const portfolio = String(body.portfolio ?? ''), level = body.level === 'full' ? 'full' : body.level === 'semi' ? 'semi' : '';
          if (!/^[a-z][a-z0-9-]{1,31}$/.test(portfolio) || !level) return json(400, { error: 'bad request' });
          const r = await d.work(['automation', 'default', portfolio, level, '--by', who.name, '--apply']);
          if (r.code !== 0) throw new WorkError(r.output.split('\n').filter((l) => l.startsWith('error:')).map((l) => l.slice(7)).join('; ') || 'not changed', 422);
          return json(200, { ok: true });
        }
        if (url.pathname === '/api/mail/act') {
          // Send or deny an email an agent was not allowed to send by itself. Owner only (access.ts); the work CLI does it, with the same checks.
          const action = body.action === 'release' ? 'release' : body.action === 'deny' ? 'deny' : '';
          const id = String(body.id ?? '');
          if (!action || !/^m-\d{8}-\d{6}-[0-9a-f]{4}$/.test(id)) return json(400, { error: 'bad request' });
          const reason = typeof body.reason === 'string' ? body.reason.replace(/[\r\n]+/g, ' ').slice(0, 300) : '';
          const r = await d.work(['mail', action, id, '--by', who.name, ...(action === 'deny' && reason ? ['--reason', reason] : []), '--apply']);
          d.audit?.log({ who: who.name, device: who.device, action: 'mail.' + action, target: id, ok: r.code === 0, detail: {} });
          if (r.code !== 0) throw new WorkError(r.output.split('\n').filter((l) => l.startsWith('error:')).join('; ') || 'not done', 422);
          d.invalidate();
          return json(200, { ok: true });
        }
        if (url.pathname === '/api/decisions/act') {
          // Only the owner changes the ledger (access.ts), and it is the work CLI that runs, so it gets the same checks as from a terminal.
          const r = await d.work(decisionArgs(body, who.name));
          if (r.code !== 0) throw new WorkError(r.output.split('\n').filter((l) => l.startsWith('error:')).join('; ') || 'the change was refused', 422);
          d.invalidate();
          return json(200, { ok: true, output: r.output });
        }
        if (url.pathname === '/api/agents/doc') {
          if (!d.saveAgentDoc) return json(501, { error: 'editing is not available here' });
          const id = String(body.agent ?? '');
          if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) return json(400, { error: 'bad agent id' });
          const file = String(body.file ?? '');
          const target = `${id}/${file}`;
          const was = d.agentDetail(id);
          const beforeText = !was ? null : file === 'soul' ? was.prompt.text : file === 'memory' ? was.memory.memory.text : file === 'user' ? was.memory.user.text : null;
          const record = (ok: boolean, detail: Record<string, unknown>) => d.audit?.log({ who: who.name, device: who.device, action: 'agents.doc', target, ok, detail });
          // A limited view shows this file with some lines removed. Saving that text back would delete those lines from the real file.
          if (who.hide.length && beforeText !== null && scrubText(who, beforeText) !== beforeText) {
            const reason = 'This file has lines about portfolios you cannot see, so it cannot be edited from your view. Ask Frank.';
            record(false, { reason });
            return json(403, { error: reason });
          }
          let detail: AgentDetail;
          try { detail = d.saveAgentDoc(id, file, body.text, body.base); } catch (e) { if (e instanceof DocError) record(false, { reason: e.message }); throw e; }
          const after = typeof body.text === 'string' ? maskSensitive(body.text) : '';
          const diff = lineDiff(beforeText ?? '', after);
          record(true, { chars: after.length, removed: diff.removed, added: diff.added, diff: diff.text });
          d.invalidate();
          return json(200, detail);
        }
        if (url.pathname === '/api/agents/model') {
          const id = String(body.agent ?? '');
          const to = requestedChain(body).map((m) => `${m.provider}/${m.model}`).join(' › ');
          const was = (await d.getRollup(false).catch(() => undefined))?.agents.find((a) => a.id === id);
          const from = was ? (was.chain?.length ? was.chain : [{ provider: was.provider, model: was.model }]).map((m) => `${m.provider ?? '?'}/${m.model ?? '?'}`).join(' › ') : undefined;
          let r;
          try { r = setAgentModel(d.agentsRun, d.modelsPath, body); } catch (e) { d.audit?.log({ who: who.name, device: who.device, action: 'agents.model', target: id, ok: false, detail: { from, to, reason: (e as Error).message } }); throw e; }
          d.audit?.log({ who: who.name, device: who.device, action: 'agents.model', target: id, ok: true, detail: { from, to } });
          d.invalidate();
          return json(200, { ...r, models: listChoices(d.modelsPath, d.agentsRun) });
        }
        if (!canSee(who, String(body.portfolio ?? '')) || (typeof body.board === 'string' && !canSee(who, d.groupOfBoard?.(body.board) ?? body.board))) return forbidden();
        if (url.pathname.startsWith('/api/projects/') && url.pathname !== '/api/projects/propose' && who.hide.length) {
          const pr = (await listProjects(d.work, String(body.project ?? '')))[0] as { portfolio?: string } | undefined;
          if (pr && !canSee(who, pr.portfolio)) return forbidden();
        }
        if (url.pathname === '/api/projects/propose') {
          const r = await proposeProject(d.work, body);
          d.invalidate();
          return json(201, { ...r, project: (await listProjects(d.work, r.id))[0] });
        }
        if (url.pathname === '/api/projects/open') {
          // Only a folder the project itself lists (its repo and that repo's sub-folders) can be opened; no path comes from the request.
          const proj = (await listProjects(d.work, String(body.project ?? '')))[0] as { folders?: Array<{ name: string; path: string }> } | undefined;
          const f = proj?.folders?.find((x) => x.name === body.folder);
          if (!f) return json(404, { error: 'no such project folder' });
          if (!d.openPath) return json(501, { error: 'opening folders is not available here' });
          d.openPath(f.path);
          return json(200, { opened: f.path });
        }
        if (url.pathname === '/api/projects/act') {
          // Full automation lets work start and finish without anyone approving it: only the owner turns it on. Anyone allowed here may turn it off.
          const wantsFull = (body.action === 'autonomy' && body.level === 'full') || (body.action === 'edit' && body.autonomy === 'full');
          if (wantsFull && roleOf(who) !== 'owner') return forbidden();
          if (body.action === 'autonomy') body.by = who.name;
          const r = await actOnProject(d.work, body);
          d.invalidate();
          let planning: { id: string } | { skipped: string } | undefined;
          if (body.action === 'approve') {
            // Approval is the human gate. What follows is automatic: `work advance` asks pm to plan (a kanban task for the pm
            // profile, which Hermes' dispatcher starts within a minute), and keeps moving the project forward on a timer.
            const adv = await d.work(['advance', '--project', String(body.project), '--apply']);
            const pl = ((await listProjects(d.work, String(body.project)))[0] as { planning?: { id: string } | null } | undefined)?.planning;
            planning = pl?.id ? { id: pl.id } : { skipped: adv.output.split('\n').find((l) => l.includes('▲')) ?? 'no planning task could be created' };
          }
          const one = (await listProjects(d.work, String(body.project)))[0];
          return json(200, { ...r, planning, project: one });
        }

        const rollup = await d.getRollup(false);
        const deps: TaskDeps = {
          ...d.tasks,
          assignable: () => rollup.agents.filter((a) => a.state === 'active').map((a) => a.profile),
        };
        if (url.pathname === '/api/tasks') {
          const made = await createTask(deps, body);
          d.invalidate();
          // An unowned task gets its staffing check straight away, so the form can show who should take it.
          const team = rollup.agents.map((a) => ({ id: a.id, name: a.name, role: a.role, profile: a.profile, state: a.state, portfolios: a.portfolios, allPortfolios: a.allPortfolios, personaSlug: a.personaSlug, division: a.division }));
          const staffing = made.assignee ? null : evaluateStaffing({ title: made.title, body: String(body.body ?? ''), portfolio: String(body.portfolio) }, team, d.catalog());
          return json(201, { task: made, staffing });
        }
        if (url.pathname === '/api/tasks/assign') {
          const r = await assignTask(deps, body);
          // the reason goes next to how the task turns out (work scorecard); a person who gives none is recorded as such
          const why = typeof body.why === 'string' ? body.why.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
          d.recordStaffing?.({ at: new Date().toISOString(), board: d.tasks.boardFor(String(body.portfolio ?? '')) ?? '', task: r.id, agent: r.assignee, by: who.name, why: why || '(chosen in Cockpit, no reason given)' });
          d.invalidate();
          return json(200, r);
        }
        return json(404, { error: 'not found' });
      }

      if (req.method !== 'GET') return send(405, 'text/plain', 'method not allowed');
      switch (url.pathname) {
        case '/':
          // Scripts load only from this server (no inline script, nothing third-party): text from agents or Hermes that slipped past
          // escaping could not run. Styles are not restricted (the page uses style attributes).
          res.setHeader('content-security-policy', "script-src 'self'; object-src 'none'; base-uri 'none'");
          res.setHeader('x-content-type-options', 'nosniff');
          return send(200, 'text/html', await readFile(join(d.publicDir, 'index.html'), 'utf8'));
        case '/styles.css':
        case '/app.js':
        case '/favicon.svg':
        case '/favicon.ico': {
          // A fixed list of files, never a path taken from the request.
          const file = STATIC[url.pathname];
          res.setHeader('x-content-type-options', 'nosniff');
          return send(200, file.type, await readFile(join(d.publicDir, file.name), 'utf8'));
        }
        case '/healthz':
          return send(200, 'text/plain', 'ok');
        case '/api/me':
          return json(200, { name: who.name, device: who.device, restricted: who.hide.length > 0, admin: who.admin === true });
        case '/api/rollup':
          // uiVersion: when the page's own file changes, an open tab reloads itself (otherwise it keeps running the old script)
          return json(200, { ...redactRollup(await d.getRollup(url.searchParams.has('fresh')), who), uiVersion: await uiVersion(d.publicDir) });
        case '/api/feedback':
          if (!d.feedbackProposals) return json(200, { proposals: [] });
          return json(200, { proposals: who.hide.length ? [] : d.feedbackProposals(), notes: who.hide.length || !d.feedbackNotes ? [] : d.feedbackNotes().filter((n) => n.status === 'open').map((n) => ({ id: n.id, time: n.time, by: n.by, source: n.source, text: n.text, page: n.page, repeats: n.repeats ?? 0, promote: n.promote === true })) });
        case '/api/models':
          return json(200, { lanes: loadLanes(d.modelsPath), models: listChoices(d.modelsPath, d.agentsRun) });
        case '/api/repos':
          return json(200, ((await listRepos(d.work)) as Array<{ portfolio?: string }>).filter((r) => canSee(who, r.portfolio)));
        case '/api/projects':
          return json(200, ((await listProjects(d.work)) as Array<{ portfolio?: string }>).filter((p) => canSee(who, p.portfolio)));
        case '/api/working': {
          const w = d.working?.();
          if (!w) return json(200, { none: true });
          // only what this person may see; the count of waiting tasks is dropped for a limited view rather than guessed
          const items = w.items.filter((x) => canSee(who, x.portfolio));
          return json(200, { now: w.now, items, waiting: items.length === w.items.length ? w.waiting : 0 });
        }
        case '/api/workload': {
          // Per portfolio, so a person who may not see a portfolio gets neither its numbers nor a hint that it is busy.
          const w = d.workload?.();
          if (!w) return json(200, { none: true });
          return json(200, { ...w, groups: Object.fromEntries(Object.entries(w.groups).filter(([g]) => canSee(who, g))) });
        }
        case '/api/task/search': {
          const boards = (d.boardSlugs?.() ?? []).filter((b) => canSee(who, d.groupOfBoard?.(b) ?? b));
          return json(200, await searchTasks(d.tasks.run, boards, (url.searchParams.get('q') ?? '').trim().slice(0, 80)));
        }
        case '/api/task/find': {
          // Only boards this person may see are searched, so a hidden portfolio's task id looks the same as an unknown id.
          const boards = (d.boardSlugs?.() ?? []).filter((b) => canSee(who, d.groupOfBoard?.(b) ?? b));
          return json(200, await findTask(d.tasks.run, boards, (url.searchParams.get('id') ?? '').trim()));
        }
        case '/api/task':
          if (!canSee(who, d.groupOfBoard?.(url.searchParams.get('board') ?? '') ?? url.searchParams.get('board'))) return forbidden();
          return json(200, await showTask(d.tasks.run, url.searchParams.get('board') ?? '', url.searchParams.get('id') ?? ''));
        case '/api/sessions': {
          if (!d.sessions) return json(200, { sessions: [], total: 0, profiles: [], sources: [] });
          const sp = url.searchParams;
          return json(200, d.sessions.list({ profile: sp.get('profile') ?? undefined, source: sp.get('source') ?? undefined, q: sp.get('q') ?? undefined, offset: Number(sp.get('offset') ?? 0) || 0, limit: Number(sp.get('limit') ?? 40) || 40 }));
        }
        case '/api/session': {
          const id = url.searchParams.get('id') ?? '';
          if (!/^[A-Za-z0-9._:-]{4,160}$/.test(id)) return json(400, { error: 'bad session id' });
          const got = d.sessions?.get(id, { offset: Number(url.searchParams.get('offset') ?? 0) || 0, limit: Number(url.searchParams.get('limit') ?? 80) || 80 });
          return got ? json(200, got) : json(404, { error: 'no such conversation (or it is not one Cockpit shows)' });
        }
        case '/api/scorecard': {
          // Numbers per agent for everyone allowed in; the latest choices (task titles) only for the owner
          const days = [7, 14, 28].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 14;
          if (!d.scorecard) return json(200, { agents: [], deciders: [], days });
          const s = await d.scorecard(days) as { agents: unknown[]; deciders: Array<Record<string, unknown>>; days: number };
          return json(200, roleOf(who) === 'owner' ? s : { ...s, deciders: s.deciders.map(({ recent: _r, ...x }) => x) });
        }
        case '/api/automation': {
          // The level new projects start with, per portfolio (only the ones this viewer may see)
          const r = await d.work(['automation', 'show', '--json']);
          let all: Record<string, string> = {};
          try { all = JSON.parse(r.output.split('\n').find((l) => l.startsWith('{')) ?? '{}') as Record<string, string>; } catch { /* none */ }
          return json(200, { defaults: Object.fromEntries(Object.entries(all).filter(([p]) => canSee(who, p))) });
        }
        case '/api/decisions': {
          if (!d.decisionsKb) return json(200, { decisions: [], total: 0, counts: {} });
          const sp = url.searchParams;
          const status = sp.get('status'), project = sp.get('project') ?? undefined, portfolio = sp.get('portfolio') ?? undefined, q = (sp.get('q') ?? '').toLowerCase().trim();
          if (status && status !== 'all' && status !== 'question' && !(STATUSES as string[]).includes(status)) return json(400, { error: 'bad status' });
          // Everything the viewer may see: hidden portfolios are gone, and so is any decision that talks about one (the rule chat uses).
          const visible = readDecisions(d.decisionsKb, { portfolio, project, includeLegacy: !project }).filter((x) => canSee(who, x.portfolio) && !mentionsHidden(who, `${x.title} ${x.why}`));
          const bucket = (x: { kind: string; status: string }) => (x.kind === 'question' && x.status === 'active' ? 'question' : x.status);
          const counts: Record<string, number> = {};
          for (const x of visible) counts[bucket(x)] = (counts[bucket(x)] ?? 0) + 1;
          const shown = visible.filter((x) => (!status || status === 'all' || bucket(x) === status) && (!q || `${x.title} ${x.why} ${x.by} ${x.scope}`.toLowerCase().includes(q)));
          const limit = Math.max(1, Math.min(500, Number(sp.get('limit') ?? 200) || 200));
          // `board` lets the page open the task a decision came from.
          return json(200, { decisions: shown.slice(0, limit).map((x) => ({ ...x, board: d.tasks.boardFor(x.portfolio) ?? null })), total: shown.length, counts });
        }
        case '/api/version':
          return json(200, (await d.version?.()) ?? { env: 'dev', branch: null, loadedSha: null, headSha: null, dirty: false, startedAt: null, restartPending: false });
        case '/api/audit':
          return json(200, { entries: d.audit?.read(Number(url.searchParams.get('limit') ?? 100)) ?? [] });
        case '/api/portfolio':
          if (!canSee(who, 'family')) return forbidden();
          return json(200, d.portfolio?.() ?? { state: 'unavailable', message: 'Portfolio panel is not configured.', currency: 'AUD', byMarket: [], topPositions: [], warnings: [] });
        case '/api/brief':
          return send(200, 'text/markdown', buildBrief(redactRollup(await d.getRollup(false), who)));
        case '/api/history':
          return json(200, d.history(Number(url.searchParams.get('days') ?? 30)));
        default: {
          const g = url.pathname.match(GROWTH_PATH);
          if (g) return json(200, scrubDeep(who, showGrowth(d.growthRun, g[1])));
          const m = url.pathname.match(AGENT_PATH);
          if (m) {
            const detail = d.agentDetail(m[1]);
            if (!detail) return json(404, { error: 'no such agent profile' });
            if (who.hide.length) { detail.prompt.text = scrubText(who, detail.prompt.text); detail.memory.memory.text = scrubText(who, detail.memory.memory.text); detail.memory.user.text = scrubText(who, detail.memory.user.text); for (const k of detail.skills.items) k.description = blurTopics(who, k.description); }
            return json(200, detail);
          }
          return send(404, 'text/plain', 'not found');
        }
      }
    } catch (e) {
      if (e instanceof BodyError || e instanceof TaskError || e instanceof WorkError || e instanceof DocError || e instanceof FeedbackError) return json(e.status, { error: e.message });
      console.error(e);
      send(500, 'text/plain', 'internal error');
    }
  };
}
