import { crossSpawnSync } from '../../utils/spawn.js';
import { CODEX_PROTOCOL_VERSION } from './app-server.js';

/** Run the CLI; returns stdout on exit 0, throws otherwise (covers .cmd wrappers on Windows). */
function run(bin: string, args: string[]): string {
  const r = crossSpawnSync(bin, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${String(r.stderr).trim()}`);
  return String(r.stdout);
}

export interface CodexValidationResult {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  message: string;
}

/**
 * Startup check for the Codex backend: CLI present, version reported, login
 * state. The app-server protocol is experimental upstream, so a version
 * other than the pinned one only warns — the bindings were generated from
 * CODEX_PROTOCOL_VERSION and may drift.
 */
export function validateCodexCli(bin = process.env.CODEX_BIN ?? 'codex'): CodexValidationResult {
  let version: string;
  try {
    version = run(bin, ['--version']).trim().replace(/^codex-cli\s+/, '');
  } catch (err) {
    return { installed: false, version: null, loggedIn: false, message: `Codex CLI not found (${bin}): ${String(err).split('\n')[0]}` };
  }
  let loggedIn = false;
  try {
    run(bin, ['login', 'status']);
    loggedIn = true;
  } catch { /* non-zero exit = not logged in */ }
  const drift = version !== CODEX_PROTOCOL_VERSION ? ` (protocol bindings pinned to ${CODEX_PROTOCOL_VERSION})` : '';
  return {
    installed: true, version, loggedIn,
    message: loggedIn ? `Codex CLI ${version}${drift}` : `Codex CLI ${version} is not logged in — run \`codex login\`${drift}`,
  };
}
