/**
 * Backend-neutrale Sitzungsschnittstelle. ClaudeCli implementiert sie heute,
 * der Codex-App-Server-Adapter folgt (Umbaufolge Punkt 4).
 *
 * Die Event-Form bleibt vorerst Claudes stream-json (`ClaudeEvent`): der
 * Transformer und der Events-Handler verstehen sie bereits. Ein Codex-Adapter
 * uebersetzt seine Notifications in diese Form, statt beide Konsumenten
 * umzubauen.
 */
import type { ClaudeEvent, StatusLineData } from '../claude/cli.js';
import type { RateLimitHit } from '../claude/rate-limit-detector.js';

export type AgentBackend = 'claude' | 'codex';

/** Normalisiertes Ereignis. Vorerst identisch mit Claudes stream-json. */
export type AgentEvent = ClaudeEvent;

export interface AgentSession {
  readonly backend: AgentBackend;

  start(): void;
  sendMessage(content: string): void;
  /** Laufenden Turn abbrechen. true, wenn ein Signal gesendet wurde. */
  interrupt(): boolean;
  kill(): Promise<void>;

  isRunning(): boolean;
  isPermanentFailure(): boolean;
  getPermanentFailureReason(): string | null;
  getStatusData(): StatusLineData | null;
  /** Letzte stderr-Ausgabe des Prozesses, fuer Diagnose in Tests und Fehlermeldungen. */
  getLastStderr(): string;

  /**
   * Answer an `approval_request` event (Codex-only: approvals are in-process
   * server requests, not MCP prompts). Claude has no such path.
   */
  respondToApproval?(requestId: string, approved: boolean, allowAll?: boolean): void;

  /** Answer the backend's pending question set (Codex `item/tool/requestUserInput`). */
  respondToQuestion?(answers: Array<{ header: string; answer: string }>, toolUseId?: string): void;

  /**
   * Run a `!command` natively (compact, model, effort, context, cost …).
   * Returns the user-visible reply, or null when the backend has no native
   * implementation — the caller then falls back to the Claude slash passthrough.
   */
  runSlashCommand?(command: string, args?: string): Promise<string | null>;

  on(event: 'event', listener: (e: AgentEvent) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(event: 'rate-limit', listener: (hit: RateLimitHit) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'status', listener: (data: StatusLineData) => void): this;
}
