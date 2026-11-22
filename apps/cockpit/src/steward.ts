import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProject, stewardOf } from '../../../packages/work/model.ts';

/** Does this project have someone to settle agents' proposals and questions (an approver agent or a project manager on the team)? A portfolio-wide entry has none. */
export function hasSteward(kb: string, portfolio: string, scope: string): boolean {
  if (scope === '_portfolio') return false;
  try { return !!stewardOf(parseProject(readFileSync(join(kb, portfolio, 'projects', `${scope}.md`), 'utf8')).project); } catch { return false; }
}
