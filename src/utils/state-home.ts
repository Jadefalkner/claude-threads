import { homedir } from 'os';
import { resolve } from 'path';

/**
 * Root under which claude-threads keeps its state (`~/.config/claude-threads`,
 * `~/.claude-threads`). Defaults to the user's home; `CLAUDE_THREADS_HOME`
 * overrides it so two bots (e.g. one per platform) can run under the same
 * user without sharing config, sessions, logs or memory. Always absolute:
 * a relative override would otherwise mean different things to the bot and
 * to the git subprocesses it spawns.
 */
export function stateHome(): string {
  return resolve(process.env.CLAUDE_THREADS_HOME || homedir());
}

/** True when the state root was overridden (a second instance, not the default one). */
export function hasStateHomeOverride(): boolean {
  return Boolean(process.env.CLAUDE_THREADS_HOME);
}
