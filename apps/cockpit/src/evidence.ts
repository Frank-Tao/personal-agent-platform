import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { maskSensitive } from './sources/agentDetail.ts';

// What a project left behind that a person can look at: the files its tasks attached (reports, evidence bundles, screenshots), found by themselves,
// and the screenshots inside the zip or tar bundles. Read-only. Nothing is opened except files in the board's own attachments folder.

const run = promisify(execFile);
export const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const ARCHIVE = /\.(zip|tar\.gz|tgz)$/i;
const MAX_IMAGE = 8 * 1024 * 1024, MAX_FILE = 40 * 1024 * 1024;
export const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', md: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8', json: 'application/json', log: 'text/plain; charset=utf-8', csv: 'text/csv', pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip' };

export interface EvidenceFile { task: string; taskTitle: string; board: string; name: string; size: number; kind: 'image' | 'archive' | 'file'; images: Array<{ entry: string; size: number }> }

const safeName = (n: string) => !!n && !n.includes('/') && !n.includes('\\') && !n.startsWith('.') && n.length <= 200;

async function archiveEntries(path: string, name: string): Promise<Array<{ entry: string; size: number }>> {
  try {
    const out = /\.zip$/i.test(name)
      ? (await run('unzip', ['-Z', '-l', path], { timeout: 6000, maxBuffer: 4_000_000 })).stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 10 && /^\d+$/.test(p[3])).map((p) => ({ entry: p.slice(9).join(' '), size: Number(p[3]) }))
      : (await run('tar', ['-tzvf', path], { timeout: 6000, maxBuffer: 4_000_000 })).stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 9 && /^\d+$/.test(p[4])).map((p) => ({ entry: p.slice(8).join(' '), size: Number(p[4]) }));
    return out.filter((e) => IMAGE.test(e.entry) && !e.entry.includes('..') && !e.entry.startsWith('/') && e.size <= MAX_IMAGE).slice(0, 30);
  } catch { return []; }
}

/** Every attachment on a project's tasks (tasks are found by their tenant = the project id), across boards. Titles are masked. */
export async function gatherEvidence(hermesHome: string, project: string, boardsAllowed: (board: string) => boolean): Promise<EvidenceFile[]> {
  const boardsDir = join(hermesHome, 'kanban', 'boards');
  let boards: string[] = [];
  try { boards = readdirSync(boardsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name); } catch { return []; }
  const out: EvidenceFile[] = [];
  for (const board of boards.filter(boardsAllowed)) {
    const db = join(boardsDir, board, 'kanban.db');
    if (!existsSync(db)) continue;
    let tasks: Array<{ id: string; title: string }> = [];
    let h: DatabaseSync | undefined;
    try { h = new DatabaseSync(db, { readOnly: true }); tasks = h.prepare('SELECT id, title FROM tasks WHERE tenant = ?').all(project) as typeof tasks; } catch { continue; } finally { h?.close(); }
    for (const t of tasks) {
      const dir = join(boardsDir, board, 'attachments', t.id);
      let names: string[] = [];
      try { names = readdirSync(dir).filter(safeName); } catch { continue; }
      for (const name of names) {
        let size = 0; try { const s = statSync(join(dir, name)); if (!s.isFile()) continue; size = s.size; } catch { continue; }
        const kind = IMAGE.test(name) ? 'image' : ARCHIVE.test(name) ? 'archive' : 'file';
        out.push({ task: t.id, taskTitle: maskSensitive(t.title).slice(0, 120), board, name, size, kind, images: kind === 'archive' && size <= MAX_FILE ? await archiveEntries(join(dir, name), name) : [] });
      }
    }
  }
  return out.sort((a, b) => b.images.length - a.images.length || a.task.localeCompare(b.task) || a.name.localeCompare(b.name)).slice(0, 80);
}

export interface AttachmentRead { type: string; body: Buffer; inline: boolean; filename: string }

/** One attachment, or one screenshot inside an archive attachment. Only names that really are in the folder (or in the archive listing) are served. */
export async function readAttachment(hermesHome: string, board: string, task: string, name: string, entry?: string): Promise<AttachmentRead | null> {
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(board) || !/^t_[0-9a-f]{4,16}$/.test(task) || !safeName(name)) return null;
  const dir = join(hermesHome, 'kanban', 'boards', board, 'attachments', task);
  let names: string[] = [];
  try { names = readdirSync(dir).filter(safeName); } catch { return null; }
  if (!names.includes(name)) return null;
  const path = join(dir, name);
  let size = 0; try { const s = statSync(path); if (!s.isFile()) return null; size = s.size; } catch { return null; }
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  if (entry) {
    if (!ARCHIVE.test(name) || size > MAX_FILE || !IMAGE.test(entry)) return null;
    const known = await archiveEntries(path, name);
    if (!known.some((e) => e.entry === entry)) return null;
    try {
      const r = /\.zip$/i.test(name) ? await run('unzip', ['-p', path, entry], { encoding: 'buffer', maxBuffer: MAX_IMAGE + 1024, timeout: 8000 }) : await run('tar', ['-xzOf', path, entry], { encoding: 'buffer', maxBuffer: MAX_IMAGE + 1024, timeout: 8000 });
      const e = (entry.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
      return { type: TYPES[e] ?? 'application/octet-stream', body: r.stdout as unknown as Buffer, inline: true, filename: entry.split('/').pop() ?? 'image' };
    } catch { return null; }
  }
  if (size > MAX_FILE) return null;
  const { readFileSync } = await import('node:fs');
  return { type: TYPES[ext] ?? 'application/octet-stream', body: readFileSync(path), inline: IMAGE.test(name), filename: name };
}
