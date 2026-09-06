import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { stateHome } from './state-home.js';

/**
 * One bot process per state directory. Two instances sharing
 * ~/.config/claude-threads would race on sessions.json and each other's
 * uploads; a stale lock (dead pid) is taken over.
 *
 * Creation is atomic (O_EXCL): two processes starting at once cannot both
 * win — the loser sees EEXIST, reads the winner's pid and refuses.
 * Returns a release function; throws when another live process holds the lock.
 */
export function acquireInstanceLock(): () => void {
  const path = join(stateHome(), '.config', 'claude-threads', 'instance.lock');
  mkdirSync(dirname(path), { recursive: true });
  // Two attempts: the second one runs after a stale lock was unlinked.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      return () => release(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const pid = readPid(path);
    if (pid && pid !== process.pid && isAlive(pid)) {
      throw new Error(`another claude-threads instance (pid ${pid}) already uses ${dirname(path)} — set CLAUDE_THREADS_HOME to run a second bot`);
    }
    try { unlinkSync(path); } catch { /* someone else removed it first */ }
  }
  throw new Error(`could not acquire ${path}: lost the race twice`);
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
