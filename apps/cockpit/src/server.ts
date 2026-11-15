import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { childWorkRun, type WorkResult, type WorkRun } from './work.ts';
import { agentTraffic } from '../../../packages/work/agenttraffic.ts';
import { defaultAgentsRun } from './agentsApi.ts';
import { defaultGrowthRun } from './growthApi.ts';
import { askPersonalPrivacy, fileLog, hermesAsk } from '../../../privacy/ask.ts';
import { join, resolve } from 'node:path';
import { addFeedback, list as listFeedback } from '../../../packages/work/feedback.ts';
import { decide, listProposals } from '../../../packages/work/decide.ts';
import { feedbackSource } from './sources/feedback.ts';
import { backupSource } from './sources/backup.ts';
import { deploySource } from './sources/deploy.ts';
import { portalHealthSource } from './sources/portalHealth.ts';
import { buildPanel, readPanel } from '../../../packages/portfolio/panel.ts';
import { fileAudit } from './audit.ts';
import { getSession, listSessions } from './sources/sessions.ts';
import { dataDir, envName } from '../../../packages/paths/paths.ts';
import { versionSource } from './version.ts';
import { createApp } from './app.ts';
import { agentDetail, saveAgentDoc } from './sources/agentDetail.ts';
import { buildPeople, resolveIdentity, tailscaleWhois } from './identity.ts';
import { fileStore, fileTokenSource } from './admin.ts';
import { loadCatalogCached } from '../../../packages/roster/catalog.ts';
import { loadRegistry } from '../../../packages/roster/roster.ts';
import { loadConfig } from './config.ts';
import { buildRollup, collect } from './rollup.ts';
import { Store } from './store.ts';
import { portalLinks } from './portal.ts';
import { defaultRunner, hermesKanbanSource } from './sources/hermesKanban.ts';
import { atlasSource } from './sources/atlas.ts';
import { usageSource } from './sources/usage.ts';
import { lanesSource } from './sources/lanes.ts';
import { agentsSource } from './sources/agents.ts';
import { workSource } from './sources/work.ts';
import { fileCardsSource } from './sources/fileCards.ts';
import { demoSource } from './sources/demo.ts';
import { GROUPS, ROLLUP_VERSION, type Rollup, type Source } from './types.ts';

const root = resolve(import.meta.dirname, '../../..');
const data = dataDir();   // prod: ~/services/data/personal-agent-platform (PAP_DATA_DIR); dev: <repo>/data
const cfg = loadConfig();
const store = new Store(cfg.demo ? ':memory:' : cfg.dbPath);
// backfillNeeds reads the stored snapshots, so it runs before they are thinned.
if (!cfg.demo) store.backfillNeeds((n, r) => r.portfolios.find((c) => c.id === n.portfolioId)?.group ?? n.task?.portfolio ?? n.portfolioId);
if (!cfg.demo) { const gone = store.prune(); if (store.compact()) console.log(`store: ${gone} old snapshots removed and the file compacted`); }
const hermes = defaultRunner(cfg.hermesBin);
const portal = cfg.layout.utilityPortal ? portalLinks(cfg.layout.utilityPortal) : undefined;

/** Outbox kinds (publish, deploy, spend) that have an executor in config/outbox.json. */
const outboxHandlers = (): string[] => { try { return Object.keys(JSON.parse(readFileSync(join(root, 'config', 'outbox.json'), 'utf8')).handlers ?? {}); } catch { return []; } };

const sources: Source[] = cfg.demo
  ? [demoSource]
  : [
      atlasSource({ home: cfg.hermesHome, run: hermes, layout: cfg.layout }),
      usageSource({ home: cfg.hermesHome, run: hermes, boardsDir: join(cfg.hermesHome, 'kanban', 'boards'), boardGroups: cfg.layout.boards }),
      agentsSource({ home: cfg.hermesHome, registryPath: cfg.agentsRegistry, portfolios: GROUPS.map((g) => g.id) }),
      lanesSource({ lanes: cfg.layout.lanes, ledgerPath: cfg.lanesLedger, modelsPath: cfg.lanesModels }),
      hermesKanbanSource({ run: hermes, groups: cfg.layout.boards, fallback: cfg.layout.defaultGroup }),
      workSource({ kb: process.env.PORTFOLIO_KB ?? join(homedir(), 'PortfolioKB'), portfolios: GROUPS.map((g) => g.id), outboxHandlers }),
      feedbackSource(data),
      backupSource(process.env.BACKUP_STATUS ?? join(data, 'backup-status.json')),
      ...(cfg.layout.utilityPortal ? [portalHealthSource(cfg.layout.utilityPortal.url)] : []),
      ...(envName() === 'prod' ? [deploySource(data)] : []),   // only prod updates itself
      fileCardsSource(cfg.privateSummariesDir, 'private'),
      fileCardsSource(cfg.manualKpiDir, 'manual', cfg.layout.defaultGroup),
    ];

// A snapshot saved by an older version of the rollup is not shown: start from live data instead.
const seed = store.latest();
let current: Rollup | undefined = seed?.schemaVersion === ROLLUP_VERSION ? seed : undefined;
let refreshing: Promise<Rollup> | undefined;

