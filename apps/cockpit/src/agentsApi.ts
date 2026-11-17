import { readFileSync } from 'node:fs';
import { main as agentsMain } from '../../../agents/cli.ts';
import { chainProblem } from '../../../packages/roster/roster.ts';
import { WorkError } from './work.ts';

// Switching an agent's model from Cockpit. Cockpit never edits profiles itself: it runs `agents set`, which updates the roster
// and the live Hermes profile. Only (provider, model) pairs listed in config/models.json are accepted, and the Personal Privacy
// agent may only be given a model that runs on this Mac.

export interface ModelChoice { lane?: string; base_url?: string; provider: string; model: string; label: string; billing: string; private: boolean; status?: 'ok' | 'rate-limited'; note?: string }
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

/** The ordered models from a request: `models: [{provider, model}, …]` (first choice, second choice, fallback), or the older single provider + model. */
export function requestedChain(body: Record<string, unknown>): Array<{ provider: string; model: string }> {
  if (Array.isArray(body.models)) return body.models.map((m) => ({ provider: String((m as Record<string, unknown>)?.provider ?? ''), model: String((m as Record<string, unknown>)?.model ?? '') }));
  return [{ provider: typeof body.provider === 'string' ? body.provider : '', model: typeof body.model === 'string' ? body.model : '' }];
}

/**
 * Set an agent's models, in order: first choice, second choice, fallback (one to three). Only models in config/models.json are accepted, each at most
 * once, and the Personal Privacy agent may only use models that run on this Mac, as a fallback too (a fallback would otherwise send its private text to a
 * cloud model the first time the local one failed). A single provider + model sets the first choice and keeps the fallbacks.
 */
export function setAgentModel(run: AgentsRun, choicesPath: string, body: Record<string, unknown>): { ok: true; output: string } {
  const id = typeof body.agent === 'string' ? body.agent : '';
  if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new WorkError('bad agent id');
  const wanted = requestedChain(body);
  const catalog = loadChoices(choicesPath);
  const chosen = wanted.map((w) => catalog.find((c) => c.provider === w.provider && c.model === w.model));
  const missing = wanted.findIndex((_, i) => !chosen[i]);
  if (missing !== -1) throw new WorkError(`${wanted[missing].model || 'that model'} is not in config/models.json`);
  const problem = chainProblem(wanted, (m) => (id === 'personal' && !catalog.find((c) => c.provider === m.provider && c.model === m.model)?.private ? 'the Personal Privacy agent may only use models that run on this Mac, as a fallback too' : null));
  if (problem) throw new WorkError(problem, 422);
  const picks = chosen as ModelChoice[];
  const lanes = [...new Set(picks.map((c) => c.lane).filter((l): l is string => !!l))];
  const args = Array.isArray(body.models)
    ? ['set', id, '--chain', JSON.stringify(picks.map((c) => ({ provider: c.provider, model: c.model, ...(c.base_url ? { base_url: c.base_url } : {}) })))]
    : ['set', id, '--model', picks[0].model, '--provider', picks[0].provider];
  const r = run([...args, ...(lanes.length ? ['--add-lanes', lanes.join(',')] : []), '--apply']);
  if (r.code !== 0) throw new WorkError(r.output.split('\n').filter((l) => l.startsWith('error:')).join('; ') || 'the change was refused', 422);
  return { ok: true, output: r.output };
}
