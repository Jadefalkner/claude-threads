import { ClaudeCli, type ClaudeCliOptions } from '../claude/cli.js';
import type { AgentBackend, AgentSession } from './types.js';
import { CodexSession } from './codex/session.js';

/**
 * Einzige Stelle, die ein Backend instanziiert. Alle Spawn-Pfade
 * (Start, Resume, !cd/!permissions-Neustart, Worktrees) laufen hierdurch.
 */
export function createAgentSession(backend: AgentBackend, options: ClaudeCliOptions): AgentSession {
  switch (backend) {
    case 'claude':
      return new ClaudeCli(options);
    case 'codex':
      return new CodexSession(options);
  }
}
