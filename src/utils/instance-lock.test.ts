import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireInstanceLock } from './instance-lock.js';
import { stateHome } from './state-home.js';

function withHome(fn: (lock: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'ct-lock-'));
  process.env.CLAUDE_THREADS_HOME = home;
  const lock = join(home, '.config', 'claude-threads', 'instance.lock');
  try {
    fn(lock);
  } finally {
    delete process.env.CLAUDE_THREADS_HOME;
  }
}

describe('acquireInstanceLock', () => {
  test('takes, refuses for a live pid, and takes over a dead pid', () => {
    withHome((lock) => {
      const release = acquireInstanceLock();
      expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
      release();
      expect(existsSync(lock)).toBe(false);
      mkdirSync(join(lock, '..'), { recursive: true });
      writeFileSync(lock, '999999999'); // dead pid
      acquireInstanceLock()();
      writeFileSync(lock, String(process.ppid)); // live pid
      expect(() => acquireInstanceLock()).toThrow(/already uses/);
    });
  });

  test('the holding process may re-acquire its own lock', () => {
    withHome((lock) => {
      acquireInstanceLock();
      acquireInstanceLock()(); // 'wx' fails on the existing file, own pid is not a foreign holder
      expect(existsSync(lock)).toBe(false);
    });
  });

  test('a holder displaced during the grace period loses, the replacer keeps the lock', () => {
    withHome((lock) => {
      // Simulate a stale-lock claimant that replaces the file while we wait.
      const replaced = `${lock}.other`;
      const timer = setTimeout(() => {}, 0); // keep the event loop alive during the sync wait
      mkdirSync(join(lock, '..'), { recursive: true });
      writeFileSync(replaced, String(process.ppid));
      // Our acquire links first, then sleeps GRACE_MS; the rename lands before it re-checks.
      const original = Atomics.wait;
      (Atomics as { wait: typeof Atomics.wait }).wait = ((...args: Parameters<typeof Atomics.wait>) => {
        renameSync(replaced, lock);
        return original(...args);
      }) as typeof Atomics.wait;
      try {
        expect(() => acquireInstanceLock()).toThrow(/won the start race/);
      } finally {
        (Atomics as { wait: typeof Atomics.wait }).wait = original;
        clearTimeout(timer);
      }
      expect(readFileSync(lock, 'utf8')).toBe(String(process.ppid));
      expect(existsSync(`${lock}.${process.pid}`)).toBe(false);
    });
  });

  test('resolves a relative CLAUDE_THREADS_HOME against cwd', () => {
    process.env.CLAUDE_THREADS_HOME = './rel-state-home';
    try {
      expect(stateHome()).toBe(join(process.cwd(), 'rel-state-home'));
    } finally {
      delete process.env.CLAUDE_THREADS_HOME;
    }
  });

  test('release does not remove a lock that a successor took over', () => {
    withHome((lock) => {
      const release = acquireInstanceLock();
      writeFileSync(lock, String(process.ppid)); // successor (live) overwrote it
      release();
      expect(readFileSync(lock, 'utf8')).toBe(String(process.ppid));
    });
  });
});
