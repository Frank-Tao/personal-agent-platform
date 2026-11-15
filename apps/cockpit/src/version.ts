import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Which Cockpit is this? prod (the clone of main under ~/services), dev (a working copy on some branch) or demo (fake data).
// `loadedSha` is the commit the code was at when this process started; `headSha` is the commit on disk now. They differ when the files
// were updated but the process was not restarted yet, which the page shows as "restart pending".

const run = promisify(execFile);

export interface VersionInfo {
  env: 'prod' | 'dev' | 'demo';
  branch: string | null;
  loadedSha: string | null;
  headSha: string | null;
  /** Tracked files changed in the working tree (a dev copy mid-edit). */
  dirty: boolean;
  startedAt: string;
  restartPending: boolean;
}

const git = async (root: string, args: string[]): Promise<string | null> => {
  try { return (await run('git', ['-C', root, ...args], { timeout: 3000 })).stdout.trim(); } catch { return null; }
};

export function versionSource(root: string, env: VersionInfo['env'], now: () => Date = () => new Date()): () => Promise<VersionInfo> {
  const startedAt = now().toISOString();
  const loaded = git(root, ['rev-parse', '--short', 'HEAD']);
  let cache: { at: number; value: VersionInfo } | undefined;
  return async () => {
    if (cache && Date.now() - cache.at < 5000) return cache.value;
    const [loadedSha, headSha, branch, status] = await Promise.all([loaded, git(root, ['rev-parse', '--short', 'HEAD']), git(root, ['branch', '--show-current']), git(root, ['status', '--porcelain', '--untracked-files=no'])]);
    const value: VersionInfo = { env, branch: branch || null, loadedSha, headSha, dirty: !!status, startedAt, restartPending: !!loadedSha && !!headSha && loadedSha !== headSha };
    cache = { at: Date.now(), value };
    return value;
  };
}
