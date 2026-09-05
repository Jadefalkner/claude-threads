/**
 * Codex backend: drives one `codex app-server` process per bot session and
 * translates its notifications into Claude stream-json shaped events so the
 * existing transformer / events handler render them unchanged.
 *
 * Emitted event shapes (subset of what ClaudeCli produces):
 *   system/init            {type:'system', subtype:'init', model, session_id}
 *   assistant text         {type:'assistant', message:{content:[{type:'text'}]}}
 *   assistant tool_use     {type:'assistant', message:{content:[{type:'tool_use', id, name, input}]}}
 *   user tool_result       {type:'user', message:{content:[{type:'tool_result', tool_use_id, content, is_error}]}}
 *   result                 {type:'result', subtype:'success'|'error', is_error, session_id, ...}
 *   approval_request       {type:'approval_request', request_id, tool_name, content}  (Codex-only)
 *   system/error           {type:'system', subtype:'error', error}
 *
 * ponytail: one process per session, no reconnect; account pool (HOME override)
 * ignored — Codex uses ~/.codex of the bot user. Add when a second Codex login
 * is needed.
 */
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import {
  buildMcpServerDefinition, resolveMcpServerPath, MCP_SERVER_NAME,
  type ClaudeCliOptions, type ClaudeEvent, type StatusLineData,
} from '../../claude/cli.js';
import type { AgentSession } from '../types.js';
import { createLogger } from '../../utils/logger.js';
import { CodexAppServer, type Json } from './app-server.js';

type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline';

interface ActiveTurn { threadId: string; turnId: string }

/** Backend-specific guidance appended to the bot's system prompt. */
const CODEX_DEVELOPER_NOTES = [
  'Images you generate are posted into the chat automatically as soon as they are saved.',
  'Do not copy generated images anywhere and do not call send_file for them; just describe the result briefly.',
].join(' ');

const POLICY: Record<string, { approvalPolicy: string; sandbox: string }> = {
  default: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  bypass: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
};

/**
 * "… try again at Sep 6th, 2026 12:28 AM." → epoch ms (local time), or
 * undefined when the phrase is absent or unparsable. Ordinal suffixes break
 * Date.parse, so they are stripped first.
 */
export function parseCodexResetAt(message: string): number | undefined {
  const when = /try again at ([^.]+)\./i.exec(message)?.[1];
  if (!when) return undefined;
  const ts = Date.parse(when.replace(/(\d+)(st|nd|rd|th)/, '$1'));
  return Number.isFinite(ts) ? ts : undefined;
}

/**
 * Image attachments arrive in the prompt as the streaming handler's file
 * list ("- /abs/path (image/png, 12 KB)"). Codex can take them natively as
 * `localImage` inputs, so pull those paths out; the text keeps the list so
 * non-image files stay discoverable by path.
 */
export function extractImagePaths(content: string): string[] {
  if (!content.startsWith('[Attached files from chat')) return [];
  const paths: string[] = [];
  for (const line of content.split('\n')) {
    if (line === '') break; // end of the file list block
    const m = /^- (\/.+) \(image\/[^,)]+, /.exec(line);
    if (m) paths.push(m[1]);
  }
  return paths;
}

/** MCP results are a content envelope; show the text blocks, not the JSON wrapper. */
function mcpResultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  if (Array.isArray(content)) {
    const text = content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
    if (text) return text;
  }
  return result === undefined || result === null ? '' : JSON.stringify(result);
}

export class CodexSession extends EventEmitter implements AgentSession {
  readonly backend = 'codex' as const;
  private readonly log;
  private readonly rpc: CodexAppServer;
  private threadId: string | null = null;
  private model = 'codex';
  private ready: Promise<void> | null = null;
  private activeTurn: ActiveTurn | null = null;
  private turnText = '';
  private turnStartedAt = 0;
  private status: StatusLineData | null = null;
  private permanentFailure: string | null = null;
  private pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
  // ponytail: one approval prompt at a time — the approval executor holds a
  // single pendingApproval slot. Parallel tool calls queue here; widen the
  // executor before removing this.
  private approvalQueue: Promise<unknown> = Promise.resolve();
  private pendingQuestion: {
    id: string;
    questions: Array<{ id: string; header: string }>;
    resolve: (answers: Record<string, { answers: string[] }>) => void;
  } | null = null;
  private effort: string | null = null;
  /** Set by an allow-all (✅) decision: no more prompts this session. */
  private sessionApproved = false;
  private killRequested = false;
  /** Bumped on interrupt / turn end: prompts queued for an older epoch resolve as declined unseen. */
  private turnEpoch = 0;

