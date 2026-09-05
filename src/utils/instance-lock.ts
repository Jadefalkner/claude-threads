import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { stateHome } from './state-home.js';

/**
 * One bot process per state directory. Two instances sharing
 * ~/.config/claude-threads would race on sessions.json and each other's
 * uploads; a stale lock (dead pid) is taken over silently.
 * Returns a release function; throws when another live process holds the lock.
 */
export function acquireInstanceLock(): () => void {
  const path = join(stateHome(), '.config', 'claude-threads', 'instance.lock');
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (pid && pid !== process.pid && isAlive(pid)) {
      throw new Error(`another claude-threads instance (pid ${pid}) already uses ${dirname(path)} — set CLAUDE_THREADS_HOME to run a second bot`);
    }
  }
  writeFileSync(path, String(process.pid));
  return () => { try { unlinkSync(path); } catch { /* already gone */ } };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}
