import { readFileSync } from 'node:fs';
import { main as agentsMain } from '../../../agents/cli.ts';
import { WorkError } from './work.ts';

// Switching an agent's model from Cockpit. Cockpit never edits profiles itself: it runs `agents set`, which updates the roster
// and the live Hermes profile. Only (provider, model) pairs listed in config/models.json are accepted, and the Personal Privacy
// agent may only be given a model that runs on this Mac.

export interface ModelChoice { lane?: string; provider: string; model: string; label: string; billing: string; private: boolean; status?: 'ok' | 'rate-limited'; note?: string }
export type AgentsRun = (argv: string[]) => { code: number; output: string };

export function defaultAgentsRun(env: NodeJS.ProcessEnv = process.env): AgentsRun {
  return (argv) => {
    const lines: string[] = [];
    const code = agentsMain(argv, env, (s) => lines.push(s));
    return { code, output: lines.join('\n') };
  };
}

export function loadChoices(path: string): ModelChoice[] {
  try { return (JSON.parse(readFileSync(path, 'utf8')).choices ?? []) as ModelChoice[]; } catch { return []; }
}

/** The catalog plus live rate-limit status per provider (from `agents models --json`). */
export function loadLanes(path: string): Array<{ id: string; label: string }> {
  try { return JSON.parse(readFileSync(path, 'utf8')).lanes ?? []; } catch { return []; }
}

export function listChoices(path: string, run: AgentsRun): ModelChoice[] {
  const choices = loadChoices(path);
  let live: Array<{ provider: string; status: 'ok' | 'rate-limited'; note: string }> = [];
  try { const r = run(['models', '--json']); const j = r.output.slice(r.output.indexOf('[')); live = JSON.parse(j); } catch { /* status unknown */ }
  return choices.map((c) => { const l = live.find((x) => x.provider === c.provider && x.status === 'rate-limited'); return l ? { ...c, status: 'rate-limited', note: l.note } : { ...c, status: 'ok' }; });
}

export function setAgentModel(run: AgentsRun, choicesPath: string, body: Record<string, unknown>): { ok: true; output: string } {
  const id = typeof body.agent === 'string' ? body.agent : '';
  if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new WorkError('bad agent id');
  const provider = typeof body.provider === 'string' ? body.provider : '', model = typeof body.model === 'string' ? body.model : '';
  const choice = loadChoices(choicesPath).find((c) => c.provider === provider && c.model === model);
  if (!choice) throw new WorkError('that model is not in config/models.json');
  if (id === 'personal' && !choice.private) throw new WorkError('the Personal Privacy agent may only use a model that runs on this Mac', 422);
  const r = run(['set', id, '--model', model, '--provider', provider, ...(choice.lane ? ['--add-lane', choice.lane] : []), '--apply']);
  if (r.code !== 0) throw new WorkError(r.output.split('\n').filter((l) => l.startsWith('error:')).join('; ') || 'the change was refused', 422);
  return { ok: true, output: r.output };
}
