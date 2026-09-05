import { describe, expect, test } from 'bun:test';
import { createAgentSession } from './factory.js';
import { ClaudeCli } from '../claude/cli.js';

const opts = { workingDir: '/test', memory: null, agentFeatures: null };

describe('createAgentSession', () => {
  test('claude returns a ClaudeCli tagged with its backend', () => {
    const agent = createAgentSession('claude', opts);
    expect(agent).toBeInstanceOf(ClaudeCli);
    expect(agent.backend).toBe('claude');
    expect(agent.isRunning()).toBe(false);
  });

  test('codex returns a CodexSession that is not running until started', () => {
    const agent = createAgentSession('codex', opts);
    expect(agent.backend).toBe('codex');
    expect(agent.isRunning()).toBe(false);
    expect(agent.interrupt()).toBe(false);
  });
});