function refresh(): Promise<Rollup> {
  // Coalesce concurrent callers into one collection run.
  refreshing ??= (async () => {
    try {
      const { cards, errors, atlas, usage, lanes, agents, needs } = await collect(sources);
      // Tools found on the Utility Portal's home page come first; links typed in config/cockpit.json are kept (same URL = once).
      const discovered = (await portal?.()) ?? [];
      const links = [...discovered, ...cfg.layout.links.filter((l) => !discovered.some((d) => d.url === l.url))];
      current = buildRollup(cards, errors, atlas, {
        usage,
        lanes,
        agents,
        needs,
        traffic: cfg.demo ? undefined : agentTraffic(cfg.hermesHome, (b) => cfg.layout.boards[b]),
        channels: cfg.layout.channels.length ? cfg.layout.channels : undefined,
        catalog: loadCatalogCached(registry().catalog.dir),
        ui: { channels: cfg.layout.channels, lanes: cfg.layout.lanes, dashboardUrl: cfg.layout.dashboardUrl, links, writeToken: !!cfg.writeToken, groups: GROUPS },
      });
      if (!cfg.demo) {
        const now = current;
        const grpOf = (n: Pick<(typeof now.needsYou)[number], 'portfolioId' | 'task'>) => now.portfolios.find((c) => c.id === n.portfolioId)?.group ?? n.task?.portfolio ?? n.portfolioId;
        store.trackNeeds(current.needsYou, grpOf);
        current.needsStats = store.needsStats();
      }
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
const workRaw = childWorkRun(workEnv);
const projectsCache = new Map<string, { at: number; result: Promise<WorkResult> }>();
const work: WorkRun = (argv) => {
  if (argv[0] === 'projects' || (argv[0] === 'repos' && argv[1] === '--json')) {
    const key = argv.join(' ');
    const hit = projectsCache.get(key);
    if (hit && Date.now() - hit.at < 15_000) return hit.result;   // also shares one run between callers that ask at the same moment
    const result = Promise.resolve(workRaw(argv));
    projectsCache.set(key, { at: Date.now(), result });
    void result.then((r) => { if (r.code !== 0 && projectsCache.get(key)?.result === result) projectsCache.delete(key); });
    return result;
  }
  projectsCache.clear(); // anything that writes invalidates every cached read
  const done = Promise.resolve(workRaw(argv));
  void done.finally(() => projectsCache.clear());   // and again when it has finished: a read may have started while it ran
  return done;
};

const agentsRun = defaultAgentsRun(process.env);
const growthRun = defaultGrowthRun(process.env);
const privacyLog = fileLog(join(data, 'privacy.jsonl'));
const privacyLocal = hermesAsk(cfg.hermesBin);
const whois = tailscaleWhois();
const people = buildPeople(cfg.layout.people);
const portfolioPath = process.env.PORTFOLIO_SNAPSHOT ?? join(homedir(), 'codes', 'family-portofolio-tracker', 'snapshots', 'portfolio.json');
const syntheticPortfolio = () => ({ ...JSON.parse(readFileSync(join(root, 'packages', 'portfolio', 'synthetic.json'), 'utf8')), generated_at: new Date().toISOString() });
const app = createApp({
  work,
  sessions: cfg.demo ? undefined : { list: (o) => listSessions(cfg.hermesHome, { ...o, exclude: cfg.layout.conversationExclude }), get: (id, o) => getSession(cfg.hermesHome, id, { ...o, exclude: cfg.layout.conversationExclude }) },
  decisionsKb: cfg.demo ? join(tmpdir(), 'cockpit-demo-kb') : (process.env.PORTFOLIO_KB ?? join(homedir(), 'PortfolioKB')),
  version: versionSource(root, cfg.demo ? 'demo' : envName()),
  audit: cfg.demo ? undefined : fileAudit(join(data, 'audit.jsonl')),
  portfolio: () => (cfg.demo ? buildPanel(syntheticPortfolio()) : readPanel(portfolioPath)),
  feedbackProposals: cfg.demo ? undefined : () => listProposals({ dir: data }),
  feedbackNotes: cfg.demo ? undefined : () => listFeedback({ dir: data }),
  decideProposal: cfg.demo ? undefined : (i) => decide(i, { dir: data }),
  addFeedback: cfg.demo ? undefined : (input) => addFeedback(input, { dir: data }),
  admin: cfg.demo ? undefined : { token: fileTokenSource(join(root, 'infra', 'env'), process.env.COCKPIT_ADMIN_TOKEN), store: fileStore(join(data, 'cockpit-admin.json'), join(root, 'infra', 'env')) },
  identify: cfg.demo ? undefined : (req, admin) => resolveIdentity(req, whois, admin, people),
  groupOfBoard: (board) => cfg.layout.boards[board],
  openPath: cfg.demo ? undefined : (path) => { execFile('open', [path], () => {}); },
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
  saveAgentDoc: cfg.demo ? undefined : (id, file, text, base) => saveAgentDoc({ home: cfg.hermesHome, registryPath: cfg.agentsRegistry, id, file, text, base }),
  catalog: () => loadCatalogCached(registry().catalog.dir),
  invalidate: () => { current = undefined; },
});
// The automation after approval: every minute, move approved projects forward (ask pm to plan, apply a written plan, mark finished
// ones for review). Cheap when nothing is active: it only reads project files. The launchd job does the same every ten minutes.
let advancing = false;
if (!cfg.demo) setInterval(() => {
  if (advancing) return;   // a slow run (Hermes busy) must not pile up behind itself
  advancing = true;
  Promise.resolve(work(['advance', '--apply']))
    .then((r) => { if (/[+→✓]/.test(r.output)) current = undefined; })
    .catch((e) => console.error('advance failed', e))
    .finally(() => { advancing = false; });
}, 60_000).unref();

const server = createServer((req, res) => void app(req, res));

// A restart (launchctl kickstart) can start the new process before the old one has let go of the port: wait for it instead of crashing,
// which launchd would throttle into a ten-second outage.
let tries = 0;
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE' && tries++ < 40) { setTimeout(() => server.listen(cfg.port, cfg.host), 500); return; }
  throw e;
});
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
