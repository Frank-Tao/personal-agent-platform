import type { AgentInfo, AgentStatus, LaneInfo, PortfolioCard, RunDay, Source, TaskCounts, UsageStats } from '../types.ts';

function runs(seed: number): RunDay[] {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86_400_000).toISOString().slice(0, 10);
    const total = 4 + ((i * seed) % 9);
    const failed = (i * seed) % 5 === 0 ? 1 : 0;
    return { date: d, succeeded: total - failed, failed, total };
  });
}

/** Fake data so the dashboard can be developed and demoed with nothing else running. */
export const demoSource: Source = async () => {
  const now = new Date().toISOString();
  const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const cards: PortfolioCard[] = [
    {
      id: 'micropace-labs', name: 'MicroPace Labs', group: 'micropace', source: 'demo', status: 'warn',
      headline: '1 running · 4 open · 1 in review · 12 done',
      metrics: [{ label: 'PRs ready', value: '2' }, { label: 'MRR', value: '$1,840', trend: 'up' }],
      earnings: { monthCents: 184000 },
      tasks: { open: 4, inProgress: 2, blocked: 1, done: 12 },
      team: [
        { assignee: 'architect', running: 0, ready: 1, review: 1, blocked: 0, done: 3 },
        { assignee: 'coding', running: 1, ready: 2, review: 0, blocked: 1, done: 6 },
        { assignee: 'qa', running: 0, ready: 1, review: 0, blocked: 0, done: 3 },
      ],
      spend: { spentCents: 6400, budgetCents: 15000 }, runs: runs(3),
      needsYou: [
        { portfolioId: 'micropace-labs', kind: 'approval', title: 'Review: Deploy Notice → Calendar v1', severity: 'warn' },
        { portfolioId: 'micropace-labs', kind: 'blocker', title: 'Blocked: real notice sample needed', severity: 'warn' },
      ],
      updatedAt: now,
    },
    {
      id: 'ai-thrival', name: 'AI Thrival', group: 'ai-thrival', source: 'demo', status: 'ok',
      headline: '0 running · 3 open · 2 in review · 9 done',
      metrics: [{ label: 'Students', value: '1,240', trend: 'up' }, { label: 'Rating', value: '4.6' }],
      earnings: { monthCents: 62000 },
      tasks: { open: 3, inProgress: 2, blocked: 0, done: 9 },
      team: [
        { assignee: 'aso', running: 0, ready: 1, review: 0, blocked: 0, done: 2 },
        { assignee: 'coding', running: 0, ready: 1, review: 0, blocked: 0, done: 2 },
        { assignee: 'content', running: 1, ready: 0, review: 2, blocked: 0, done: 5 },
      ],
      spend: { spentCents: 2100, budgetCents: 8000 }, runs: runs(5),
      needsYou: [{ portfolioId: 'ai-thrival', kind: 'approval', title: 'Review: LinkedIn post "What I learned shipping agents"', severity: 'warn' }],
      updatedAt: now,
    },
    {
      id: 'investments', name: 'Investments', group: 'investments', source: 'demo', status: 'ok',
      headline: 'Read-only monitoring',
      metrics: [{ label: 'Value', value: '$412k' }, { label: 'MTD', value: '+2.1%', trend: 'up' }],
      tasks: { open: 2, inProgress: 1, blocked: 0, done: 12 },
      spend: { spentCents: 900, budgetCents: 5000 }, runs: runs(2),
      needsYou: [{ portfolioId: 'investments', kind: 'alert', title: 'NVDA moved -6% — review thesis note', severity: 'info' }],
      updatedAt: now,
    },
    {
      id: 'cron:default:Weekly AI Analysis', name: 'Weekly AI Analysis', group: 'research', source: 'demo', status: 'ok',
      headline: 'Sat 09:00 · default',
      metrics: [{ label: 'Last run', value: now.slice(0, 10) }, { label: 'Next run', value: soon(7).slice(0, 10) }],
      needsYou: [], updatedAt: now,
    },
    {
      id: 'cron:default:AIP-C01 resource collector', name: 'AIP-C01 resource collector', group: 'research', source: 'demo', status: 'alert',
      headline: 'every 3 days · default',
      metrics: [{ label: 'Last run', value: now.slice(0, 10) }, { label: 'Next run', value: soon(3).slice(0, 10) }],
      needsYou: [{ portfolioId: 'cron:default:AIP-C01 resource collector', kind: 'alert', title: 'Job failed: AIP-C01 resource collector', severity: 'alert' }],
      updatedAt: now,
    },
    {
      id: 'family', name: 'Family', group: 'family', source: 'demo', status: 'ok',
      headline: '2 open · 0 blocked',
      metrics: [{ label: 'This week', value: '3 events' }, { label: 'School forms', value: '1' }],
      tasks: { open: 2, inProgress: 0, blocked: 0, done: 5 },
      needsYou: [{ portfolioId: 'family', kind: 'deadline', title: 'Sign excursion form', severity: 'info', dueAt: soon(2).slice(0, 10) }],
      updatedAt: now,
    },
    {
      id: 'household', name: 'Household finances', group: 'family', source: 'demo', status: 'ok',
      headline: 'Cash runway 7.2 months',
      metrics: [{ label: 'Runway', value: '7.2 mo' }, { label: 'Bills this week', value: '3' }],
      needsYou: [{ portfolioId: 'household', kind: 'deadline', title: 'Q4 estimated tax due', severity: 'info', dueAt: '2027-01-15' }],
      updatedAt: now,
    },
  ];
  const atlas: AgentStatus = {
    name: 'Atlas', status: 'alert',
    reasons: [
      { severity: 'alert', text: 'Codex weekly limit 100% used — resets 2026-11-04' },
      { severity: 'warn', text: 'Diane Telegram is retrying' },
      { severity: 'warn', text: '1 scheduled job failing' },
    ],
    gateway: { state: 'running', updatedAt: now, ageSeconds: 12, activeAgents: 1 },
    platforms: [
      { name: 'telegram', state: 'connected', since: now, error: null }, { name: 'coding:telegram', state: 'connected', since: now, error: null },
      { name: 'diane:telegram', state: 'retrying', since: now, error: 'failed to reconnect' },
    ],
    profiles: ['default', 'coding', 'writer'],
    workersRunning: 1,
    jobs: [
      { name: 'Atlas morning brief', profile: 'default', enabled: true, lastStatus: 'ok', lastRunAt: now, nextRunAt: soon(1), schedule: '0 8 * * *' },
      { name: 'Nightly memory consolidation', profile: 'default', enabled: true, lastStatus: 'ok', lastRunAt: now, nextRunAt: soon(1), schedule: '0 23 * * *' },
      { name: 'Weekly AI Analysis', profile: 'default', group: 'research', enabled: true, lastStatus: 'ok', lastRunAt: now, nextRunAt: soon(7), schedule: 'Sat 09:00' },
      { name: 'AIP-C01 resource collector', profile: 'default', group: 'research', enabled: true, lastStatus: 'error', lastRunAt: now, nextRunAt: soon(3), schedule: 'every 3 days' },
    ],
    lanes: ['claude', 'codex', 'opencode-zen', 'openrouter', 'openai', 'ollama'].map((name) => ({ name, available: true })),
  };
  const noRuns = { total: 0, failed: 0, lastAt: null, lastStatus: null, lastNote: null };
  const lane = (l: Partial<LaneInfo> & Pick<LaneInfo, 'name' | 'kind' | 'status'>): LaneInfo => ({
    installed: true, login: 'ok', plan: null, detail: '', limits: [], limitsSource: null, model: null, modelsNow: [], lastModel: null, spend: null, runs: noRuns, ...l,
  });
  const lanes: LaneInfo[] = [
    lane({ name: 'claude', kind: 'cli', status: 'ok', plan: 'pro', detail: 'logged in via claude.ai',
      limits: [{ label: 'Session', usedPercent: 52, resets: 'today at 11:29pm' }, { label: 'Week (all models)', usedPercent: 50, resets: 'Nov 1 at 4:59am' }],
      limitsSource: 'claude /usage (subscription, this machine)', runs: { total: 6, failed: 0, lastAt: now, lastStatus: 'ok', lastNote: null } }),
    lane({ name: 'codex', kind: 'cli', status: 'alert', plan: 'Plus', detail: 'Logged in using ChatGPT',
      limits: [{ label: 'Weekly', usedPercent: 100, resets: soon(4) }], limitsSource: "ChatGPT plan, via Hermes' Codex login (same account as the codex CLI)",
      runs: { total: 2, failed: 1, lastAt: now, lastStatus: 'failed', lastNote: "ERROR: You've hit your usage limit" } }),
    lane({ name: 'opencode-zen', kind: 'api', status: 'ok', plan: 'free models', detail: '10 free models, no key needed', model: 'opencode/big-pickle',
      spend: { costUsd: 0, messages: 4 }, runs: { total: 3, failed: 1, lastAt: now, lastStatus: 'ok', lastNote: null }, lastModel: 'opencode/big-pickle' }),
    lane({ name: 'openrouter', kind: 'api', status: 'ok', plan: 'API key', detail: '381 models available', model: 'openrouter/~deepseek/deepseek-v4-flash-latest',
      spend: { costUsd: 0.31, messages: 22 }, runs: { total: 9, failed: 0, lastAt: now, lastStatus: 'ok', lastNote: null }, lastModel: 'openrouter/~deepseek/deepseek-v4-flash-latest' }),
    lane({ name: 'openai', kind: 'api', status: 'unknown', login: 'none', detail: 'not set up — run `opencode auth login` and choose OpenAI', model: 'openai/gpt-5.5' }),
    lane({ name: 'ollama', kind: 'local', status: 'ok', detail: 'reachable · 13 models installed', model: 'qwen3.8:27b', modelsNow: ['qwen3.8:27b'], lastModel: 'qwen3.8:27b',
      runs: { total: 2, failed: 0, lastAt: now, lastStatus: 'ok', lastNote: null } }),
  ];
  const t = (r: number, q: number, v: number, b: number, d: number): TaskCounts => ({ running: r, ready: q, review: v, blocked: b, done: d });
  const agent = (a: Partial<AgentInfo> & Pick<AgentInfo, 'id' | 'name' | 'role' | 'portfolios'>): AgentInfo => ({
    profile: a.id, emoji: null, division: null, personaSlug: null, state: 'active', managed: true, status: 'ok', lanes: [], model: 'gpt-6-luna', provider: 'openai-codex',
    allPortfolios: false, tokens7d: 0, sessions7d: 0, lastAt: null, tasks: t(0, 0, 0, 0, 0), byPortfolio: {}, ...a,
  });
  const agents: AgentInfo[] = [
    agent({ id: 'atlas', profile: 'default', name: 'Atlas', role: 'Chief of staff: routes requests to the right agent and lane.', managed: false, portfolios: ['ai-thrival', 'micropace', 'investments', 'research', 'family'], allPortfolios: true, tokens7d: 214_000, sessions7d: 10, lastAt: now }),
    agent({ id: 'coding', name: 'Coding', role: 'General software engineer using the claude and codex lanes.', managed: false, lanes: ['claude', 'codex'], portfolios: ['micropace', 'ai-thrival'], tokens7d: 61_000, sessions7d: 2, lastAt: now, status: 'warn',
      tasks: t(1, 3, 0, 1, 8), byPortfolio: { micropace: t(1, 2, 0, 1, 6), 'ai-thrival': t(0, 1, 0, 0, 2) } }),
    agent({ id: 'content', name: 'Content Creator', emoji: '✍️', division: 'marketing', personaSlug: 'marketing/marketing-content-creator', role: 'Writes AI Thrival content; drafts only.', lanes: ['claude', 'openrouter'], portfolios: ['ai-thrival'],
      model: 'deepseek-v4.1-flash', provider: 'opencode-zen', tokens7d: 98_000, sessions7d: 5, lastAt: now, tasks: t(1, 0, 2, 0, 5), byPortfolio: { 'ai-thrival': t(1, 0, 2, 0, 5) } }),
    agent({ id: 'aso', name: 'App Store Optimizer', emoji: '📱', division: 'marketing', personaSlug: 'marketing/marketing-app-store-optimizer', role: 'App Store optimization for the iOS apps.', lanes: ['openrouter'], portfolios: ['ai-thrival'],
      tasks: t(0, 1, 0, 0, 2), byPortfolio: { 'ai-thrival': t(0, 1, 0, 0, 2) }, tokens7d: 12_000, sessions7d: 1, lastAt: soon(0) }),
    agent({ id: 'architect', name: 'Software Architect', emoji: '🏛️', division: 'engineering', personaSlug: 'engineering/engineering-software-architect', role: 'Architecture for greenfield projects.', lanes: ['claude'], portfolios: ['micropace'],
      tasks: t(0, 1, 1, 0, 3), byPortfolio: { micropace: t(0, 1, 1, 0, 3) }, tokens7d: 44_000, sessions7d: 3, lastAt: now }),
    agent({ id: 'pm', name: 'Project Manager', emoji: '📋', division: 'project-management', personaSlug: 'project-management/project-manager-senior', role: 'Turns specs into scoped tasks.', state: 'proposed', status: 'unknown', model: null, provider: null, lanes: ['openrouter'], portfolios: ['micropace', 'ai-thrival'] }),
    agent({ id: 'qa', name: 'Reality Checker', emoji: '🧐', division: 'testing', personaSlug: 'testing/testing-reality-checker', role: 'Independent reviewer; wants evidence.', state: 'proposed', status: 'unknown', model: null, provider: null, lanes: ['claude', 'codex'], portfolios: ['micropace', 'ai-thrival'] }),
    agent({ id: 'personal', name: 'Personal (local)', role: 'Household money questions, local model only.', managed: false, lanes: ['ollama'], portfolios: ['family'], model: 'qwen3.8:27b', provider: 'local-ai' }),
    agent({ id: 'diane', name: 'diane', role: 'Hermes profile that is not in the roster', state: 'unlisted', status: 'unknown', managed: false, portfolios: [], tokens7d: 6_900_000, sessions7d: 206, lastAt: now }),
  ];
  const days = Array.from({ length: 14 }, (_, i) => {
    const date = new Date(Date.now() - (13 - i) * 86_400_000).toISOString().slice(0, 10);
    const chat = 8_000 + ((i * 7_919) % 40_000);
    const jobs = i % 7 === 5 ? 160_000 + i * 3_000 : 12_000 + ((i * 3_571) % 20_000);
    const other = (i * 1_237) % 15_000;
    // Split the same totals by channel and by agent so every chart mode adds up to the same bar.
    const tg = Math.round(chat * 0.7), api = chat - tg, oneshot = Math.round(other * 0.6), cli = other - oneshot;
    const dianeShare = Math.round(jobs * 0.55), codingShare = Math.round(chat * 0.12), zoeShare = i % 4 === 0 ? 2_400 : 0;
    const atlas = chat + jobs + other - dianeShare - codingShare - zoeShare;
    return {
      date, chat, jobs, other, sessions: 3 + (i % 6),
      bySource: { telegram: tg, cron: jobs, api_server: api, oneshot, cli },
      byProfile: { default: atlas, diane: dianeShare, coding: codingShare, ...(zoeShare ? { zoe: zoeShare } : {}) },
      ...(() => {
        const tot = chat + jobs + other, a = Math.round(tot * 0.26), m = Math.round(tot * 0.31), r = Math.round(tot * 0.08), a1 = Math.round(a * 0.6), m1 = Math.round(m * 0.55);
        return {
          byPortfolio: { 'ai-thrival': a, micropace: m, research: r, _none: tot - a - m - r },
          byProject: { 'changes-app-review': a1, 'apa7review-testflight': a - a1, 'datahub-phase1': m1, 'familyorbit-m3': m - m1, 'research:(no project)': r, _none: tot - a - m - r },
        };
      })(),
    };
  });
  const sumDays = (rows: typeof days) => ({
    tokens: rows.reduce((n, d) => n + d.chat + d.jobs + d.other, 0),
    sessions: rows.reduce((n, d) => n + d.sessions, 0),
    costUsd: 0,
  });
  const usage: UsageStats = {
    today: sumDays(days.slice(-1)), week: sumDays(days.slice(-7)), month: sumDays(days),
    days,
    byPortfolio: ['ai-thrival', 'micropace', 'research', '_none'].map((id) => ({ id, portfolio: id === '_none' ? null : id, tokens: days.reduce((n, d) => n + (d.byPortfolio[id] ?? 0), 0), sessions: 12, costUsd: 0 })),
    byProject: ['datahub-phase1', 'changes-app-review', 'familyorbit-m3', 'apa7review-testflight', 'research:(no project)', '_none'].map((id) => ({ id, portfolio: id === '_none' ? null : id.startsWith('research') ? 'research' : id.includes('changes') || id.includes('apa7') ? 'ai-thrival' : 'micropace', tokens: days.reduce((n, d) => n + (d.byProject[id] ?? 0), 0), sessions: 6, costUsd: 0 })),
    byModel: [
      { model: 'gpt-6-luna', billing: 'subscription_included', sessions: 61, tokens: 2_940_000, costUsd: 0 },
      { model: 'deepseek-flash', billing: 'api', sessions: 9, tokens: 410_000, costUsd: 0.42 },
    ],
    lastActivityAt: now,
    channels: [
      { profile: 'default', source: 'telegram', sessions: 9, tokens: 214_000, lastAt: now },
      { profile: 'diane', source: 'telegram', sessions: 14, tokens: 388_000, lastAt: soon(0) },
      { profile: 'coding', source: 'telegram', sessions: 0, tokens: 0, lastAt: null },
    ],
    recent: [
      { at: now, source: 'telegram', profile: 'default', model: 'gpt-6-luna', tokens: 31_906 },
      { at: soon(0), source: 'cron', profile: 'default', model: 'gpt-6-luna', tokens: 9_188 },
      { at: soon(0), source: 'cron', profile: 'diane', model: 'gpt-6-luna', tokens: 22_410 },
    ],
    limits: [{ provider: 'openai-codex', plan: 'Plus', windows: [{ label: 'Weekly', usedPercent: 100, resetsAt: soon(4) }] }],
  };
  return { cards, errors: [], atlas, usage, lanes, agents };
};
