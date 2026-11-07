import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildBrief } from './brief.ts';
import { streamChat, streamPrivate, validateChat, type ChatOptions } from './chat.ts';
import { privacyCheck } from '../../../packages/redact/topics.ts';
import { BodyError, checkHost, checkWrite, readJson, type GuardOptions } from './security.ts';
import { assignTask, createTask, showTask, TaskError, type TaskDeps } from './tasks.ts';
import { evaluateStaffing } from '../../../packages/roster/staffing.ts';
import type { CatalogEntry } from '../../../packages/roster/catalog.ts';
import { DocError, type AgentDetail } from './sources/agentDetail.ts';
import { ANYONE, type Person } from './identity.ts';
import { adminSession, handleAdminParam, type AdminStore } from './admin.ts';
import { blurTopics, canSee, hiddenNotice, mentionsHidden, redactRollup, scrubDeep, scrubText } from './visibility.ts';
import type { Rollup } from './types.ts';
import { listChoices, loadLanes, setAgentModel, type AgentsRun } from './agentsApi.ts';
import { growthAct, showGrowth, type GrowthRun } from './growthApi.ts';
import { FeedbackError, type AddInput, type FeedbackItem } from '../../../packages/work/feedback.ts';
import { WorkError, actOnProject, listProjects, listRepos, proposeProject, type WorkRun } from './work.ts';

export interface AppDeps {
  publicDir: string;
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
  identify?: (req: import('node:http').IncomingMessage, admin: boolean) => Person;
  /** The Admin view (?admin=<secret>): where the secret comes from and where its last use is kept; absent = no admin view. */
  admin?: { token: () => string | undefined; store: AdminStore };
  /** Which portfolio (group) a kanban board belongs to. */
  groupOfBoard?: (board: string) => string | undefined;
  /** Opens a folder in Finder on this Mac (injected; absent in tests and demo mode). */
  openPath?: (path: string) => void;
  /** Records one feedback item (injected; absent in demo mode). The caller stamps source and who. */
  addFeedback?: (input: AddInput) => { item: FeedbackItem; duplicate: boolean };
  /** The Feedback view: proposals with their evidence, and the decision on one (injected; absent in demo mode). */
  feedbackProposals?: () => unknown[];
  decideProposal?: (input: { id: unknown; action: unknown; reason?: unknown; by?: unknown }) => unknown;
  /** Called after a task changes so the next dashboard refresh shows it. */
  invalidate: () => void;
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
    const who: Person = d.identify?.(req, session.ok) ?? ANYONE;
    const forbidden = () => json(403, { error: `${who.name} cannot see that.` });
    try {
      if (url.pathname.startsWith('/api/')) {
        const host = checkHost(req, d.guard);
        if (!host.ok) return json(host.status, { error: host.message });
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
          if (who.hide.length) v.req = { ...v.req, message: `${hiddenNotice(who)}\n${v.req.message}` };
          // Private values or topics never go to Atlas' cloud model: the local Personal Privacy agent answers, in code, before Atlas is involved.
          if (privacyCheck(v.req.message).private) return await streamPrivate(res, d.privacyAsk, v.req.message);
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
          const r = d.addFeedback({ text, source: 'cockpit', by: who.name, page: body.page });
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
        if (url.pathname === '/api/agents/doc') {
          if (!d.saveAgentDoc) return json(501, { error: 'editing is not available here' });
          const id = String(body.agent ?? '');
          if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) return json(400, { error: 'bad agent id' });
          const detail = d.saveAgentDoc(id, String(body.file ?? ''), body.text, body.base);
          d.invalidate();
          return json(200, detail);
        }
        if (url.pathname === '/api/agents/model') {
          const r = setAgentModel(d.agentsRun, d.modelsPath, body);
          d.invalidate();
          return json(200, { ...r, models: listChoices(d.modelsPath, d.agentsRun) });
        }
        if (!canSee(who, String(body.portfolio ?? '')) || (typeof body.board === 'string' && !canSee(who, d.groupOfBoard?.(body.board) ?? body.board))) return forbidden();
        if (url.pathname.startsWith('/api/projects/') && url.pathname !== '/api/projects/propose' && who.hide.length) {
          const pr = listProjects(d.work, String(body.project ?? ''))[0] as { portfolio?: string } | undefined;
          if (pr && !canSee(who, pr.portfolio)) return forbidden();
        }
        if (url.pathname === '/api/projects/propose') {
          const r = proposeProject(d.work, body);
          d.invalidate();
          return json(201, { ...r, project: listProjects(d.work, r.id)[0] });
        }
        if (url.pathname === '/api/projects/open') {
          // Only a folder the project itself lists (its repo and that repo's sub-folders) can be opened; no path comes from the request.
          const proj = listProjects(d.work, String(body.project ?? ''))[0] as { folders?: Array<{ name: string; path: string }> } | undefined;
          const f = proj?.folders?.find((x) => x.name === body.folder);
          if (!f) return json(404, { error: 'no such project folder' });
          if (!d.openPath) return json(501, { error: 'opening folders is not available here' });
          d.openPath(f.path);
          return json(200, { opened: f.path });
        }
        if (url.pathname === '/api/projects/act') {
          const r = actOnProject(d.work, body);
          d.invalidate();
          let planning: { id: string } | { skipped: string } | undefined;
          if (body.action === 'approve') {
            // Approval is the human gate. What follows is automatic: `work advance` asks pm to plan (a kanban task for the pm
            // profile, which Hermes' dispatcher starts within a minute), and keeps moving the project forward on a timer.
            const adv = d.work(['advance', '--project', String(body.project), '--apply']);
            const pl = (listProjects(d.work, String(body.project))[0] as { planning?: { id: string } | null } | undefined)?.planning;
            planning = pl?.id ? { id: pl.id } : { skipped: adv.output.split('\n').find((l) => l.includes('▲')) ?? 'no planning task could be created' };
          }
          const one = listProjects(d.work, String(body.project))[0];
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
          d.invalidate();
          return json(200, r);
        }
        return json(404, { error: 'not found' });
      }

