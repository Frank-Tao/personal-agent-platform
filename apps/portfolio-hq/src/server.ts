import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { buildBrief } from './brief.ts';
import { buildRollup, collect } from './rollup.ts';
import { Store } from './store.ts';
import { paperclipSource } from './sources/paperclip.ts';
import { fileCardsSource } from './sources/fileCards.ts';
import { demoSource } from './sources/demo.ts';
import type { Rollup, Source } from './types.ts';

const cfg = loadConfig();
const store = new Store(cfg.demo ? ':memory:' : cfg.dbPath);

const sources: Source[] = cfg.demo
  ? [demoSource]
  : [
      paperclipSource({ baseUrl: cfg.paperclipUrl, token: cfg.paperclipToken }),
      fileCardsSource(cfg.privateSummariesDir, 'private'),
      fileCardsSource(cfg.manualKpiDir, 'manual'),
    ];

let current: Rollup | undefined = store.latest();
let refreshing: Promise<Rollup> | undefined;

function refresh(): Promise<Rollup> {
  // Coalesce concurrent callers into one collection run.
  refreshing ??= (async () => {
    try {
      const { cards, errors } = await collect(sources);
      current = buildRollup(cards, errors);
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (status: number, type: string, body: string) => {
    res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
    res.end(body);
  };
  try {
    if (req.method !== 'GET') return send(405, 'text/plain', 'method not allowed');
    switch (url.pathname) {
      case '/':
        return send(200, 'text/html', await readFile(join(publicDir, 'index.html'), 'utf8'));
      case '/healthz':
        return send(200, 'text/plain', 'ok');
      case '/api/rollup':
        return send(200, 'application/json', JSON.stringify(url.searchParams.has('fresh') ? await refresh() : await getRollup()));
      case '/api/brief':
        return send(200, 'text/markdown', buildBrief(await getRollup()));
      case '/api/history':
        return send(200, 'application/json', JSON.stringify(store.history(Number(url.searchParams.get('days') ?? 30))));
      default:
        return send(404, 'text/plain', 'not found');
    }
  } catch (e) {
    console.error(e);
    send(500, 'text/plain', 'internal error');
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`portfolio-hq on http://${cfg.host}:${cfg.port}${cfg.demo ? ' (demo data)' : ''}`);
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