  constructor(private readonly options: ClaudeCliOptions) {
    super();
    this.log = options.logSessionId
      ? createLogger('codex').forSession(options.logSessionId)
      : createLogger('codex');
    this.rpc = new CodexAppServer(this.log);
    this.rpc.onNotification = (m, p) => this.handleNotification(m, p);
    this.rpc.onServerRequest = (m, p) => this.handleServerRequest(m, p);
    this.rpc.onExit = (code) => {
      this.activeTurn = null;
      this.closeOpenPrompts('process exit');
      // A kill we asked for is a clean exit. Claude exits 0 on SIGINT; the
      // app-server dies by SIGTERM (code null), and lifecycle counts every
      // non-zero exit of a resumed session as a resume failure — three bot
      // restarts would silently drop the session.
      this.emit('exit', this.killRequested ? 0 : code);
    };
    this.rpc.onError = (err) => {
      this.log.error(`codex error: ${err}`);
      this.emit('error', err);
    };
  }

  // ---- AgentSession -------------------------------------------------------

  start(): void {
    this.rpc.spawn(this.options.workingDir);
    this.log.debug(`codex app-server spawned: pid=${this.rpc.pid}`);
    this.ready = this.openThread().catch((err) => {
      // A failed thread/start or thread/resume is fatal for this process:
      // surface it like a CLI that exited non-zero so lifecycle's resume
      // accounting (resumeFailCount) keeps working.
      this.log.error(`codex thread open failed: ${err}`);
      this.emitEvent({ type: 'system', subtype: 'error', error: String(err) });
      this.rpc.kill();
      throw err;
    });
  }

  sendMessage(content: string): void {
    if (!this.ready) throw new Error('Not started');
    void this.ready.then(async () => {
      if (!this.threadId) return;
      await this.rpc.request('turn/start', {
        threadId: this.threadId,
        input: [
          { type: 'text', text: content, text_elements: [] },
          ...extractImagePaths(content).map((path) => ({ type: 'localImage', path })),
        ],
        model: this.model,
        effort: this.effort,
      });
    }).catch((err) => {
      // The chat is in "processing" from the moment the user posted; a
      // rejected turn/start must close that state like a failed turn.
      this.log.error(`turn/start failed: ${err}`);
      const message = err instanceof Error ? err.message : String(err);
      this.emitEvent({ type: 'system', subtype: 'error', error: message });
      this.emitEvent({ type: 'result', subtype: 'error_turn_start', is_error: true, result: message, duration_ms: 0, num_turns: 0, session_id: this.threadId });
    });
  }

  interrupt(): boolean {
    const turn = this.activeTurn;
    if (!turn) return false;
    // Nothing waits for a decision on an aborted turn: close open prompts now
    // (their posts resolve as denied via approval_timeout) instead of after
    // the permission timeout.
    this.closeOpenPrompts('interrupt');
    void this.rpc.request('turn/interrupt', turn).catch((err) => this.log.debug(`turn/interrupt failed: ${err}`));
    return true;
  }

  async kill(): Promise<void> {
    if (!this.rpc.isRunning()) return;
    this.killRequested = true;
    await new Promise<void>((resolve) => {
      const prev = this.rpc.onExit;
      this.rpc.onExit = (code) => { prev(code); resolve(); };
      this.rpc.kill();
      setTimeout(resolve, 5000).unref();
    });
  }

  isRunning(): boolean { return this.rpc.isRunning(); }
  isPermanentFailure(): boolean { return this.permanentFailure !== null; }
  getPermanentFailureReason(): string | null { return this.permanentFailure; }
  getStatusData(): StatusLineData | null { return this.status; }
  getLastStderr(): string { return this.rpc.getLastStderr(); }

  /** Feed the user's decision for an `approval_request` event back to Codex. */
  respondToApproval(requestId: string, approved: boolean, allowAll = false): void {
    const resolve = this.pendingApprovals.get(requestId);
    if (!resolve) return;
    this.pendingApprovals.delete(requestId);
    if (approved && allowAll) this.sessionApproved = true;
    resolve(!approved ? 'decline' : allowAll ? 'acceptForSession' : 'accept');
  }

