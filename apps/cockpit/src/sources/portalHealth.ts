import type { NeedsYou, Source } from '../types.ts';

// The Utility Portal is a separate app that launchd keeps running (com.franktao.pap.utility-portal). If it is down, the sidebar group
// just goes empty, which looks like a bug in Cockpit. So when it stops answering, say so in Needs-you, with what to do.
// A restart after a crash takes about 20 seconds, so one failed check is not enough: it must fail on two checks in a row.

export const FAILS_BEFORE_ALERT = 2;

export function portalDownNeed(url: string): NeedsYou {
  return {
    portfolioId: 'atlas', kind: 'alert', severity: 'warn',
    title: `Utility Portal is not answering at ${url}: restart it with launchctl kickstart -k gui/$(id -u)/com.franktao.pap.utility-portal (log: ~/Library/Logs/pap/utility-portal.error.log)`,
  };
}

export function portalHealthSource(url: string, doFetch: typeof fetch = fetch): Source {
  let fails = 0;
  return async () => {
    try {
      const res = await doFetch(url.replace(/\/$/, '') + '/', { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      fails = 0;
    } catch {
      fails++;
    }
    return { cards: [], errors: [], needs: fails >= FAILS_BEFORE_ALERT ? [portalDownNeed(url)] : [] };
  };
}
