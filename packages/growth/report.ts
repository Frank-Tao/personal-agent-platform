import { aboutState, type AboutEntry, type Lesson } from './model.ts';
import type { Bucket } from './metrics.ts';

// Daily and weekly closes: facts from the records, no model. A period with no activity says "no activity" instead of inventing a
// story (missing coverage is unknown, not zero). The weekly close also does the Monday check: were last week's lessons actually used?

type Ev = Record<string, unknown>;
const per = (b: Bucket, f: (b: Bucket) => number) => (b.done ? f(b) / b.done : null);
const f1 = (n: number | null, unit = '') => (n === null ? '—' : `${Math.round(n * 10) / 10}${unit}`);
const pct = (b: Bucket) => (b.done ? `${Math.round((100 * b.untouched) / b.done)}%` : '—');
const arrow = (cur: number | null, prev: number | null, higherIsBetter: boolean) => (cur === null || prev === null ? '' : cur === prev ? ' →' : (cur > prev) === higherIsBetter ? ' ↑ better' : ' ↓ worse');
const inRange = (e: Ev, from: string, to: string) => typeof e.at === 'string' && e.at.slice(0, 10) >= from && e.at.slice(0, 10) <= to;

export function renderDaily(agent: string, day: Bucket, events: Ev[]): string {
  const mine = events.filter((e) => e.agent === agent && inRange(e, day.key, day.key));
  const count = (k: string) => mine.filter((e) => e.kind === k).length;
  const active = day.done > 0 || day.tokens > 0 || mine.length > 0;
  return `# ${day.key} — ${agent}\n\n${active ? `- Finished tasks: **${day.done}** (${pct(day)} without anyone stepping in), extra attempts: ${day.retries}, run time: ${Math.round(day.minutes)} min, tokens: ${day.tokens}\n- Lessons: ${count('lesson-add')} added, ${count('lesson-apply')} applied, ${count('lesson-retire')} retired\n- About you: ${count('about-add')} added, ${count('about-correct') + count('about-retract')} corrected or retracted, ${count('about-observe')} confirmations\n- Context packets given before tasks: ${count('packet')}\n` : 'No activity recorded.\n'}`;
}

export function renderWeekly(o: { agent: string; week: Bucket; prev: Bucket | null; today: string; lessons: Lesson[]; about: AboutEntry[]; events: Ev[] }): string {
  const { agent, week, prev } = o, to = (() => { const d = new Date(week.start + 'T12:00:00'); d.setDate(d.getDate() + 6); return d.toISOString().slice(0, 10); })();
  const ev = o.events.filter((e) => e.agent === agent && inRange(e, week.start, to));
  const prevEv = prev ? o.events.filter((e) => e.agent === agent && inRange(e, prev.start, (() => { const d = new Date(prev.start + 'T12:00:00'); d.setDate(d.getDate() + 6); return d.toISOString().slice(0, 10); })())) : [];
  const row = (label: string, cur: string, pv: string, tr: string) => `| ${label} | ${cur} | ${pv} | ${tr.trim() || ''} |`;
  const tpt = per(week, (b) => b.tokens), tptP = prev ? per(prev, (b) => b.tokens) : null;
  const rpt = per(week, (b) => b.retries), rptP = prev ? per(prev, (b) => b.retries) : null;
  const mpt = per(week, (b) => b.minutes), mptP = prev ? per(prev, (b) => b.minutes) : null;
  const up = week.done ? week.untouched / week.done : null, upP = prev && prev.done ? prev.untouched / prev.done : null;
  const thin = week.done < 5 ? '\n> Fewer than 5 finished tasks this week: treat the trend as noise, not evidence of improvement.\n' : '';
  const tentativeStale = o.lessons.filter((l) => l.agent === agent && l.status === 'tentative' && l.applied.length === 0 && (Date.parse(o.today) - Date.parse(l.created)) / 86_400_000 >= 14);
  const used = new Set(ev.filter((e) => e.kind === 'packet').flatMap((e) => (Array.isArray(e.lessons) ? (e.lessons as string[]) : [])));
  const prevUsed = new Set(prevEv.filter((e) => e.kind === 'packet').flatMap((e) => (Array.isArray(e.lessons) ? (e.lessons as string[]) : [])));
  const applied = (id: string) => ev.some((e) => e.kind === 'lesson-apply' && e.lesson === id);
  const prevApplied = (id: string) => [...prevEv, ...ev].some((e) => e.kind === 'lesson-apply' && e.lesson === id);
  const tentativeAbout = o.about.filter((e) => (e.scope === '*' || e.scope === agent) && aboutState(e, o.today) === 'tentative');
  const lines: string[] = [];
  lines.push(`# ${week.key} — ${agent}`, '', week.done || week.tokens ? '' : 'No activity recorded this week.', '', '## Numbers (this week vs last)', '', '| | This week | Last week | Trend |', '|---|---|---|---|',
    row('Finished tasks', String(week.done), prev ? String(prev.done) : '—', ''),
    row('Ran without anyone stepping in', pct(week), prev ? pct(prev) : '—', arrow(up, upP, true)),
    row('Extra attempts per task', f1(rpt), f1(rptP), arrow(rpt, rptP, false)),
    row('Minutes per task', f1(mpt), f1(mptP), arrow(mpt, mptP, false)),
    row('Tokens per finished task', f1(tpt), f1(tptP), arrow(tpt, tptP, false)), thin,
    '## Lessons', '',
    `- Added: ${ev.filter((e) => e.kind === 'lesson-add').length} · applied: ${ev.filter((e) => e.kind === 'lesson-apply').length} (${ev.filter((e) => e.kind === 'lesson-apply' && e.outcome === 'win').length} wins, ${ev.filter((e) => e.kind === 'lesson-apply' && e.outcome === 'loss').length} losses) · retired: ${ev.filter((e) => e.kind === 'lesson-retire').length}`,
    `- In the library: ${o.lessons.filter((l) => l.agent === agent && l.status !== 'retired').length} live (${o.lessons.filter((l) => l.agent === agent && l.status === 'reused').length} reused, ${o.lessons.filter((l) => l.agent === agent && l.status === 'local').length} verified once, ${o.lessons.filter((l) => l.agent === agent && l.status === 'tentative').length} unverified)`);
  if (tentativeStale.length) lines.push(`- Unverified for 14+ days (apply it on a real task, or retire it): ${tentativeStale.map((l) => l.id).join(', ')}`);
  lines.push('', '## Monday check: last week\'s lessons', '');
  const lastWeekLessons = [...prevUsed];
  lines.push(lastWeekLessons.length ? lastWeekLessons.map((id) => `- ${id}: given to the agent, ${prevApplied(id) ? 'outcome recorded' : '**no outcome recorded** (was it used?)'}`).join('\n') : '- No lessons were given to this agent last week.');
  lines.push('', '## About you', '', `- New evidence this week: ${ev.filter((e) => e.kind === 'about-add').length} · corrections: ${ev.filter((e) => e.kind === 'about-correct' || e.kind === 'about-retract').length} · confirmations: ${ev.filter((e) => e.kind === 'about-observe').length}`);
  if (tentativeAbout.length) lines.push(`- Tentative (not used in plans until confirmed): ${tentativeAbout.map((e) => e.id).join(', ')}`);
  lines.push('', `_Lessons used this week: ${[...used].filter((id) => applied(id)).length} of ${used.size} that were given have a recorded outcome._`, '');
  return lines.join('\n');
}
