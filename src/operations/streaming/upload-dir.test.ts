import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { getSessionUploadDir } from './handler.js';
describe('upload dir instance prefix', () => {
  test('default instance keeps the legacy path', () => {
    delete process.env.CLAUDE_THREADS_HOME;
    expect(getSessionUploadDir('p', 't')).toBe(join(tmpdir(), 'claude-threads-uploads', 'p-t'));
  });
  test('overriding instance gets a hash prefix, single segment', () => {
    process.env.CLAUDE_THREADS_HOME = '/x/y';
    try {
      const d = getSessionUploadDir('p', 't');
      expect(d).toMatch(/claude-threads-uploads\/[0-9a-f]{12}-p-t$/);
    } finally { delete process.env.CLAUDE_THREADS_HOME; }
  });
});
