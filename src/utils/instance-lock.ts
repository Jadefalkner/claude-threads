import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { stateHome } from './state-home.js';

/**
 * One bot process per state directory. Two instances sharing
 * ~/.config/claude-threads would race on sessions.json and each other's
 * uploads; a stale lock (dead pid) is taken over.
 *
 * Without flock() in the runtime, exclusivity comes from two atomic
 * primitives: the pid is written to a private temp file and link()ed onto
 * the lock path (fails with EEXIST if a lock exists; the lock file therefore
 * never exists without content), and a stale lock is claimed by rename()ing
 * it aside — only one of several concurrent claimants gets the rename, the
 * others see ENOENT and go round again, where they either win the link or
 * find the winner's live pid.
 * Returns a release function; throws when another live process holds the lock.
 */
export function acquireInstanceLock(): () => void {
  const path = join(stateHome(), '.config', 'claude-threads', 'instance.lock');
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, String(process.pid));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, path);
        return () => release(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const pid = readPid(path);
      if (pid === process.pid) return () => release(path);
      if (pid && isAlive(pid)) {
        throw new Error(`another claude-threads instance (pid ${pid}) already uses ${dirname(path)} — set CLAUDE_THREADS_HOME to run a second bot`);
      }
      // Dead holder (or the file vanished between link and read): claim it.
      try {
        renameSync(path, `${path}.stale`);
        unlinkSync(`${path}.stale`);
      } catch { /* another claimant got there first; retry the link */ }
    }
    throw new Error(`could not acquire ${path}: lost the race three times`);
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Only remove the lock while it still carries our pid — never a successor's. */
function release(path: string): void {
  try {
    if (readPid(path) === process.pid) unlinkSync(path);
  } catch { /* already gone */ }
}

function readPid(path: string): number | undefined {
  try { return Number(readFileSync(path, 'utf8').trim()) || undefined; } catch { return undefined; }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}
