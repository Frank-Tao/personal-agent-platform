// The Utility Portal (~/codes/utility-portal) is its own app and stays one. Its home page lists every tool as a card
// (`<a class="card" href="/tts"><h3>🎙 Voicebox TTS</h3>…`; the "More coming" placeholder is a <div class="card soon">, not a link).
// Cockpit reads that page so a tool added to the portal shows up in the sidebar by itself, with no change here.

export interface PortalTool { name: string; path: string }

const CARD = /<a\b[^>]*\bclass="card"[^>]*\bhref="(\/[^"]*)"[^>]*>\s*<h3>([\s\S]*?)<\/h3>/gi;
const TAGS = /<[^>]+>/g;
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** Tool cards on the portal home page. A leading emoji is dropped (the sidebar draws its own icon). */
export function parsePortalTools(html: string): PortalTool[] {
  const out: PortalTool[] = [];
  for (const m of html.matchAll(CARD)) {
    const name = m[2].replace(TAGS, '').replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]).replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (name && !out.some((t) => t.path === m[1])) out.push({ name, path: m[1] });
  }
  return out;
}

export interface PortalOpts {
  /** Where Cockpit (on this Mac) reads the portal from, e.g. http://127.0.0.1:8888 */
  url: string;
  /** What a browser opens; `{host}` = the page's hostname. */
  publicUrl: string;
  group: string;
  fetch?: typeof fetch;
  ttlMs?: number;
}

export type PortalLink = { name: string; url: string; group: string };

/** Portal tools as sidebar links. Cached; if the portal is down the last good list is kept (empty until the first success). */
export function portalLinks(opts: PortalOpts): () => Promise<PortalLink[]> {
  const doFetch = opts.fetch ?? fetch;
  const ttl = opts.ttlMs ?? 60_000;
  let cache: { at: number; links: PortalLink[] } | undefined;
  return async () => {
    if (cache && Date.now() - cache.at < ttl) return cache.links;
    try {
      const res = await doFetch(opts.url.replace(/\/$/, '') + '/', { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const base = opts.publicUrl.replace(/\/$/, '');
      cache = { at: Date.now(), links: parsePortalTools(await res.text()).map((t) => ({ name: t.name, url: base + t.path, group: opts.group })) };
    } catch {
      cache = { at: Date.now() - ttl + 10_000, links: cache?.links ?? [] };   // retry in ~10 s, meanwhile show what we last knew
    }
    return cache.links;
  };
}
