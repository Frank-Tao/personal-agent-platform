import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readAbout, readLesson, writeAbout, writeLesson, type AboutEntry, type Lesson } from './model.ts';

// Where growth records live: one folder per agent under the growth root (default ~/AgentGrowth, its own git repository), plus _shared
// for what every agent should know about Frank. Plain files; nothing here depends on Hermes.

export const SHARED = '_shared';
export const aboutPath = (root: string, scope: string) => join(root, scope === '*' ? SHARED : scope, 'about-you.md');
export const lessonDir = (root: string, agent: string) => join(root, agent, 'experience');
export const lessonPath = (root: string, agent: string, id: string) => join(lessonDir(root, agent), `${id}.md`);

function ensure(path: string) { mkdirSync(dirname(path), { recursive: true }); }

export function loadAboutFile(root: string, scope: string): AboutEntry[] {
  const p = aboutPath(root, scope);
  return existsSync(p) ? readAbout(readFileSync(p, 'utf8')) : [];
}
/** What an agent is allowed to know: its own entries plus the shared ones. */
export const loadAbout = (root: string, agent: string): AboutEntry[] => [...loadAboutFile(root, '*'), ...loadAboutFile(root, agent)];

export function saveAboutFile(root: string, scope: string, entries: AboutEntry[], today: string) {
  const p = aboutPath(root, scope); ensure(p);
  writeFileSync(p, writeAbout(scope === '*' ? 'every agent' : scope, entries, today));
}

export function loadLessons(root: string, agent: string): Lesson[] {
  const d = lessonDir(root, agent);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.md')).sort().map((f) => { try { return readLesson(readFileSync(join(d, f), 'utf8')); } catch { return null; } }).filter((l): l is Lesson => !!l && !!l.id);
}
export function saveLesson(root: string, l: Lesson) {
  const p = lessonPath(root, l.agent, l.id); ensure(p);
  writeFileSync(p, writeLesson(l));
}

/** Append-only event log: what was added, applied, corrected or retired. Counts and ids, never task text. */
export function logEvent(root: string, line: object) {
  const p = join(root, 'log.jsonl'); ensure(p);
  appendFileSync(p, JSON.stringify(line) + '\n');
}
export function readEvents(root: string): Array<Record<string, unknown>> {
  const p = join(root, 'log.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
}
