import { aboutConfidence, aboutState, wins, losses, type AboutEntry, type Lesson } from './model.ts';

// What an agent reads before it starts: a small packet, not everything it ever learned. Constraints always come first and are never
// cut; if they alone do not fit the budget that is reported, not hidden. Everything else is filtered (valid, in scope) and then ranked
// by relevance to the task. No model is involved, so a packet costs no tokens to build.

const STOP = new Set('the and for with that this from into your you are was were will have has had not but can all any its our out use using what when then than them they there their how why who which should would could about after before over under more most some such only also each other task project'.split(' '));
export const words = (s: string): Set<string> => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 3 && !STOP.has(w)));
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n; };

export interface Packet { text: string; about: string[]; lessons: string[]; chars: number; truncated: boolean }

const RANK = { reused: 3, local: 2, tentative: 1, retired: -9 } as const;

export function buildPacket(opts: { agent: string; task: string; about: AboutEntry[]; lessons: Lesson[]; today: string; budget?: number }): Packet {
  const budget = opts.budget ?? 3000;
  const t = words(opts.task);
  const mine = opts.about.filter((e) => (e.scope === '*' || e.scope === opts.agent) && aboutState(e, opts.today) === 'active');
  const constraints = mine.filter((e) => e.kind === 'constraint');
  const aboutLine = (e: AboutEntry) => `- [${e.kind}] ${e.text} (${e.source === 'observed' ? `seen ${e.support + 1}×` : 'Frank said so'}, ${e.observed})`;
  const head = '## What you know about Frank (his own statements and corrections win over anything else)\n';
  const must = constraints.map(aboutLine).join('\n');
  if (head.length + must.length > budget) throw new Error(`the constraints alone (${head.length + must.length} chars) exceed the budget of ${budget}; raise the budget or retire some constraints`);

  const others = mine.filter((e) => e.kind !== 'constraint').map((e) => ({ e, s: overlap(t, words(e.text)) * 2 + aboutConfidence(e, opts.today) })).filter((x) => x.s >= 1.4 || t.size === 0).sort((a, b) => b.s - a.s);
  const cands = opts.lessons.filter((l) => l.agent === opts.agent && l.status !== 'retired').map((l) => {
    const o = overlap(t, words(`${l.title} ${l.when}`));
    return { l, o, s: RANK[l.status] + o * 2 + wins(l) * 0.5 - losses(l) };
  }).filter((x) => x.o >= (x.l.status === 'tentative' ? 2 : 1)).sort((a, b) => b.s - a.s);

  let out = head + (must ? must + '\n' : '');
  const used = { about: constraints.map((e) => e.id), lessons: [] as string[] };
  let truncated = false;
  for (const { e } of others) { const line = aboutLine(e) + '\n'; if (out.length + line.length > budget) { truncated = true; break; } out += line; used.about.push(e.id); }
  if (cands.length) {
    const h2 = '\n## Lessons from earlier work that may apply\n';
    let sec = '';
    for (const { l } of cands) {
      const line = `- **${l.title}**: ${l.lesson} (applies when: ${l.when}${l.not_when ? `; not when: ${l.not_when}` : ''}) [${l.status}${l.applied.length ? `, ${wins(l)} win${wins(l) === 1 ? '' : 's'}/${losses(l)} loss${losses(l) === 1 ? '' : 'es'}` : ', not yet verified'}] (${l.id})\n`;
      if (out.length + h2.length + sec.length + line.length > budget) { truncated = true; break; }
      sec += line; used.lessons.push(l.id);
    }
    if (sec) out += h2 + sec;
  }
  if (!constraints.length && !used.about.length && !used.lessons.length) out = '';
  else if (used.lessons.length) out += '\nIf you use a lesson, record the outcome afterwards: growth lesson apply <id> --task <task id> --outcome win|loss.\n';
  return { text: out, about: used.about, lessons: used.lessons, chars: out.length, truncated };
}
