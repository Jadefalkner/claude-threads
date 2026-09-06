import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { stateHome } from './state-home.js';

/** Exit status for "another instance holds this state directory": the daemon wrapper never restarts on it. */
export const LOCKED_EXIT_CODE = 3;

/**
 * How long a new holder waits before confirming the lock is still its own.
 * A stale-lock claimant replaces the lock a few microseconds after reading
 * the dead pid; anyone it displaced notices within this grace period.
 * ponytail: a claimant stalled between read and rename for longer than this
 * (SIGSTOP, VM pause) can still displace a live holder; flock() if it ever matters
 */
const GRACE_MS = 50;

/**
 * One bot process per state directory. Two instances sharing
 * ~/.config/claude-threads would race on sessions.json and each other's
 * uploads; a stale lock (dead pid) is taken over.
 *
 * No process ever unlinks another's lock. The pid is written to a private
 * temp file and link()ed onto the lock path — EEXIST means someone holds it,
 * and the lock never exists without content. A stale lock is replaced with
 * rename(), which is atomic; because a replacement could in principle hit a
 * lock that was itself just acquired, every acquirer re-checks after
 * GRACE_MS that the lock path still resolves to its own inode and gives up
 * otherwise. Of any number of simultaneous starters, exactly one survives.
 * Returns a release function; throws when another live process holds the lock.
 */
export function acquireInstanceLock(): () => void {
  const path = join(stateHome(), '.config', 'claude-threads', 'instance.lock');
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, String(process.pid));
  try {
    const ino = statSync(tmp).ino;
    if (!tryLink(tmp, path)) {
      const pid = readPid(path);
      if (pid === process.pid) return () => release(path);
      if (pid && isAlive(pid)) {
        throw new Error(`another claude-threads instance (pid ${pid}) already uses ${dirname(path)} — set CLAUDE_THREADS_HOME to run a second bot`);
      }
      // Dead holder, or the file vanished between link and read: take over.
      renameSync(tmp, path);
    }
    sleepMs(GRACE_MS);
    if (statSync(path).ino !== ino) {
      throw new Error(`another claude-threads instance won the start race for ${dirname(path)} — set CLAUDE_THREADS_HOME to run a second bot`);
    }
    return () => release(path);
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed away or already gone */ }
  }
}

/** link() the temp file onto the lock path; false when a lock already exists. */
function tryLink(tmp: string, path: string): boolean {
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
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