  /** Feed the user's answers (keyed by question header) back to Codex. */
  respondToQuestion(answers: Array<{ header: string; answer: string }>, toolUseId?: string): void {
    const pending = this.pendingQuestion;
    if (!pending) return;
    if (toolUseId && toolUseId !== pending.id) {
      this.log.debug(`ignoring answers for ${toolUseId}: pending question set is ${pending.id}`);
      return;
    }
    this.pendingQuestion = null;
    const byId: Record<string, { answers: string[] }> = {};
    for (const a of answers) {
      const q = pending.questions.find((x) => x.header === a.header);
      if (q) byId[q.id] = { answers: [a.answer] };
    }
    pending.resolve(byId);
  }

  // ---- Codex → Claude-shaped events ---------------------------------------

  private async openThread(): Promise<void> {
    await this.rpc.request('initialize', {
      clientInfo: { name: 'claude-threads', title: 'claude-threads', version: '0' },
      capabilities: null,
    }, 30000);
    this.rpc.notify('initialized');

    const mode = this.options.permissionMode ?? 'default';
    const common = {
      cwd: this.options.workingDir,
      ...POLICY[mode],
      developerInstructions: [this.options.appendSystemPrompt, CODEX_DEVELOPER_NOTES].filter(Boolean).join('\n\n'),
      config: this.threadConfig(),
    };
    const resume = this.options.resume && this.options.sessionId;
    const r = resume
      ? await this.rpc.request<{ thread: Json; model: string }>('thread/resume', {
          threadId: this.options.sessionId, ...common, excludeTurns: true,
        }, 30000)
      : await this.rpc.request<{ thread: Json; model: string }>('thread/start', common, 30000);
    this.threadId = String(r.thread.id);
    this.model = r.model;
    this.log.info(`codex thread ${resume ? 'resumed' : 'started'}: ${this.threadId} (${this.model})`);
    this.emitEvent({ type: 'system', subtype: 'init', model: this.model, session_id: this.threadId, slash_commands: [] });
  }

  /**
   * Per-thread config overrides. The bot's own MCP server rides along so
   * Codex gets send_file / read_post / react_to_post / agent actions — the
   * same tools Claude has. Its permission_prompt tool stays unused: Codex
   * approvals are server requests handled in-process (see askUser).
   */
  private threadConfig(): Record<string, unknown> | null {
    const o = this.options;
    if (!o.platformConfig) return null;
    const def = buildMcpServerDefinition({
      mcpServerPath: resolveMcpServerPath(),
      platformConfig: o.platformConfig,
      threadId: o.threadId,
      permissionTimeoutMs: o.permissionTimeoutMs ?? 120000,
      debug: Boolean(process.env.DEBUG),
      workingDir: o.workingDir,
      uploadDir: o.uploadDir,
      outboundFiles: o.outboundFiles,
      sessionOwnerUsername: o.sessionOwnerUsername,
      decisionBridgePath: o.decisionBridgePath,
      agentFeatures: o.agentFeatures,
    });
    return { mcp_servers: { [MCP_SERVER_NAME]: def } };
  }

  private emitEvent(event: ClaudeEvent): void { this.emit('event', event); }

  private assistant(block: Json): void {
    this.emitEvent({ type: 'assistant', session_id: this.threadId, message: { role: 'assistant', content: [block] } });
  }

  private toolResult(toolUseId: string, content: string, isError: boolean): void {
    this.emitEvent({
      type: 'user', session_id: this.threadId,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
    });
  }

