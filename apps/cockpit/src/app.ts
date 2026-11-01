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
import type { AgentDetail } from './sources/agentDetail.ts';
import type { Rollup } from './types.ts';
import { listChoices, loadLanes, setAgentModel, type AgentsRun } from './agentsApi.ts';
import { growthAct, showGrowth, type GrowthRun } from './growthApi.ts';
import { WorkError, actOnProject, listProjects, listRepos, proposeProject, type WorkRun } from './work.ts';

export interface AppDeps {
  publicDir: string;
  guard: GuardOptions;
  chat: ChatOptions;
  tasks: Omit<TaskDeps, 'assignable'>;
  getRollup: (fresh: boolean) => Promise<Rollup>;
  history: (days: number) => unknown;
  agentDetail: (id: string) => AgentDetail | null;
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
          // Private values or topics never go to Atlas' cloud model: the local Personal Privacy agent answers, in code, before Atlas is involved.
          if (privacyCheck(v.req.message).private) return await streamPrivate(res, d.privacyAsk, v.req.message);
          const ctl = new AbortController();
          res.on('close', () => ctl.abort()); // closing the tab stops the upstream request
          return await streamChat(d.chat, v.req, res, ctl.signal);
        }

        if (url.pathname === '/api/growth/act') {
          const r = growthAct(d.growthRun, body);
          d.invalidate();
          return json(200, { ...r, growth: showGrowth(d.growthRun, String(body.agent === '*' ? 'atlas' : body.agent)) });
        }
        if (url.pathname === '/api/agents/model') {
          const r = setAgentModel(d.agentsRun, d.modelsPath, body);
          d.invalidate();
          return json(200, { ...r, models: listChoices(d.modelsPath, d.agentsRun) });
        }
        if (url.pathname === '/api/projects/propose') {
          const r = proposeProject(d.work, body);
          d.invalidate();
          return json(201, { ...r, project: listProjects(d.work, r.id)[0] });
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
        case '/healthz':
          return send(200, 'text/plain', 'ok');
        case '/api/rollup':
          return json(200, await d.getRollup(url.searchParams.has('fresh')));
        case '/api/models':
          return json(200, { lanes: loadLanes(d.modelsPath), models: listChoices(d.modelsPath, d.agentsRun) });
        case '/api/repos':
          return json(200, listRepos(d.work));
        case '/api/projects':
          return json(200, listProjects(d.work));
        case '/api/task':
          return json(200, await showTask(d.tasks.run, url.searchParams.get('board') ?? '', url.searchParams.get('id') ?? ''));
        case '/api/brief':
          return send(200, 'text/markdown', buildBrief(await d.getRollup(false)));
        case '/api/history':
          return json(200, d.history(Number(url.searchParams.get('days') ?? 30)));
        default: {
          const g = url.pathname.match(/^\/api\/agents\/([a-z0-9-]{1,32})\/growth$/);
          if (g) return json(200, showGrowth(d.growthRun, g[1]));
          const m = url.pathname.match(/^\/api\/agents\/([a-z0-9-]{1,32})$/);
          if (m) {
            const detail = d.agentDetail(m[1]);
            return detail ? json(200, detail) : json(404, { error: 'no such agent profile' });
          }
          return send(404, 'text/plain', 'not found');
        }
      }
    } catch (e) {
      if (e instanceof BodyError || e instanceof TaskError || e instanceof WorkError) return json(e.status, { error: e.message });
      console.error(e);
      send(500, 'text/plain', 'internal error');
    }
  };
}
