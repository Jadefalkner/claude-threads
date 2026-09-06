/**
 * Lightweight one-shot queries to Claude CLI.
 *
 * Use cases:
 * - Branch name suggestions
 * - Commit message generation
 * - Quick classification tasks
 * - Any fast, non-interactive Claude query
 *
 * Uses -p (print) mode for single-response queries.
 * Defaults to haiku for speed/cost efficiency.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { readFileSync, unlinkSync } from 'fs';
import { crossSpawn } from '../utils/spawn.js';
import { getClaudePath } from './version-check.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('query');

export interface QuickQueryOptions {
  /** The prompt to send to Claude */
  prompt: string;

  /** Model to use: 'haiku' (fast/cheap), 'sonnet' (balanced), 'opus' (powerful) */
  model?: 'haiku' | 'sonnet' | 'opus';

  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;

  /** Working directory for context (optional) */
  workingDir?: string;

  /** System prompt override (optional) */
  systemPrompt?: string;
}

export interface QuickQueryResult {
  success: boolean;
  response?: string;
  error?: string;
  durationMs: number;
}

/**
 * Quick one-shot query to Claude CLI.
 *
 * Spawns `claude -p --model <model>` and waits for response.
 * Fails silently on errors (returns { success: false }).
 *
 * @example
 * const result = await quickQuery({
 *   prompt: 'Suggest 3 branch names for: "add dark mode"',
 *   model: 'haiku',
 *   timeout: 5000,
 * });
 * if (result.success) {
 *   console.log(result.response);
 * }
 */
/**
 * Which CLI answers one-shot helper queries (titles, branch names, routine
 * parses …). Set once at startup from `config.agentBackend`: a codex-only bot
 * must never spawn the Claude CLI, not even for a haiku one-shot.
 */
let quickQueryBackend: 'claude' | 'codex' = 'claude';
export function setQuickQueryBackend(backend: 'claude' | 'codex'): void {
  quickQueryBackend = backend;
}

export async function quickQuery(options: QuickQueryOptions): Promise<QuickQueryResult> {
  if (quickQueryBackend === 'codex') return codexQuickQuery(options);
  const {
    prompt,
    model = 'haiku',
    timeout = 5000,
    workingDir,
    systemPrompt,
  } = options;

  const startTime = Date.now();

  // getClaudePath, not a bare 'claude': it falls back to the common install
  // locations, so hosts where the CLI isn't on PATH (but sessions work via
  // the same resolution in cli.ts) don't have every haiku one-shot — routine
  // and watch parses, watch confirms, memory distillation — silently fail.
  const claudePath = getClaudePath();
  const args = ['-p', '--model', model];

  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }

  // The prompt travels over STDIN, not as an argv argument (`claude -p`
  // reads the prompt from stdin when no positional prompt is given —
  // verified against CLI 2.1.235). Long prompts (distillation feeds ~40KB:
  // existing memory + thread tail) would exceed Windows command-line limits
  // as argv (cmd.exe caps at 8,191 chars via the npm shim), silently killing
  // the spawn; stdin has no such cap.

  log.debug(`Quick query: model=${model}, timeout=${timeout}ms, prompt="${prompt.substring(0, 50)}..."`);

  return new Promise<QuickQueryResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const proc = crossSpawn(claudePath, args, {
      cwd: workingDir || process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Set up timeout
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGTERM');
        log.debug(`Quick query timed out after ${timeout}ms`);
        resolve({
          success: false,
          error: 'timeout',
          durationMs: Date.now() - startTime,
        });
      }
    }, timeout);

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        log.debug(`Quick query error: ${err.message}`);
        resolve({
          success: false,
          error: err.message,
          durationMs: Date.now() - startTime,
        });
      }
    });

    proc.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        const durationMs = Date.now() - startTime;

        if (code === 0 && stdout.trim()) {
          log.debug(`Quick query success: ${durationMs}ms, ${stdout.length} chars`);
          resolve({
            success: true,
            response: stdout.trim(),
            durationMs,
          });
        } else {
          log.debug(`Quick query failed: code=${code}, stderr=${stderr.substring(0, 100)}`);
          resolve({
            success: false,
            error: stderr || `exit code ${code}`,
            durationMs,
          });
        }
      }
    });

    // Write the prompt over stdin and close it so the CLI knows input ended.
    // The 'error' listener is load-bearing: a child that closes its stdin
    // while still alive makes this write raise EPIPE as a stream 'error'
    // event, and with no listener that is an uncaught exception that kills
    // the whole bot from paths documented as fire-and-forget (watch
    // confirms, distillation). Verified empirically: `spawn('bash', ['-c',
    // 'exec 0<&-; sleep 2'])` + a 1MB end() crashes node without this.
    // The call itself still fails safely (timeout/empty-output path).
    proc.stdin?.on('error', (err) => {
      log.debug(`quickQuery: stdin write failed (${(err as NodeJS.ErrnoException).code ?? err.message})`);
    });
    proc.stdin?.end(prompt);
  });
}

/**
 * Codex flavour of quickQuery: `codex exec --ephemeral` with the prompt on
 * stdin, the final message read from `-o <file>`. Model names are Codex's,
 * so the Claude `model` option is ignored (the user's default model applies).
 */
async function codexQuickQuery(options: QuickQueryOptions): Promise<QuickQueryResult> {
  const { prompt, workingDir, systemPrompt } = options;
  // codex exec needs ~6-7 s even for a one-word answer (measured 0.153.4);
  // callers tuned for haiku (5-15 s) would time out under load.
  const timeout = Math.max(options.timeout ?? 5000, 20000);
  const startTime = Date.now();
  const outFile = join(tmpdir(), `claude-threads-codex-qq-${randomUUID()}.txt`); // title+tags run concurrently
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-o', outFile, '--color', 'never'];
  const input = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
  log.debug(`Quick query (codex): timeout=${timeout}ms, prompt="${prompt.substring(0, 50)}..."`);
  return new Promise<QuickQueryResult>((resolve) => {
    let stderr = '';
    let resolved = false;
    const finish = (r: QuickQueryResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      try { unlinkSync(outFile); } catch { /* best-effort */ }
      resolve(r);
    };
    const proc = crossSpawn(process.env.CODEX_BIN ?? 'codex', args, {
      cwd: workingDir || process.cwd(),
      env: process.env,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM');
      finish({ success: false, error: 'timeout', durationMs: Date.now() - startTime });
    }, timeout);
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('error', (err) => finish({ success: false, error: err.message, durationMs: Date.now() - startTime }));
    proc.on('exit', (code) => {
      let response = '';
      try { response = readFileSync(outFile, 'utf8').trim(); } catch { /* no output file */ }
      const durationMs = Date.now() - startTime;
      if (code === 0 && response) finish({ success: true, response, durationMs });
      else finish({ success: false, error: `exit ${code}: ${stderr.trim().slice(-500)}`, durationMs });
    });
    proc.stdin?.on('error', (err) => {
      log.debug(`quickQuery (codex): stdin write failed (${(err as NodeJS.ErrnoException).code ?? err.message})`);
    });
    proc.stdin?.end(input);
  });
}
