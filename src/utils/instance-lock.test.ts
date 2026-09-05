import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireInstanceLock } from './instance-lock.js';

describe('acquireInstanceLock', () => {
  test('takes, refuses for a live pid, and takes over a dead pid', () => {
    const home = mkdtempSync(join(tmpdir(), 'ct-lock-'));
    process.env.CLAUDE_THREADS_HOME = home;
    try {
      const release = acquireInstanceLock();
      const lock = join(home, '.config', 'claude-threads', 'instance.lock');
      expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
      release();
      mkdirSync(join(home, '.config', 'claude-threads'), { recursive: true });
      writeFileSync(lock, '999999999'); // dead pid
      acquireInstanceLock()();
      writeFileSync(lock, String(process.ppid)); // live pid
      expect(() => acquireInstanceLock()).toThrow(/already uses/);
    } finally {
      delete process.env.CLAUDE_THREADS_HOME;
    }
  });
});
