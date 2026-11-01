import { main as growthMain } from '../../../growth/cli.ts';
import { WorkError } from './work.ts';

// Cockpit's window onto agent growth. Reads run `growth show`; the few things a person can change here (correct, retract, add what
// the agent should know, retire a lesson) run fixed `growth` commands, so the same rules apply as for the agents themselves.

export type GrowthRun = (argv: string[]) => { code: number; output: string };

export function defaultGrowthRun(env: NodeJS.ProcessEnv = process.env): GrowthRun {
  return (argv) => {
    const lines: string[] = [];
    const code = growthMain(argv, env, (s) => lines.push(s));
    return { code, output: lines.join('\n') };
  };
}

const AGENT = /^[a-z0-9-]{1,32}$/, ABOUT = /^a-[0-9a-f]{6}$/, LESSON = /^l-\d{8}-[a-z0-9-]{1,48}$/;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function showGrowth(run: GrowthRun, agent: string): unknown {
  if (!AGENT.test(agent)) throw new WorkError('bad agent id');
  const r = run(['show', agent]);
  const line = r.output.split('\n').find((l) => l.startsWith('{'));
  if (r.code !== 0 || !line) throw new WorkError(r.output.split('\n').find((l) => l.startsWith('error:'))?.slice(7) || 'could not read growth records', 404);
  return JSON.parse(line);
}

export function growthArgs(body: Record<string, unknown>): string[] {
  const agent = str(body.agent, 32), action = str(body.action, 20), id = str(body.id, 80);
  if (!AGENT.test(agent) && agent !== '*') throw new WorkError('bad agent id');
  switch (action) {
    case 'about-add': {
      const text = str(body.text, 240); if (!text) throw new WorkError('say what the agent should know');
      const kind = ['preference', 'constraint', 'workflow', 'decision-rule'].includes(str(body.kind, 20)) ? str(body.kind, 20) : 'preference';
      return ['about', 'add', agent, '--text', text, '--kind', kind, '--source', 'user-said', '--ref', 'cockpit', '--apply'];
    }
    case 'about-correct': { const text = str(body.text, 240); if (!ABOUT.test(id) || !text) throw new WorkError('bad entry or text'); return ['about', 'correct', id, '--text', text, '--apply']; }
    case 'about-retract': if (!ABOUT.test(id)) throw new WorkError('bad entry'); return ['about', 'retract', id, '--apply'];
    case 'about-confirm': if (!ABOUT.test(id)) throw new WorkError('bad entry'); return ['about', 'observe', id, 'support', '--ref', 'cockpit', '--apply'];
    case 'lesson-retire': { if (!LESSON.test(id)) throw new WorkError('bad lesson'); const why = str(body.reason, 200) || 'retired by owner in Cockpit'; return ['lesson', 'retire', id, '--reason', why, '--apply']; }
    default: throw new WorkError('unknown action');
  }
}

export function growthAct(run: GrowthRun, body: Record<string, unknown>): { ok: true; output: string } {
  const r = run(growthArgs(body));
  if (r.code !== 0) throw new WorkError(r.output.split('\n').find((l) => l.startsWith('error:'))?.slice(7) || 'the change was refused', 422);
  return { ok: true, output: r.output };
}
