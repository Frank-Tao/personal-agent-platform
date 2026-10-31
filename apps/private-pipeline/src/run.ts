import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { assertNoPii } from '../../../packages/redact/redact.ts';
import { extractFromText, validateExtraction, type Extraction } from './extract.ts';
import { summarize } from './summarize.ts';

// Runs as the private macOS user. Reads ~/Private/inbox, keeps extraction state in ~/Private/state.json
// (numbers only), and writes the PII-gated summary to ~/PrivateSummaries/personal.json.
//
// File naming convention: <account-alias>-<anything>.txt|csv|md  e.g. checking-2026-09.txt
// The alias comes from the file name (chosen by you), never from document contents.

const home = process.env.PRIVATE_HOME ?? join(homedir(), 'Private');
const inbox = join(home, 'inbox');
const processed = join(inbox, 'processed');
const statePath = join(home, 'state.json');
const summariesDir = process.env.PRIVATE_SUMMARIES_DIR ?? join(homedir(), 'PrivateSummaries');
const model = process.env.PRIVATE_MODEL ?? 'qwen3.8:27b';
const ollamaUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const pollSeconds = Number(process.env.PIPELINE_POLL_SECONDS ?? 60);
const nextTaxDue = process.env.NEXT_ESTIMATED_TAX_DUE || undefined;
const SUPPORTED = new Set(['.txt', '.csv', '.md']);

type State = Record<string, Array<Extraction & { file: string }>>;

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(statePath, 'utf8')) as State;
  } catch {
    return {};
  }
}

export function aliasFor(file: string): string {
  const stem = basename(file, extname(file));
  const alias = stem.split(/[-_ ]/)[0].toLowerCase().replace(/[^a-z]/g, '');
  if (!alias) throw new Error('file name must start with an account alias, e.g. checking-2026-09.txt');
  return alias;
}

async function writeSummary(state: State): Promise<void> {
  const summary = summarize(state, { nextEstimatedTaxDue: nextTaxDue });
  assertNoPii(summary, 'personal summary'); // fail closed: nothing is written if anything looks like PII
  await mkdir(summariesDir, { recursive: true });
  const tmp = join(summariesDir, '.personal.json.tmp');
  await writeFile(tmp, JSON.stringify(summary, null, 2), { mode: 0o644 });
  await rename(tmp, join(summariesDir, 'personal.json'));
}

async function tick(): Promise<void> {
  await mkdir(processed, { recursive: true });
  const files = (await readdir(inbox, { withFileTypes: true }))
    .filter((d) => d.isFile() && SUPPORTED.has(extname(d.name).toLowerCase()))
    .map((d) => d.name);
  if (files.length === 0) return;

  const state = await loadState();
  for (const file of files) {
    try {
      const alias = aliasFor(file);
      const text = await readFile(join(inbox, file), 'utf8');
      const e = validateExtraction(await extractFromText(text, { url: ollamaUrl, model }));
      const list = (state[alias] ??= []).filter((x) => x.periodEnd !== e.periodEnd);
      list.push({ ...e, file });
      state[alias] = list;
      await rename(join(inbox, file), join(processed, file));
      console.log(`processed ${alias} ${e.periodEnd}`); // no amounts in logs
    } catch (err) {
      console.error(`skipped ${file}: ${(err as Error).message}`);
    }
  }
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  await writeSummary(state);
}

if (import.meta.main) {
  console.log(`private-pipeline: model=${model} inbox=${inbox}`);
  await mkdir(inbox, { recursive: true });
  const loop = async () => {
    try {
      await tick();
    } catch (err) {
      console.error(`tick failed: ${(err as Error).message}`);
    }
  };
  await loop();
  if (!process.argv.includes('--once')) setInterval(() => void loop(), pollSeconds * 1000);
}
