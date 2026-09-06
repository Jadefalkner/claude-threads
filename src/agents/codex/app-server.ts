/**
 * Minimal JSON-RPC client for `codex app-server` over stdio.
 *
 * Wire format (verified against codex-cli 0.153.4, see prototypes/codex-app-server.ts):
 * newline-delimited JSON, no `jsonrpc` field. Requests carry `id`+`method`,
 * responses `id`+`result|error`, notifications `method` only, and server→client
 * requests (approvals) carry `id`+`method` and expect a response with that id.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import type { Logger } from '../../utils/logger.js';

export type Json = Record<string, unknown>;
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Pinned protocol version: types were generated from this CLI version. */
export const CODEX_PROTOCOL_VERSION = '0.153.4';

export class CodexAppServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderrBuffer = '';

  onNotification: (method: string, params: Json) => void = () => {};
  onServerRequest: (method: string, params: Json) => Promise<unknown> = async () => ({});
  onExit: (code: number | null) => void = () => {};
  onError: (err: Error) => void = () => {};

  constructor(private readonly log: Logger, private readonly bin = process.env.CODEX_BIN ?? 'codex') {}

  spawn(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
    if (this.proc) throw new Error('Already running');
    const proc = spawn(this.bin, ['app-server', '--listen', 'stdio://'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    createInterface({ input: proc.stdout }).on('line', (line) => this.handle(line));
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrBuffer = (this.stderrBuffer + text).slice(-8192);
      this.log.debug(`stderr: ${text.trim()}`);
    });
    let finished = false;
    const finish = (code: number | null, reason: string) => {
      if (finished) return;
      finished = true;
      this.proc = null;
      for (const p of this.pending.values()) p.reject(new Error(`codex app-server ${reason}`));
      this.pending.clear();
      this.onExit(code);
    };
    proc.on('error', (err) => {
      this.onError(err);
      // A spawn failure (ENOENT …) may never emit 'exit': release the running
      // state here so the session is not left looking alive.
      if (proc.exitCode === null && !proc.pid) finish(null, `failed to start: ${err.message}`);
    });
    proc.on('exit', (code) => finish(code, `exited (${code})`));
  }

  isRunning(): boolean { return this.proc !== null; }
  get pid(): number | undefined { return this.proc?.pid; }
  getLastStderr(): string { return this.stderrBuffer; }

  /** SIGTERM, escalating to SIGKILL when the process ignores it. */
  kill(graceMs = 5000): void {
    const proc = this.proc;
    if (!proc) return;
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (this.proc === proc) {
        this.log.warn(`codex app-server ignored SIGTERM for ${graceMs}ms → SIGKILL`);
        proc.kill('SIGKILL');
      }
    }, graceMs).unref();
  }

  /**
   * Send a request. Every response is expected promptly — even turn/start
   * only acknowledges the turn — so a missing reply means a wedged server.
   */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = 60000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (!this.proc) return reject(new Error('codex app-server not running'));
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); (resolve as (v: unknown) => void)(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void { this.write({ method, params }); }

  private write(msg: Json): void {
    this.proc?.stdin.write(JSON.stringify(msg) + '\n');
  }

  private handle(line: string): void {
    if (!line.trim()) return;
    let msg: Json;
    try { msg = JSON.parse(line) as Json; } catch { this.log.debug(`non-JSON line: ${line.slice(0, 200)}`); return; }
    const { id, method, params, result, error } = msg as {
      id?: number; method?: string; params?: Json; result?: unknown; error?: { message?: string };
    };
    if (method && id !== undefined) {
      this.onServerRequest(method, params ?? {})
        .then((r) => this.write({ id, result: r }))
        .catch((e) => this.write({ id, error: { code: -32000, message: String(e) } }));
    } else if (method) {
      this.onNotification(method, params ?? {});
    } else if (id !== undefined) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error.message ?? JSON.stringify(error)));
      else p.resolve(result);
    }
  }
}
