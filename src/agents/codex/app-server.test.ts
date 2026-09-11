import { describe, expect, test } from 'bun:test';
import { CodexAppServer } from './app-server.js';
import { createLogger } from '../../utils/logger.js';

describe('CodexAppServer', () => {
  test('a spawn failure reports the error and releases the running state', async () => {
    const rpc = new CodexAppServer(createLogger('test'), '/nonexistent/codex-binary');
    const errors: Error[] = [];
    const exits: Array<number | null> = [];
    rpc.onError = (e) => errors.push(e);
    rpc.onExit = (c) => exits.push(c);
    rpc.spawn('/tmp');
    const rejected = expect(rpc.request('initialize', {})).rejects.toThrow(/failed to start/);
    await Bun.sleep(30);
    expect(errors).toHaveLength(1);
    expect(rpc.isRunning()).toBe(false);
    expect(exits).toHaveLength(1);
    await rejected;
  });
});
