import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter } from './roster.ts';

// The agency-agents catalog (github.com/msitarzewski/agency-agents) as data: personas are markdown files with
// YAML frontmatter, grouped in division folders. Read-only; nothing in a persona is ever executed.

export interface CatalogEntry {
  slug: string; // division/file-without-.md
  division: string;
  name: string;
  description: string;
  vibe: string;
  emoji: string;
  file: string;
  bytes: number;
}

export const expandHome = (p: string): string => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

export function loadCatalog(dir: string): CatalogEntry[] {
  dir = expandHome(dir);
  if (!existsSync(dir)) return [];
  let divisions: string[];
  try {
    divisions = Object.keys(JSON.parse(readFileSync(join(dir, 'divisions.json'), 'utf8')).divisions);
  } catch {
    divisions = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  }
  const out: CatalogEntry[] = [];
  for (const division of divisions) {
    let files: string[] = [];
    try {
      files = readdirSync(join(dir, division)).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = join(dir, division, f);
      const text = readFileSync(file, 'utf8');
      const { meta } = parseFrontmatter(text);
      if (!meta.name) continue; // playbooks without agent frontmatter
      out.push({ slug: `${division}/${f.replace(/\.md$/, '')}`, division, name: meta.name, description: meta.description ?? '', vibe: meta.vibe ?? '', emoji: meta.emoji ?? '', file, bytes: Buffer.byteLength(text) });
    }
  }
  return out;
}

const cache = new Map<string, { stamp: number; entries: CatalogEntry[] }>();

/** Loaded once and reloaded only when the catalog folder changes (Cockpit asks on every refresh). */
export function loadCatalogCached(dir: string): CatalogEntry[] {
  dir = expandHome(dir);
  let stamp = 0;
  try {
    stamp = statSync(join(dir, 'divisions.json')).mtimeMs + statSync(dir).mtimeMs;
  } catch {
    return [];
  }
  const hit = cache.get(dir);
  if (hit && hit.stamp === stamp) return hit.entries;
  const entries = loadCatalog(dir);
  cache.set(dir, { stamp, entries });
  return entries;
}

/* ---------- tiny deterministic text matching ---------- */

const STOP = new Set(('the and for with from into onto over under that this these those your our their its are was were has have had can could should would will ' +
  'not but all any out about after before then than too very just new add make get let use using need needs want wants please task tasks').split(/\s+/));

/**
 * A few jargon words that mean a wider topic, so "SwiftUI" can find an iOS/mobile specialist. Deliberately short:
 * anything beyond this is Atlas' judgement, not a keyword table.
 */
const EXPAND: Record<string, string[]> = {
  swiftui: ['ios', 'swift', 'mobile'], swift: ['ios', 'mobile'], xcode: ['ios', 'mobile'], iphone: ['ios', 'mobile'], ipad: ['ios', 'mobile'],
  android: ['mobile'], kotlin: ['android', 'mobile'], testflight: ['ios', 'release'],
  sql: ['database'], postgres: ['database'], sqlite: ['database'], schema: ['database'], mysql: ['database'],
  seo: ['search'], aso: ['store'], gdpr: ['privacy', 'compliance'], hipaa: ['privacy', 'compliance'],
  udemy: ['course', 'curriculum', 'training'], course: ['curriculum', 'training'], lesson: ['curriculum', 'training'],
  linkedin: ['social', 'content'], tweet: ['social', 'content'], youtube: ['video', 'content'], blog: ['content', 'writing'],
  architecture: ['architect'], architectural: ['architect'], figma: ['design'], ui: ['design'], ux: ['design'], pitch: ['sales'], invoice: ['finance'], stripe: ['payments', 'finance'],
};

const SHORT_OK = new Set(['ai', 'ml', 'qa', 'ui', 'ux']);

/** Lowercase words, no stopwords or tiny words, crude plural/-ing/-ed stemming, plus the small jargon map above. */
export function tokens(text: string): string[] {
  const out = new Set<string>();
  for (let w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    // Two-letter words are filler ('in', 'to', 'of') except a few real ones.
    if (w.length < 2 || STOP.has(w) || (w.length < 3 && !EXPAND[w] && !SHORT_OK.has(w))) continue;
    for (const x of EXPAND[w] ?? []) out.add(x);
    if (w.length < 3) {
      out.add(w);
      continue;
    }
    for (const suf of ['ing', 'ed', 'es', 's']) if (w.length > suf.length + 3 && w.endsWith(suf)) { w = w.slice(0, -suf.length); break; }
    if (!STOP.has(w)) {
      out.add(w);
      for (const x of EXPAND[w] ?? []) out.add(x);
    }
  }
  return [...out];
}

export interface Field {
  text: string;
  weight: number;
}

/** Weighted count of the query's distinct words found in each field (a word counts once per field). */
export function scoreFields(query: ReadonlySet<string>, fields: Field[]): { score: number; matched: string[] } {
  const matched = new Set<string>();
  let score = 0;
  for (const f of fields) {
    const have = new Set(tokens(f.text));
    for (const q of query) {
      if (have.has(q)) {
        score += f.weight;
        matched.add(q);
      }
    }
  }
  return { score, matched: [...matched] };
}

export function searchCatalog(entries: CatalogEntry[], query: string, opts: { division?: string; limit?: number } = {}) {
  const q = new Set(tokens(query));
  return entries
    .filter((e) => !opts.division || e.division === opts.division)
    .map((e) => ({ e, ...scoreFields(q, [{ text: e.name, weight: 3 }, { text: e.slug.replace(/[-/]/g, ' '), weight: 1 }, { text: e.description, weight: 1 }, { text: e.vibe, weight: 1 }]) }))
    .filter((x) => !q.size || x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.slug.localeCompare(b.e.slug))
    .slice(0, opts.limit ?? 12);
}
