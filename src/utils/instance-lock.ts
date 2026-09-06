import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { stateHome } from './state-home.js';

/** Exit status for "another instance holds this state directory": the daemon wrapper never restarts on it. */
export const LOCKED_EXIT_CODE = 3;

/**
 * One bot process per state directory. Two instances sharing
 * ~/.config/claude-threads would race on sessions.json and each other's
 * uploads; a stale lock (dead pid) is taken over.
 *
 * Without flock() in the runtime, exclusivity comes from atomic filesystem
 * primitives: the pid is written to a private temp file and link()ed onto
 * the lock path (fails with EEXIST if a lock exists; the lock file therefore
 * never exists without content), and stale-lock removal is serialized
 * through a second O_EXCL file so only one claimant inspects-and-removes,
 * re-reading the lock under that mutex — a lock another claimant already
 * replaced with its live pid is never removed.
 * Returns a release function; throws when another live process holds the lock.
 */
export function acquireInstanceLock(): () => void {
  const path = join(stateHome(), '.config', 'claude-threads', 'instance.lock');
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, String(process.pid));
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
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
      reclaimStale(path, pid);
      sleepMs(20); // let a concurrent claimant finish its takeover before we look again
    }
    throw new Error(`could not acquire ${path}: lost the race five times`);
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/**
 * Remove a stale lock, but only while it still holds the dead pid we saw:
 * under the takeover mutex the lock is re-read, so a claimant that read the
 * dead pid early cannot remove the live lock a faster claimant put there.
 */
function reclaimStale(path: string, seenPid: number | undefined): void {
  const mutex = `${path}.takeover`;
  try {
    writeFileSync(mutex, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Another claimant is mid-takeover; the caller retries the link. A mutex
    // older than a few seconds is left over from a crash inside that window.
    // ponytail: mtime heuristic, the window is microseconds; flock() if it ever matters
    try { if (Date.now() - statSync(mutex).mtimeMs > 5000) unlinkSync(mutex); } catch { /* gone */ }
    return;
  }
  try {
    if (readPid(path) === seenPid) unlinkSync(path);
  } catch { /* already gone */ } finally {
    try { unlinkSync(mutex); } catch { /* already gone */ }
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

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
