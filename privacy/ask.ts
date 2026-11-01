import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { findPii, redact } from '../packages/redact/redact.ts';
import { privacyCheck } from '../packages/redact/topics.ts';

// The Personal Privacy agent as a function. A private question never reaches a cloud model: it goes to the local-only Hermes profile
// `personal` (Ollama), and whatever comes back passes the deterministic PII filter before anyone else sees it. Only kinds and counts are
// logged (data/privacy.jsonl), never text.
//
//   npm run privacy -- ask --stdin [--via atlas]      question on stdin, redacted answer on stdout
//   npm run privacy -- check --stdin                  would this message be handled privately? (exit 0 = yes)

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

export interface PrivacyAnswer { answer: string; masked: number; reasons: string[]; ms: number }
export type Ask = (text: string) => Promise<string>;

export const WRAP = (q: string) => `You are the Personal Privacy agent. Frank's chief of staff handed you a private question. Answer it using only what you know locally and what the question says.
Rules: never repeat account numbers, card numbers, tax or ID numbers, full street addresses, phone numbers, emails, or other people's full names. Use totals, ranges, percentages and conclusions. Keep it short and plain.

QUESTION:
${q}`;

/** The real runner: `hermes -p personal -z`, local model only, two minutes at most. */
export function hermesAsk(hermesBin = process.env.HERMES_BIN ?? join(homedir(), '.local', 'bin', 'hermes'), profile = 'personal'): Ask {
  return async (text) => (await exec(hermesBin, ['-p', profile, '-z', WRAP(text)], { timeout: 120_000, maxBuffer: 4_000_000 })).stdout.trim();
}

export async function askPersonalPrivacy(ask: Ask, text: string, log?: (line: object) => void, via = 'cockpit'): Promise<PrivacyAnswer> {
  const t0 = Date.now();
  const verdict = privacyCheck(text);
  const raw = await ask(text);
  if (!raw) throw new Error('the Personal Privacy agent returned nothing');
  const masked = findPii(raw).length;
  const answer = redact(raw);
  const ms = Date.now() - t0;
  log?.({ at: new Date().toISOString(), via, reasons: verdict.reasons, masked, ms });
  return { answer, masked, reasons: verdict.reasons, ms };
}

export const fileLog = (path: string) => (line: object) => { try { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, JSON.stringify(line) + '\n'); } catch { /* logging must never break an answer */ } };

async function readStdin(): Promise<string> { let s = ''; for await (const c of process.stdin) s += c; return s.trim(); }

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
  const text = rest.includes('--stdin') ? await readStdin() : flag('text') ?? '';
  if (!text) { console.error('usage: privacy ask|check --stdin   (question on stdin)'); return 2; }
  if (cmd === 'check') { const v = privacyCheck(text); console.log(JSON.stringify(v)); return v.private ? 0 : 1; }
  if (cmd !== 'ask') { console.error('usage: privacy ask|check --stdin'); return 2; }
  try {
    const r = await askPersonalPrivacy(hermesAsk(), text, fileLog(join(root, 'data', 'privacy.jsonl')), flag('via') ?? 'atlas');
    console.log(r.answer);
    console.error(`[handled locally by Personal Privacy${r.masked ? `; ${r.masked} detail${r.masked === 1 ? '' : 's'} masked` : ''}]`);
    return 0;
  } catch (e) {
    console.error(`Personal Privacy could not answer: ${(e as Error).message.split('\n')[0]}. Nothing was sent to a cloud model.`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) process.exit(await main(process.argv.slice(2)));