      if (req.method !== 'GET') return send(405, 'text/plain', 'method not allowed');
      switch (url.pathname) {
        case '/':
          return send(200, 'text/html', await readFile(join(d.publicDir, 'index.html'), 'utf8'));
        case '/favicon.svg':
        case '/favicon.ico':
          return send(200, 'image/svg+xml', await readFile(join(d.publicDir, 'favicon.svg'), 'utf8'));
        case '/healthz':
          return send(200, 'text/plain', 'ok');
        case '/api/me':
          return json(200, { name: who.name, device: who.device, restricted: who.hide.length > 0, admin: who.admin === true });
        case '/api/rollup':
          return json(200, redactRollup(await d.getRollup(url.searchParams.has('fresh')), who));
        case '/api/feedback':
          if (!d.feedbackProposals) return json(200, { proposals: [] });
          return json(200, { proposals: who.hide.length ? [] : d.feedbackProposals() });
        case '/api/models':
          return json(200, { lanes: loadLanes(d.modelsPath), models: listChoices(d.modelsPath, d.agentsRun) });
        case '/api/repos':
          return json(200, (listRepos(d.work) as Array<{ portfolio?: string }>).filter((r) => canSee(who, r.portfolio)));
        case '/api/projects':
          return json(200, (listProjects(d.work) as Array<{ portfolio?: string }>).filter((p) => canSee(who, p.portfolio)));
        case '/api/task':
          if (!canSee(who, d.groupOfBoard?.(url.searchParams.get('board') ?? '') ?? url.searchParams.get('board'))) return forbidden();
          return json(200, await showTask(d.tasks.run, url.searchParams.get('board') ?? '', url.searchParams.get('id') ?? ''));
        case '/api/brief':
          return send(200, 'text/markdown', buildBrief(redactRollup(await d.getRollup(false), who)));
        case '/api/history':
          return json(200, d.history(Number(url.searchParams.get('days') ?? 30)));
        default: {
          const g = url.pathname.match(/^\/api\/agents\/([a-z0-9-]{1,32})\/growth$/);
          if (g) return json(200, scrubDeep(who, showGrowth(d.growthRun, g[1])));
          const m = url.pathname.match(/^\/api\/agents\/([a-z0-9-]{1,32})$/);
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
