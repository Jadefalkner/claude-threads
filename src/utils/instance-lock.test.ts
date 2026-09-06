import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
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

  test('recovers from a takeover mutex abandoned by a crashed claimant', () => {
    withHome((lock) => {
      mkdirSync(join(lock, '..'), { recursive: true });
      writeFileSync(lock, '999999999'); // stale lock
      writeFileSync(`${lock}.takeover`, '999999998'); // dead claimant crashed mid-takeover
      const release = acquireInstanceLock();
      expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
      expect(existsSync(`${lock}.takeover`)).toBe(false);
      release();
    });
  });

  test('a live claimant holding the takeover mutex blocks reclamation', () => {
    withHome((lock) => {
      mkdirSync(join(lock, '..'), { recursive: true });
      writeFileSync(lock, '999999999'); // stale lock
      writeFileSync(`${lock}.takeover`, String(process.ppid)); // live claimant mid-takeover
      expect(() => acquireInstanceLock()).toThrow(/lost the race/);
      expect(readFileSync(lock, 'utf8')).toBe('999999999');
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
