import { statSync } from 'node:fs';

// When does Atlas next look at the projects? Two loops matter for a new task:
//   1. the plan sync (`work advance`), run by Cockpit itself every minute (and by launchd every ten): it turns a changed plan into Hermes tasks;
//   2. Hermes' own dispatcher, which starts a ready task's worker about once a minute.
// A slower job (work-watch, every ten minutes) does the nudging and the watchdog. This is only the timing, so the page can show a clock instead of a guess.

export const ADVANCE_EVERY = 60;
export const WATCH_EVERY = 600;
export const DISPATCH_EVERY = 60;

export interface ScanState { lastStartAt: number | null; lastEndAt: number | null; running: boolean; note: string }
export interface ScanInfo {
  now: number;
  /** The plan sync inside Cockpit. `nextAt` is exact while Cockpit runs; `overdue` when it has not run for three intervals. */
  advance: { everySec: number; lastAt: number | null; nextAt: number | null; running: boolean; note: string; overdue: boolean };
  /** The launchd job (nudge, watchdog, digests): when its log was last written, and how often it runs. */
  watch: { everySec: number; lastAt: number | null };
  dispatcher: { everySec: number };
}

export function scanInfo(s: ScanState, startedAt: number, watchLogMtime: number | null, now = Date.now() / 1000): ScanInfo {
  const last = s.lastStartAt;
  const nextAt = last !== null ? last + ADVANCE_EVERY : startedAt + ADVANCE_EVERY;
  const reference = last ?? startedAt;
  return {
    now,
    advance: { everySec: ADVANCE_EVERY, lastAt: s.lastEndAt ?? last, nextAt: s.running ? null : Math.max(nextAt, now), running: s.running, note: s.note, overdue: now - reference > ADVANCE_EVERY * 3 && !s.running },
    watch: { everySec: WATCH_EVERY, lastAt: watchLogMtime },
    dispatcher: { everySec: DISPATCH_EVERY },
  };
}

export const mtimeSec = (path: string): number | null => { try { return statSync(path).mtimeMs / 1000; } catch { return null; } };