  private handleNotification(method: string, p: Json): void {
    switch (method) {
      case 'turn/started': {
        const turn = p.turn as Json;
        this.activeTurn = { threadId: String(p.threadId), turnId: String(turn.id) };
        this.turnText = '';
        this.turnStartedAt = Date.now();
        return;
      }
      case 'item/started':
        return this.handleItem(p.item as Json, false);
      case 'item/completed':
        return this.handleItem(p.item as Json, true);
      case 'turn/completed': {
        const turn = p.turn as Json;
        const error = turn.error as { message?: string } | null;
        this.activeTurn = null;
        this.closeOpenPrompts('turn completed');
        this.emitEvent({
          type: 'result',
          subtype: turn.status === 'completed' ? 'success' : `error_${turn.status}`,
          is_error: turn.status === 'failed',
          result: error?.message ?? this.turnText,
          duration_ms: Date.now() - this.turnStartedAt,
          num_turns: 1,
          session_id: this.threadId,
        });
        return;
      }
      case 'thread/tokenUsage/updated': {
        const usage = p.tokenUsage as { total: Json; last: Json; modelContextWindow: number | null };
        const total = usage.total as Record<string, number>;
        const last = usage.last as Record<string, number>;
        this.status = {
          context_window_size: usage.modelContextWindow ?? 0,
          total_input_tokens: total.inputTokens,
          total_output_tokens: total.outputTokens,
          current_usage: {
            input_tokens: last.inputTokens,
            output_tokens: last.outputTokens,
            cache_creation_input_tokens: last.cacheWriteInputTokens,
            cache_read_input_tokens: last.cachedInputTokens,
          },
          model: { id: this.model, display_name: this.model },
          cost: null,
          timestamp: Date.now(),
        };
        this.emit('status', this.status);
        return;
      }
      case 'error': {
        const err = p.error as { message?: string; codexErrorInfo?: unknown } | undefined;
        const message = err?.message ?? 'unknown codex error';
        const info = typeof err?.codexErrorInfo === 'string' ? err.codexErrorInfo : JSON.stringify(err?.codexErrorInfo ?? null);
        this.log.error(`codex error (willRetry=${String(p.willRetry)}, ${info}): ${message}`);
        // Auth problems need a human (`codex login`): flag them permanent so
        // lifecycle stops retrying resumes, and say so in the chat.
        if (/unauthori|log ?in|sign in|refresh token|access token|auth/i.test(message)) this.permanentFailure = message;
        if (!p.willRetry) {
          // A failed turn otherwise ends silently in the chat (result events
          // carry no visible text): surface the reason as agent text.
          this.assistant({ type: 'text', text: `❌ Codex: ${message}` });
        }
        // "You've hit your usage limit ... try again at Sep 6th, 2026 12:28 AM."
        // (codex 0.153.4, ChatGPT plan). Same cooldown path as Claude's detector.
        if (err?.codexErrorInfo === 'usageLimitExceeded' || /usage limit/i.test(message)) {
          const resetAt = parseCodexResetAt(message);
          this.emit('rate-limit', { detected: true, matched: message, ...(resetAt ? { resetAtEpochMs: resetAt } : {}) });
        }
        if (!p.willRetry) this.emitEvent({ type: 'system', subtype: 'error', error: message });
        return;
      }
      default:
        return;
    }
  }

