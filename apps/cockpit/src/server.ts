import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { defaultWorkRun } from './work.ts';
import { defaultAgentsRun } from './agentsApi.ts';
import { defaultGrowthRun } from './growthApi.ts';
import { askPersonalPrivacy, fileLog, hermesAsk } from '../../../privacy/ask.ts';
import { join, resolve } from 'node:path';
import { createApp } from './app.ts';
import { agentDetail } from './sources/agentDetail.ts';
import { loadCatalogCached } from '../../../packages/roster/catalog.ts';
import { loadRegistry } from '../../../packages/roster/roster.ts';
import { loadConfig } from './config.ts';
import { buildRollup, collect } from './rollup.ts';
import { Store } from './store.ts';
import { defaultRunner, hermesKanbanSource } from './sources/hermesKanban.ts';
import { atlasSource } from './sources/atlas.ts';
import { usageSource } from './sources/usage.ts';
import { lanesSource } from './sources/lanes.ts';
import { agentsSource } from './sources/agents.ts';
import { workSource } from './sources/work.ts';
import { fileCardsSource } from './sources/fileCards.ts';
import { demoSource } from './sources/demo.ts';
import { GROUPS, type Rollup, type Source } from './types.ts';

const root = resolve(import.meta.dirname, '../../..');
const cfg = loadConfig();
const store = new Store(cfg.demo ? ':memory:' : cfg.dbPath);
const hermes = defaultRunner(cfg.hermesBin);

const sources: Source[] = cfg.demo
  ? [demoSource]
  : [
      atlasSource({ home: cfg.hermesHome, run: hermes, layout: cfg.layout }),
      usageSource({ home: cfg.hermesHome, run: hermes, boardsDir: join(cfg.hermesHome, 'kanban', 'boards'), boardGroups: cfg.layout.boards }),
      agentsSource({ home: cfg.hermesHome, registryPath: cfg.agentsRegistry, portfolios: GROUPS.map((g) => g.id) }),
      lanesSource({ lanes: cfg.layout.lanes, ledgerPath: cfg.lanesLedger, modelsPath: cfg.lanesModels }),
      hermesKanbanSource({ run: hermes, groups: cfg.layout.boards, fallback: cfg.layout.defaultGroup }),
      workSource({ kb: process.env.PORTFOLIO_KB ?? join(homedir(), 'PortfolioKB'), portfolios: GROUPS.map((g) => g.id) }),
      fileCardsSource(cfg.privateSummariesDir, 'private'),
      fileCardsSource(cfg.manualKpiDir, 'manual', cfg.layout.defaultGroup),
    ];

// A snapshot saved by an older version lacks newer fields: start from live data instead of showing it.
const seed = store.latest();
let current: Rollup | undefined = seed && Array.isArray(seed.staffing) && seed.ui?.dashboardUrl !== undefined ? seed : undefined;
let refreshing: Promise<Rollup> | undefined;

function refresh(): Promise<Rollup> {
  // Coalesce concurrent callers into one collection run.
  refreshing ??= (async () => {
    try {
      const { cards, errors, atlas, usage, lanes, agents, needs } = await collect(sources);
      current = buildRollup(cards, errors, atlas, {
        usage,
        lanes,
        agents,
        needs,
        channels: cfg.layout.channels.length ? cfg.layout.channels : undefined,
        catalog: loadCatalogCached(registry().catalog.dir),
        ui: { channels: cfg.layout.channels, lanes: cfg.layout.lanes, dashboardUrl: cfg.layout.dashboardUrl, writeToken: !!cfg.writeToken, groups: GROUPS },
      });
      store.save(current);
      return current;
    } finally {
      refreshing = undefined;
    }
  })();
  return refreshing;
}

async function getRollup(): Promise<Rollup> {
  const stale = !current || Date.now() - Date.parse(current.generatedAt) > cfg.refreshSeconds * 1000;
  if (stale) return refresh();
  return current!;
}

const publicDir = join(import.meta.dirname, '..', 'public');
const registry = () => loadRegistry(cfg.agentsRegistry);

// Demo mode must never touch the real knowledge base. `projects` is read-only but spawns Hermes per project, so cache it briefly.
const workEnv = { ...process.env, ...(cfg.demo ? { PORTFOLIO_KB: join(tmpdir(), 'cockpit-demo-kb') } : {}) };
const workRaw = defaultWorkRun(workEnv);
const projectsCache = new Map<string, { at: number; result: ReturnType<typeof workRaw> }>();
const work: typeof workRaw = (argv) => {
  if (argv[0] === 'projects' || (argv[0] === 'repos' && argv[1] === '--json')) {
    const key = argv.join(' ');
    const hit = projectsCache.get(key);
    if (hit && Date.now() - hit.at < 15_000) return hit.result;
    const result = workRaw(argv);
    if (result.code === 0) projectsCache.set(key, { at: Date.now(), result });
    return result;
  }
  projectsCache.clear(); // anything that writes invalidates every cached read
  return workRaw(argv);
};

const agentsRun = defaultAgentsRun(process.env);
const growthRun = defaultGrowthRun(process.env);
const privacyLog = fileLog(join(root, 'data', 'privacy.jsonl'));
const privacyLocal = hermesAsk(cfg.hermesBin);
const app = createApp({
  work,
  privacyAsk: (text) => askPersonalPrivacy(privacyLocal, text, privacyLog, 'cockpit'),
  agentsRun,
  growthRun,
  modelsPath: join(root, 'config', 'models.json'),
  publicDir,
  guard: { allowedHosts: cfg.layout.allowedHosts, token: cfg.writeToken },
  chat: { apiUrl: cfg.hermesApiUrl, apiKey: cfg.hermesApiKey },
  tasks: {
    run: hermes,
    boardFor: (portfolio) => Object.entries(cfg.layout.boards).find(([, g]) => g === portfolio)?.[0],
  },
  getRollup: (fresh) => (fresh ? refresh() : getRollup()),
  history: (days) => store.history(days),
  agentDetail: (id) => agentDetail({ home: cfg.hermesHome, registryPath: cfg.agentsRegistry, id }),
  catalog: () => loadCatalogCached(registry().catalog.dir),
  invalidate: () => { current = undefined; },
});
// The automation after approval: every minute, move approved projects forward (ask pm to plan, apply a written plan, mark finished
// ones for review). Cheap when nothing is active: it only reads project files. The launchd job does the same every ten minutes.
if (!cfg.demo) setInterval(() => { try { const r = work(['advance', '--apply']); if (/[+→✓]/.test(r.output)) { current = undefined; } } catch (e) { console.error('advance failed', e); } }, 60_000).unref();

const server = createServer((req, res) => void app(req, res));

server.listen(cfg.port, cfg.host, () => {
  console.log(`cockpit on http://${cfg.host}:${cfg.port}${cfg.demo ? ' (demo data)' : ''}`);
  void refresh();
  setInterval(() => void refresh(), cfg.refreshSeconds * 1000).unref();
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    store.close();
    process.exit(0);
  });
}
