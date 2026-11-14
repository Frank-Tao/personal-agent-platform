import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseObjectives, serializeObjectives } from '../../packages/work/model.ts';

import { PORTFOLIOS, flag, flagAll, hoursSince, objectivesPath, portfolioDir, save, show, type Ctx } from '../shared.ts';

/* ---------- kb ---------- */

export function cmdKb(c: Ctx) {
  if (c.pos[1] !== 'init') throw new Error('usage: work kb init [--portfolio p]');
  const only = flag(c, 'portfolio');
  for (const p of only ? [only] : PORTFOLIOS) {
    if (!PORTFOLIOS.includes(p)) throw new Error(`unknown portfolio "${p}"`);
    const src = join(c.templateDir, p);
    if (!existsSync(src)) { c.out(`  ▲ no template for ${p} in ${c.templateDir}`); continue; }
    const dst = portfolioDir(c, p);
    const copies: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(src, rel), { withFileTypes: true })) {
        const r = join(rel, e.name);
        if (e.isDirectory()) walk(r);
        else if (!existsSync(join(dst, r))) copies.push(r);
      }
    };
    walk('');
    c.out(`${p}: ${copies.length ? `${copies.length} file(s) to create` : 'complete (nothing to create)'}${copies.length ? ': ' + copies.join(', ') : ''}`);
    if (c.apply) {
      for (const r of copies) { mkdirSync(dirname(join(dst, r)), { recursive: true }); cpSync(join(src, r), join(dst, r)); }
      if (!existsSync(join(dst, '.git'))) { try { c.run('git', ['-C', dst, 'init', '-q']); c.out('  ✓ git init'); } catch { c.out('  ▲ git init failed (not fatal)'); } }
    }
  }
  if (!c.apply) c.out('(dry run — add --apply)');
}

/* ---------- objectives ---------- */

export function cmdObjective(c: Ctx) {
  const [, sub, portfolio] = c.pos;
  if (sub === 'show') {
    for (const p of portfolio ? [portfolio] : PORTFOLIOS) {
      let o;
      try { o = parseObjectives(readFileSync(objectivesPath(c, p), 'utf8')); } catch { continue; }
      const age = hoursSince(o.reviewed, c.today) / 24;
      c.out(`${p} — ${o.horizon}, reviewed ${o.reviewed || 'never'}${age > 8 ? ' ▲ overdue for review' : ''}`);
      for (const i of o.items) { c.out(`  ${i.id} ${i.title}`); for (const k of i.key_results) c.out(`    ${k.id} ${k.text}`); }
    }
    return;
  }
  if (!portfolio || !PORTFOLIOS.includes(portfolio)) throw new Error(`usage: work objective ${sub ?? 'show|add|review'} <portfolio>  (portfolios: ${PORTFOLIOS.join(', ')})`);
  const path = objectivesPath(c, portfolio);
  let o = existsSync(path) ? parseObjectives(readFileSync(path, 'utf8')) : { portfolio, horizon: 'rolling', reviewed: c.today, items: [] };
  if (!o.portfolio) o = { ...o, portfolio };
  if (sub === 'review') {
    o.reviewed = c.today;
    save(c, path, serializeObjectives(o), `reviewed ${c.today}`);
  } else if (sub === 'add') {
    const title = flag(c, 'title');
    if (!title) throw new Error('usage: work objective add <portfolio> --title "…" --kr "…" [--kr "…"]');
    const id = `O${o.items.reduce((n, i) => Math.max(n, Number(i.id.slice(1))), 0) + 1}`;
    o.items.push({ id, title, key_results: flagAll(c, 'kr').map((text, i) => ({ id: `KR${id.slice(1)}.${i + 1}`, text })) });
    o.reviewed = c.today;
    save(c, path, serializeObjectives(o), `${id} added`);
  } else throw new Error('usage: work objective show|add|review');
  if (!c.apply) c.out('(dry run — add --apply)');
}