  private handleItem(item: Json, completed: boolean): void {
    const id = String(item.id);
    switch (item.type) {
      case 'agentMessage':
        // Claude emits whole messages, not deltas — mirror that on completion.
        if (completed && typeof item.text === 'string' && item.text) {
          this.turnText += item.text;
          this.assistant({ type: 'text', text: item.text });
        }
        return;
      case 'reasoning':
        if (completed) {
          const summary = (item.summary as string[] | undefined)?.join('\n');
          if (summary) this.assistant({ type: 'thinking', thinking: summary });
        }
        return;
      case 'commandExecution':
        if (!completed) {
          this.assistant({ type: 'tool_use', id, name: 'Bash', input: { command: item.command, description: undefined } });
        } else if (item.status !== 'declined') {
          this.toolResult(id, String(item.aggregatedOutput ?? ''), item.exitCode !== 0 && item.exitCode !== null);
        } else {
          this.toolResult(id, 'Command declined by user', true);
        }
        return;
      case 'fileChange': {
        const changes = (item.changes as Array<{ path: string; kind: unknown; diff: string }>) ?? [];
        if (!completed) {
          for (const c of changes) {
            this.assistant({ type: 'tool_use', id: `${id}:${c.path}`, name: 'Edit', input: { file_path: c.path, old_string: '', new_string: c.diff } });
          }
        } else {
          for (const c of changes) this.toolResult(`${id}:${c.path}`, String(item.status), item.status === 'failed' || item.status === 'declined');
        }
        return;
      }
      case 'mcpToolCall':
        if (!completed) {
          this.assistant({ type: 'tool_use', id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} });
        } else {
          const err = item.error as { message?: string } | null;
          this.toolResult(id, err?.message ?? mcpResultText(item.result), Boolean(err));
        }
        return;
      case 'webSearch':
        if (!completed) this.assistant({ type: 'server_tool_use', id, name: 'web_search', input: { query: item.query } });
        return;
      case 'imageGeneration': {
        // Codex saves generated images under $CODEX_HOME/generated_images.
        // Surface the call like a tool and hand the file to the bot for
        // upload (events handler: 'agent_file') — no send_file round trip.
        if (!completed) {
          this.assistant({ type: 'tool_use', id, name: 'ImageGeneration', input: { prompt: item.revisedPrompt ?? '' } });
          return;
        }
        const failure = item.failure as { message?: string } | null;
        const savedPath = typeof item.savedPath === 'string' ? item.savedPath : null;
        this.toolResult(id, failure?.message ?? (savedPath ? `saved ${savedPath}` : String(item.status)), Boolean(failure));
        if (savedPath && !failure) {
          this.emitEvent({ type: 'agent_file', path: savedPath, session_id: this.threadId });
        }
        return;
      }
      default:
        return;
    }
  }

  // ---- Approvals (server → client requests) -------------------------------

  private async handleServerRequest(method: string, p: Json): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const decision = await this.askUser('Bash', `\`${String(p.command ?? '')}\`` + (p.reason ? `\n${String(p.reason)}` : ''));
        return { decision };
      }
      case 'item/fileChange/requestApproval': {
        const decision = await this.askUser('Edit', `File changes${p.reason ? `: ${String(p.reason)}` : ''}${p.grantRoot ? ` under ${String(p.grantRoot)}` : ''}`);
        return { decision };
      }
      case 'item/permissions/requestApproval': {
        const perms = p.permissions as { network?: unknown; fileSystem?: unknown } | undefined;
        const wants = [perms?.network && 'network access', perms?.fileSystem && 'extra file-system access'].filter(Boolean).join(', ');
        const decision = await this.askUser('Permissions', `${wants || 'additional permissions'}${p.reason ? `: ${String(p.reason)}` : ''}`);
        return decision === 'decline'
          ? { permissions: {}, scope: 'turn' }
          : { permissions: perms ?? {}, scope: decision === 'acceptForSession' ? 'session' : 'turn' };
      }
      case 'item/tool/requestUserInput':
        return this.askQuestions(p);
      case 'mcpServer/elicitation/request':
        return this.handleElicitation(p);
      default:
        this.log.warn(`unhandled codex server request ${method} → decline`);
        return { decision: 'decline' };
    }
  }

  /**
   * Codex asks for MCP tool calls via an elicitation form with
   * `_meta.codex_approval_kind === 'mcp_tool_call'` (verified 0.153.4). The
   * bot's own MCP server is trusted without a prompt — same as the Claude
   * path, where our tools bypass permission_prompt (send_dm prompts itself).
   * Other servers' tools go through the normal approval UI. Real elicitation
   * forms/URL logins have no chat UI yet → decline.
   */
  private async handleElicitation(p: Json): Promise<unknown> {
    const meta = p._meta as {
      codex_approval_kind?: string;
      tool_params_display?: Array<{ display_name: string; value: unknown }>;
    } | null;
    if (p.mode !== 'form' || meta?.codex_approval_kind !== 'mcp_tool_call') {
      this.log.warn(`elicitation (${String(p.mode)}) from ${String(p.serverName)} has no chat UI → decline`);
      return { action: 'decline', content: null, _meta: null };
    }
    const tool = /run tool "([^"]+)"/.exec(String(p.message ?? ''))?.[1] ?? 'tool';
    let decision: ApprovalDecision = 'accept';
    if (p.serverName !== MCP_SERVER_NAME) {
      const params = (meta.tool_params_display ?? []).map((x) => `${x.display_name}: ${String(x.value)}`).join(', ');
      decision = await this.askUser(`MCP ${String(p.serverName)}/${tool}`, params || String(p.message));
    }
    if (decision === 'decline') return { action: 'decline', content: null, _meta: null };
    return { action: 'accept', content: {}, _meta: decision === 'acceptForSession' ? { persist: 'session' } : null };
  }

  private askUser(toolName: string, content: string): Promise<ApprovalDecision> {
    if (this.sessionApproved || (this.options.permissionMode ?? 'default') === 'bypass') {
      return Promise.resolve('accept');
    }
    const epoch = this.turnEpoch;
    const run = () => new Promise<ApprovalDecision>((resolve) => {
      if (epoch !== this.turnEpoch) { resolve('decline'); return; } // turn was interrupted meanwhile
      const requestId = randomUUID();
      const timeoutMs = this.options.permissionTimeoutMs ?? 120000;
      const timer = setTimeout(() => {
        if (!this.pendingApprovals.delete(requestId)) return;
        this.log.info(`approval ${requestId} timed out after ${timeoutMs}ms → decline`);
        this.emitEvent({ type: 'approval_timeout', request_id: requestId, session_id: this.threadId });
        resolve('decline');
      }, timeoutMs);
      this.pendingApprovals.set(requestId, (d) => { clearTimeout(timer); resolve(d); });
      this.emitEvent({ type: 'approval_request', request_id: requestId, tool_name: toolName, content, session_id: this.threadId });
    });
    const next = this.approvalQueue.then(run, run);
    this.approvalQueue = next;
    return next;
  }

  // ---- Native !commands ---------------------------------------------------

  async runSlashCommand(command: string, args?: string): Promise<string | null> {
    switch (command) {
      case 'compact':
        if (!this.threadId) return 'Not started yet.';
        await this.rpc.request('thread/compact/start', { threadId: this.threadId });
        return 'Compacting conversation context…';
      case 'model':
        if (args) { this.model = args; return `Model set to \`${args}\` for the next turns.`; }
        return `Current model: \`${this.model}\``;
      case 'effort':
        if (args) { this.effort = args; return `Reasoning effort set to \`${args}\` for the next turns.`; }
        return `Current reasoning effort: \`${this.effort ?? 'default'}\``;
      case 'context':
      case 'cost': {
        const s = this.status;
        if (!s) return 'No usage data yet.';
        const pct = s.context_window_size ? Math.round(100 * (s.current_usage?.input_tokens ?? 0) / s.context_window_size) : 0;
        return `Context: ${s.current_usage?.input_tokens ?? 0}/${s.context_window_size} tokens (${pct}%) · total in ${s.total_input_tokens}, out ${s.total_output_tokens} · model ${s.model?.id}`;
      }
      default:
        return null;
    }
  }

  /**
   * Codex questions ride the AskUserQuestion UI: a synthetic tool_use renders
   * the numbered options, lifecycle's 'question:complete' feeds
   * respondToQuestion. One set at a time (the executor has one slot).
   */
  private askQuestions(p: Json): Promise<{ answers: Record<string, { answers: string[] }> }> {
    const raw = (p.questions as Array<{ id: string; header: string; question: string; options: Array<{ label: string; description: string }> | null }>) ?? [];
    if (this.pendingQuestion) this.closeOpenPrompts('question replaced');
    return new Promise((resolve) => {
      const timeoutMs = (p.autoResolutionMs as number | null) ?? this.options.permissionTimeoutMs ?? 120000;
      const setId = `q-${randomUUID()}`;
      const pending = {
        id: setId,
        questions: raw.map((q) => ({ id: q.id, header: q.header })),
        resolve: (answers: Record<string, { answers: string[] }>) => { clearTimeout(timer); resolve({ answers }); },
      };
      const timer = setTimeout(() => {
        if (this.pendingQuestion !== pending) return;
        this.pendingQuestion = null;
        this.log.info('question set timed out → empty answers');
        this.emitEvent({ type: 'question_timeout', request_id: setId, session_id: this.threadId });
        resolve({ answers: {} });
      }, timeoutMs);
      this.pendingQuestion = pending;
      this.assistant({
        type: 'tool_use', id: setId, name: 'AskUserQuestion',
        input: {
          questions: raw.map((q) => ({
            header: q.header, question: q.question, multiSelect: false,
            options: q.options?.length ? q.options : [{ label: 'OK', description: 'Continue' }],
          })),
        },
      });
    });
  }

  /**
   * Single exit for every open prompt (approvals and the question set):
   * decline / empty-answer them, tell the bot to close their posts, and
   * invalidate queued prompts of the current turn. Used by interrupt, turn
   * end, question replacement and process exit alike.
   */
  private closeOpenPrompts(reason: string): void {
    this.turnEpoch++;
    const open = this.pendingApprovals.size + (this.pendingQuestion ? 1 : 0);
    for (const [requestId, resolve] of this.pendingApprovals) {
      this.emitEvent({ type: 'approval_timeout', request_id: requestId, session_id: this.threadId });
      resolve('decline');
    }
    this.pendingApprovals.clear();
    const question = this.pendingQuestion;
    if (question) {
      this.pendingQuestion = null;
      this.emitEvent({ type: 'question_timeout', request_id: question.id, session_id: this.threadId });
      question.resolve({});
    }
    if (open) this.log.debug(`${open} open prompt(s) closed: ${reason}`);
  }
}
