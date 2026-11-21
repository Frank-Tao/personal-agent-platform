import type { Person } from './identity.ts';

// Who may call which /api route. One table, checked once before any handler runs, and deny by default: a route that is not listed
// here does not exist. Portfolio visibility (Diane never sees Investments) is a separate, finer check inside the handlers.
//
//   guest   an unknown device: the redacted dashboard only, no writes
//   member  a known person with a restricted view (Diane): reads, chat, tasks, projects, feedback
//   owner   Frank and the Admin view: also growth actions, feedback decisions and the audit log
//   Changing an agent's prompt, memory or model is open to a member (Frank's decision, 15 Nov) and is written to the audit log, data/audit.jsonl.

export type Role = 'guest' | 'member' | 'owner';
const RANK: Record<Role, number> = { guest: 0, member: 1, owner: 2 };

export const roleOf = (who: Pick<Person, 'hide' | 'guest'>): Role => (who.guest ? 'guest' : who.hide.length ? 'member' : 'owner');

interface Rule { method: 'GET' | 'POST'; path: string | RegExp; role: Role }

export const AGENT_PATH = /^\/api\/agents\/([a-z0-9-]{1,32})$/;
export const GROWTH_PATH = /^\/api\/agents\/([a-z0-9-]{1,32})\/growth$/;

export const ROUTES: readonly Rule[] = [
  { method: 'GET', path: '/api/me', role: 'guest' },
  { method: 'GET', path: '/api/rollup', role: 'guest' },
  { method: 'GET', path: '/api/brief', role: 'guest' },
  { method: 'GET', path: '/api/feedback', role: 'member' },
  { method: 'GET', path: '/api/models', role: 'member' },
  { method: 'GET', path: '/api/repos', role: 'member' },
  { method: 'GET', path: '/api/projects', role: 'member' },
  { method: 'GET', path: '/api/task', role: 'member' },
  { method: 'GET', path: '/api/history', role: 'member' },
  { method: 'GET', path: '/api/portfolio', role: 'member' },
  { method: 'GET', path: '/api/audit', role: 'owner' },
  { method: 'GET', path: '/api/decisions', role: 'member' },
  { method: 'GET', path: '/api/sessions', role: 'owner' },
  { method: 'GET', path: '/api/session', role: 'owner' },
  { method: 'GET', path: '/api/version', role: 'member' },
  { method: 'GET', path: AGENT_PATH, role: 'member' },
  { method: 'GET', path: GROWTH_PATH, role: 'member' },

  { method: 'POST', path: '/api/chat', role: 'member' },
  { method: 'POST', path: '/api/feedback', role: 'member' },
  { method: 'POST', path: '/api/tasks', role: 'member' },
  { method: 'POST', path: '/api/tasks/assign', role: 'member' },
  { method: 'POST', path: '/api/projects/propose', role: 'member' },
  { method: 'POST', path: '/api/projects/open', role: 'member' },
  { method: 'POST', path: '/api/projects/act', role: 'member' },
  { method: 'POST', path: '/api/feedback/decide', role: 'owner' },
  { method: 'POST', path: '/api/decisions/act', role: 'owner' },
  { method: 'POST', path: '/api/mail/act', role: 'owner' },
  { method: 'POST', path: '/api/needs/act', role: 'owner' },
  { method: 'POST', path: '/api/needs/snooze', role: 'owner' },
  { method: 'POST', path: '/api/automation/default', role: 'owner' },
  { method: 'GET', path: '/api/automation', role: 'member' },
  { method: 'GET', path: '/api/scorecard', role: 'member' },
  { method: 'POST', path: '/api/growth/act', role: 'owner' },
  { method: 'POST', path: '/api/agents/doc', role: 'member' },
  { method: 'POST', path: '/api/agents/model', role: 'member' },
];

export type Access = { ok: true } | { ok: false; status: 403 | 404 | 405 };

/** 404 = no such route, 405 = the route exists under another method, 403 = this person's role is too low. */
export function checkAccess(who: Pick<Person, 'hide' | 'guest'>, method: string | undefined, path: string): Access {
  const hits = ROUTES.filter((r) => (typeof r.path === 'string' ? r.path === path : r.path.test(path)));
  if (!hits.length) return { ok: false, status: 404 };
  const rule = hits.find((r) => r.method === method);
  if (!rule) return { ok: false, status: 405 };
  return RANK[roleOf(who)] >= RANK[rule.role] ? { ok: true } : { ok: false, status: 403 };
}
