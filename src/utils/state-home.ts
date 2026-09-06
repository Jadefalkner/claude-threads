import { homedir } from 'os';

/**
 * Root under which claude-threads keeps its state (`~/.config/claude-threads`,
 * `~/.claude-threads`). Defaults to the user's home; `CLAUDE_THREADS_HOME`
 * overrides it so two bots (e.g. a Claude one and a Codex one) can run under
 * the same user without sharing config, sessions, logs or memory.
 */
export function stateHome(): string {
  return process.env.CLAUDE_THREADS_HOME || homedir();
}
