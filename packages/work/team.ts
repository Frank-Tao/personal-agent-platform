// Who staffs a new project. Pure and deterministic: no tokens, easy to explain.
// Default is pm + qa. Others join only when the charter's own words call for them:
//   coding   only when the project delivers code (a test command, or code/app/API words)
//   course   online courses, curriculum, lessons
//   content  copy, posts, store listing text
//   research market / competitor / evidence work
//   growth   launch, marketing, advertising, acquisition
//   aso      App Store keywords, screenshots, ratings
// An agent is added only if it exists in the roster, is active, and serves the project's portfolio.

export interface TeamAgent { id: string; state: string; portfolios: string[]; allPortfolios?: boolean }
export interface TeamInput { portfolio: string; outcome: string; done_when: string[]; test_cmd?: string | null; agents: TeamAgent[] }

const RULES: { id: string; why: string; re: RegExp }[] = [
  { id: 'coding', why: 'delivers code', re: /\b(app|apps|build|builds|code|api|rest|ios|swift|testflight|deploy|deployed|feature|features|bug|bugs|refactor|implement|backend|frontend|sign-?in|ui|portal|cli|script|endpoint|dataset|published as an api|tests?|calendar link|\.ics)\b/i },
  { id: 'course', why: 'online course', re: /\b(course|courses|udemy|lesson|lessons|curriculum|lecture|lectures|exercise|exercises|module|modules)\b/i },
  { id: 'content', why: 'writes copy', re: /\b(copy|posts|linkedin|blog|article|landing page|store listing|listing|release notes|write-?up|newsletter)\b/i },
  { id: 'research', why: 'needs evidence', re: /\b(research|competitor|competitors|market scan|survey|evidence|literature|benchmark|validate demand)\b/i },
  { id: 'growth', why: 'launch / marketing', re: /\b(launch|marketing|market it|advertis\w*|ads?|campaign|acquisition|growth|promo\w*|go-to-market|users? get)\b/i },
  { id: 'aso', why: 'App Store listing', re: /\b(app store|aso|keywords?|ratings?|reviews? strategy|store page)\b/i },
];

export function suggestTeam(i: TeamInput): { team: string[]; reasons: Record<string, string> } {
  const text = [i.outcome, ...i.done_when].join(' . ');
  const serves = (a: TeamAgent) => a.state === 'active' && (a.allPortfolios || a.portfolios.includes(i.portfolio));
  const have = new Map(i.agents.filter(serves).map((a) => [a.id, a]));
  const team: string[] = [];
  const reasons: Record<string, string> = {};
  const add = (id: string, why: string) => { if (!team.includes(id)) { team.push(id); reasons[id] = why; } };
  add('pm', 'plans and owns the project');
  if (have.has('qa')) add('qa', 'checks the evidence');
  for (const r of RULES) {
    if (!have.has(r.id)) continue;
    const hit = r.id === 'coding' ? !!(i.test_cmd && i.test_cmd.trim()) || r.re.test(text) : r.re.test(text);
    if (hit) add(r.id, r.why);
  }
  return { team, reasons };
}
