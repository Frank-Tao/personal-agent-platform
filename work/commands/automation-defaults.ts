import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { liveConfig } from '../../packages/paths/paths.ts';
import { AUTONOMY, type Autonomy } from '../../packages/work/model.ts';
import { insideAgent } from '../../packages/mail/mail.ts';
import { PORTFOLIOS, flag, type Ctx } from '../shared.ts';
import { noteDecision } from './decisions.ts';

// The automation level a NEW project in a portfolio starts with (<data>/config/automation.json: { "defaults": { "research": "full" } }).
// A project can still be switched either way afterwards; this only saves setting it each time.

export const automationPath = (c: Ctx) => c.env.AUTOMATION_CONFIG ?? liveConfig('automation.json', c.env);

export function portfolioDefaults(c: Ctx): Record<string, Autonomy> {
  try {
    const j = JSON.parse(readFileSync(automationPath(c), 'utf8')) as { defaults?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(j.defaults ?? {}).filter(([p, v]) => PORTFOLIOS.includes(p) && AUTONOMY.includes(v as Autonomy))) as Record<string, Autonomy>;
  } catch { return {}; }
}
export const defaultAutonomy = (c: Ctx, portfolio: string): Autonomy => portfolioDefaults(c)[portfolio] ?? 'semi';

/** work automation show | default <portfolio> semi|full --by Name [--reason "…"] [--apply] */
export function cmdAutomation(c: Ctx) {
  const [, sub, portfolio, level] = c.pos;
  if (sub === 'show' || !sub) {
    const d = portfolioDefaults(c);
    if (c.flags.get('json') === true) { c.out(JSON.stringify(Object.fromEntries(PORTFOLIOS.map((p) => [p, d[p] ?? 'semi'])))); return; }
    for (const p of PORTFOLIOS) c.out(`${p.padEnd(14)}${d[p] ?? 'semi'}`);
    return;
  }
  if (sub === 'default') {
    if (!portfolio || !PORTFOLIOS.includes(portfolio)) throw new Error(`portfolio must be one of ${PORTFOLIOS.join(', ')}`);
    if (!AUTONOMY.includes(level as Autonomy)) throw new Error('the level is semi or full');
    if (level === 'full' && insideAgent(c.env)) throw new Error('making full automation the default is the owner\'s decision (Cockpit or a terminal), not an agent\'s');
    const by = flag(c, 'by') ?? 'owner';
    const d = portfolioDefaults(c), was = d[portfolio] ?? 'semi';
    if (was === level) { c.out(`  = ${portfolio} already starts new projects as ${level}`); return; }
    d[portfolio] = level as Autonomy;
    const path = automationPath(c);
    c.out(`  ${c.apply ? '✓' : '·'} ${portfolio}: new projects start as ${level} (was ${was})${level === 'full' ? ' — deploys, auto-publishing, spending and new agents still need you' : ''}`);
    if (!c.apply) { c.out('(dry run — add --apply)'); return; }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ _comment: 'Automation level new projects start with, per portfolio (semi or full). Change it in Cockpit (portfolio page) or: npm run work -- automation default <portfolio> semi|full --apply', defaults: d }, null, 2) + '\n');
    renameSync(tmp, path);
    noteDecision(c, { portfolio, title: `New ${portfolio} projects start as ${level === 'full' ? 'full automation' : 'semi-automated'}`, why: flag(c, 'reason') ?? `default changed from ${was} to ${level}`, by, source: 'manual' });
    return;
  }
  throw new Error('usage: work automation show | default <portfolio> semi|full --by Name [--apply]');
}
