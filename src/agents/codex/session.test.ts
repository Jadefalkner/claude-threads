import { describe, expect, test } from 'bun:test';
import { parseCodexResetAt } from './session.js';

describe('parseCodexResetAt', () => {
  test('parses the codex usage-limit phrase incl. ordinal suffix', () => {
    const msg = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 6th, 2026 12:28 AM.";
    expect(parseCodexResetAt(msg)).toBe(Date.parse('Sep 6, 2026 12:28 AM'));
  });
  test('returns undefined without a reset phrase', () => {
    expect(parseCodexResetAt('You have hit your usage limit.')).toBeUndefined();
  });
});

import { CodexSession, extractImagePaths } from './session.js';
import type { ClaudeEvent } from '../../claude/cli.js';

// Drives the private server-request path without spawning codex.
function harness(permissionTimeoutMs?: number) {
  const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null, permissionTimeoutMs });
  const events: ClaudeEvent[] = [];
  agent.on('event', (e: ClaudeEvent) => events.push(e));
  const ask = (command: string) =>
    (agent as unknown as { handleServerRequest(m: string, p: Record<string, unknown>): Promise<{ decision: string }> })
      .handleServerRequest('item/commandExecution/requestApproval', { command });
  return { agent, events, ask };
}

describe('CodexSession approvals', () => {
  test('serializes prompts: second approval_request only after the first is decided', async () => {
    const { agent, events, ask } = harness();
    const first = ask('ls');
    const second = ask('pwd');
    await Bun.sleep(0);
    const requests = () => events.filter((e) => e.type === 'approval_request');
    expect(requests()).toHaveLength(1);
    agent.respondToApproval(String(requests()[0].request_id), true);
    expect(await first).toEqual({ decision: 'accept' });
    await Bun.sleep(0);
    expect(requests()).toHaveLength(2);
    agent.respondToApproval(String(requests()[1].request_id), false);
    expect(await second).toEqual({ decision: 'decline' });
  });

  test('times out into decline + approval_timeout; a late answer is a no-op', async () => {
    const { agent, events, ask } = harness(20);
    const pending = ask('rm -rf /');
    expect(await pending).toEqual({ decision: 'decline' });
    const timeout = events.find((e) => e.type === 'approval_timeout');
    const request = events.find((e) => e.type === 'approval_request');
    expect(timeout?.request_id).toBe(request?.request_id);
    agent.respondToApproval(String(request?.request_id), true); // must not throw or re-resolve
  });

  test('allow-all answers acceptForSession and silences later prompts', async () => {
    const { agent, events, ask } = harness();
    const first = ask('ls');
    await Bun.sleep(0);
    agent.respondToApproval(String(events[0].request_id), true, true);
    expect(await first).toEqual({ decision: 'acceptForSession' });
    expect(await ask('pwd')).toEqual({ decision: 'accept' });
    expect(events.filter((e) => e.type === 'approval_request')).toHaveLength(1);
  });

  test('interrupt declines open prompts and closes their posts', async () => {
    const { agent, events, ask } = harness();
    (agent as unknown as { activeTurn: unknown }).activeTurn = { threadId: 't', turnId: 'u' };
    const pending = ask('sleep 60');
    await Bun.sleep(0);
    expect(agent.interrupt()).toBe(true);
    expect(await pending).toEqual({ decision: 'decline' });
    const request = events.find((e) => e.type === 'approval_request');
    expect(events.find((e) => e.type === 'approval_timeout')?.request_id).toBe(request?.request_id);
  });

  test('bypass mode auto-accepts without prompting', async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null, permissionMode: 'bypass' });
    const events: ClaudeEvent[] = [];
    agent.on('event', (e: ClaudeEvent) => events.push(e));
    const r = await (agent as unknown as { handleServerRequest(m: string, p: Record<string, unknown>): Promise<unknown> })
      .handleServerRequest('item/commandExecution/requestApproval', { command: 'ls' });
    expect(r).toEqual({ decision: 'accept' });
    expect(events).toHaveLength(0);
  });
});

describe('extractImagePaths', () => {
  test('picks image paths out of the attachment header block only', () => {
    const content = [
      '[Attached files from chat — saved to disk, use Read or move/copy as needed:]',
      '- /tmp/up/a.png (image/png, 12 KB)',
      '- /tmp/up/notes.pdf (application/pdf, 1 MB)',
      '- /tmp/up/b.jpg (image/jpeg, 3 KB)',
      '',
      'Look at this: - /not/a/file.png (image/png, 1 KB)',
    ].join('\n');
    expect(extractImagePaths(content)).toEqual(['/tmp/up/a.png', '/tmp/up/b.jpg']);
  });
  test('returns nothing for plain text', () => {
    expect(extractImagePaths('hello')).toEqual([]);
  });
});

describe('CodexSession questions and permissions', () => {
  const call = (agent: CodexSession, method: string, params: Record<string, unknown>) =>
    (agent as unknown as { handleServerRequest(m: string, p: Record<string, unknown>): Promise<unknown> }).handleServerRequest(method, params);

  test('requestUserInput renders AskUserQuestion and maps answers header → id', async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const events: ClaudeEvent[] = [];
    agent.on('event', (e: ClaudeEvent) => events.push(e));
    const pending = call(agent, 'item/tool/requestUserInput', {
      questions: [
        { id: 'q1', header: 'Branch', question: 'Which branch?', isOther: false, isSecret: false, options: [{ label: 'main', description: '' }, { label: 'dev', description: '' }] },
        { id: 'q2', header: 'Confirm', question: 'Go ahead?', isOther: false, isSecret: false, options: null },
      ],
      isBlocking: true, autoResolutionMs: null,
    });
    await Bun.sleep(0);
    const toolUse = (events[0].message as { content: Array<{ name: string; input: { questions: Array<{ header: string; options: unknown[] }> } }> }).content[0];
    expect(toolUse.name).toBe('AskUserQuestion');
    expect(toolUse.input.questions.map((q) => q.header)).toEqual(['Branch', 'Confirm']);
    expect(toolUse.input.questions[1].options).toHaveLength(1); // fallback option for option-less questions
    agent.respondToQuestion([{ header: 'Branch', answer: 'dev' }, { header: 'Confirm', answer: 'OK' }]);
    expect(await pending).toEqual({ answers: { q1: { answers: ['dev'] }, q2: { answers: ['OK'] } } });
  });

  test('permissions approval grants the requested profile for the turn, or nothing on decline', async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const events: ClaudeEvent[] = [];
    agent.on('event', (e: ClaudeEvent) => events.push(e));
    const perms = { network: { allowAll: true }, fileSystem: null };
    const p1 = call(agent, 'item/permissions/requestApproval', { permissions: perms, reason: 'curl' });
    await Bun.sleep(0);
    agent.respondToApproval(String(events[0].request_id), true);
    expect(await p1).toEqual({ permissions: perms, scope: 'turn' });
    const p2 = call(agent, 'item/permissions/requestApproval', { permissions: perms });
    await Bun.sleep(0);
    agent.respondToApproval(String(events[1].request_id), false);
    expect(await p2).toEqual({ permissions: {}, scope: 'turn' });
  });
});

describe('CodexSession item translation', () => {
  const drive = () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const events: ClaudeEvent[] = [];
    agent.on('event', (e: ClaudeEvent) => events.push(e));
    const n = (agent as unknown as { handleNotification(m: string, p: Record<string, unknown>): void });
    return { events, notify: (m: string, p: Record<string, unknown>) => n.handleNotification(m, p) };
  };
  const blocks = (e: ClaudeEvent) => (e.message as { content: Array<Record<string, unknown>> }).content;

  test('commandExecution → Bash tool_use + tool_result with exit-code error flag', () => {
    const { events, notify } = drive();
    notify('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'ls', status: 'inProgress' } });
    notify('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed', aggregatedOutput: 'a\nb', exitCode: 2 } });
    expect(events[0].type).toBe('assistant');
    expect(blocks(events[0])[0]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } });
    expect(events[1].type).toBe('user');
    expect(blocks(events[1])[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', content: 'a\nb', is_error: true });
  });

  test('declined command → error tool_result, no crash on missing output', () => {
    const { events, notify } = drive();
    notify('item/completed', { item: { type: 'commandExecution', id: 'c2', command: 'rm', status: 'declined', aggregatedOutput: null, exitCode: null } });
    expect(blocks(events[0])[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c2', is_error: true });
  });

  test('fileChange → one Edit per path, mcpToolCall → mcp__server__tool, reasoning → thinking', () => {
    const { events, notify } = drive();
    notify('item/started', { item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: '/x/a.ts', kind: 'update', diff: '+1' }, { path: '/x/b.ts', kind: 'add', diff: '+2' }] } });
    notify('item/completed', { item: { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: '/x/a.ts', kind: 'update', diff: '+1' }, { path: '/x/b.ts', kind: 'add', diff: '+2' }] } });
    notify('item/started', { item: { type: 'mcpToolCall', id: 'm1', server: 'claude-threads-mcp', tool: 'send_file', status: 'inProgress', arguments: { path: '/x/a.png' } } });
    notify('item/completed', { item: { type: 'mcpToolCall', id: 'm1', server: 'claude-threads-mcp', tool: 'send_file', status: 'completed', arguments: {}, result: { ok: true }, error: null } });
    notify('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['thinking hard'], content: [] } });
    const names = events.flatMap((e) => blocks(e).map((b) => `${b.type}:${b.name ?? b.tool_use_id ?? ''}`));
    expect(names).toEqual([
      'tool_use:Edit', 'tool_use:Edit', 'tool_result:f1:/x/a.ts', 'tool_result:f1:/x/b.ts',
      'tool_use:mcp__claude-threads-mcp__send_file', 'tool_result:m1', 'thinking:',
    ]);
  });

  test('turn lifecycle → result carries the accumulated text and the interrupted status', () => {
    const { events, notify } = drive();
    notify('turn/started', { threadId: 't', turn: { id: 'u1' } });
    notify('item/completed', { item: { type: 'agentMessage', id: 'a1', text: 'Hallo' } });
    notify('turn/completed', { threadId: 't', turn: { id: 'u1', status: 'interrupted', error: null } });
    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({ subtype: 'error_interrupted', is_error: false, result: 'Hallo' });
  });
});

describe('CodexSession MCP elicitations', () => {
  const call = (agent: CodexSession, params: Record<string, unknown>) =>
    (agent as unknown as { handleServerRequest(m: string, p: Record<string, unknown>): Promise<unknown> })
      .handleServerRequest('mcpServer/elicitation/request', params);
  const approval = (serverName: string, tool: string) => ({
    serverName, mode: 'form', message: `Allow the ${serverName} MCP server to run tool "${tool}"?`,
    _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_params_display: [{ name: 'path', display_name: 'path', value: '/x' }] },
    requestedSchema: { type: 'object', properties: {} },
  });

  test("the bot's own MCP tools are accepted without a prompt", async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const events: ClaudeEvent[] = [];
    agent.on('event', (e: ClaudeEvent) => events.push(e));
    expect(await call(agent, approval('claude-threads-mcp', 'send_file'))).toEqual({ action: 'accept', content: {}, _meta: null });
    expect(events).toHaveLength(0);
  });

  test('foreign MCP tools prompt; decline maps to action decline', async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const events: ClaudeEvent[] = [];
    agent.on('event', (e: ClaudeEvent) => events.push(e));
    const pending = call(agent, approval('mail', 'send_email'));
    await Bun.sleep(0);
    expect(events[0]).toMatchObject({ type: 'approval_request', tool_name: 'MCP mail/send_email', content: 'path: /x' });
    agent.respondToApproval(String(events[0].request_id), false);
    expect(await pending).toEqual({ action: 'decline', content: null, _meta: null });
  });

  test('real elicitation forms are declined', async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    expect(await call(agent, { serverName: 'x', mode: 'url', message: 'login', url: 'https://x', elicitationId: '1', _meta: null }))
      .toEqual({ action: 'decline', content: null, _meta: null });
  });
});

describe('imageGeneration items', () => {
  test('completed image → tool_result + agent_file with the saved path', () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const events: ClaudeEvent[] = [];
    agent.on('event', (e: ClaudeEvent) => events.push(e));
    const n = agent as unknown as { handleNotification(m: string, p: Record<string, unknown>): void };
    n.handleNotification('item/started', { item: { type: 'imageGeneration', id: 'i1', status: 'inProgress', revisedPrompt: 'a viking', result: '', failure: null } });
    n.handleNotification('item/completed', { item: { type: 'imageGeneration', id: 'i1', status: 'completed', revisedPrompt: 'a viking', result: '', failure: null, savedPath: '/home/x/.codex/generated_images/t/i1.png' } });
    expect(events.map((e) => e.type)).toEqual(['assistant', 'user', 'agent_file']);
    expect(events[2]).toMatchObject({ path: '/home/x/.codex/generated_images/t/i1.png' });
    expect(events[2].caption).toBeUndefined();
  });
  test('failed image → error tool_result, no upload', () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const events: ClaudeEvent[] = [];
    agent.on('event', (e: ClaudeEvent) => events.push(e));
    (agent as unknown as { handleNotification(m: string, p: Record<string, unknown>): void })
      .handleNotification('item/completed', { item: { type: 'imageGeneration', id: 'i2', status: 'failed', revisedPrompt: null, result: '', failure: { message: 'blocked' } } });
    expect(events.map((e) => e.type)).toEqual(['user']);
  });
});

describe('CodexSession exit codes', () => {
  test('a requested kill reports exit 0; an unexpected death keeps its code', async () => {
    const mk = () => {
      const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
      const codes: unknown[] = [];
      agent.on('exit', (c: unknown) => codes.push(c));
      const rpc = (agent as unknown as { rpc: { onExit: (c: number | null) => void; isRunning: () => boolean; kill: () => void } }).rpc;
      return { agent, codes, rpc };
    };
    const a = mk();
    a.rpc.isRunning = () => true;
    a.rpc.kill = () => a.rpc.onExit(null);
    await a.agent.kill();
    expect(a.codes).toEqual([0]);
    const b = mk();
    b.rpc.onExit(null);
    expect(b.codes).toEqual([null]);
  });
});

describe('review regressions', () => {
  const srv = (agent: CodexSession) => agent as unknown as {
    handleServerRequest(m: string, p: Record<string, unknown>): Promise<unknown>;
    activeTurn: unknown; ready: Promise<void> | null; threadId: string | null;
    rpc: { request: (m: string, p?: unknown) => Promise<unknown> };
  };

  test('interrupt declines queued approvals unseen, not only the visible one', async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const events: ClaudeEvent[] = [];
    agent.on('event', (e: ClaudeEvent) => events.push(e));
    const a = srv(agent);
    a.activeTurn = { threadId: 't', turnId: 'u' };
    a.rpc.request = async () => ({});
    const first = a.handleServerRequest('item/commandExecution/requestApproval', { command: 'first' });
    const second = a.handleServerRequest('item/commandExecution/requestApproval', { command: 'second' });
    await Bun.sleep(0);
    agent.interrupt();
    expect(await Promise.all([first, second])).toEqual([{ decision: 'decline' }, { decision: 'decline' }]);
    expect(events.filter((e) => e.type === 'approval_request')).toHaveLength(1);
  });

  test('a rejected turn/start emits a terminal error result', async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const events: ClaudeEvent[] = [];
    agent.on('event', (e: ClaudeEvent) => events.push(e));
    const a = srv(agent);
    a.ready = Promise.resolve();
    a.threadId = 't';
    a.rpc.request = async () => { throw new Error('invalid turn parameters'); };
    agent.sendMessage('hello');
    await Bun.sleep(0);
    expect(events.find((e) => e.type === 'result')).toMatchObject({ is_error: true, result: 'invalid turn parameters' });
  });

  test('answers carry the question-set id; a foreign id is ignored, a timeout announces itself', async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null, permissionTimeoutMs: 30 });
    const events: ClaudeEvent[] = [];
    agent.on('event', (e: ClaudeEvent) => events.push(e));
    const a = srv(agent);
    const q = (id: string, timeout: number | null) => a.handleServerRequest('item/tool/requestUserInput', {
      questions: [{ id, header: 'Confirm', question: id, isOther: false, isSecret: false, options: [{ label: 'yes', description: '' }] }],
      isBlocking: true, autoResolutionMs: timeout,
    });
    const first = q('old', 20);
    await Bun.sleep(0);
    const oldSetId = String((events[0].message as { content: Array<{ id: string }> }).content[0].id);
    expect(await first).toEqual({ answers: {} });
    expect(events.find((e) => e.type === 'question_timeout')?.request_id).toBe(oldSetId);
    const second = q('new', null);
    await Bun.sleep(0);
    agent.respondToQuestion([{ header: 'Confirm', answer: 'yes' }], oldSetId); // stale id → ignored
    const newSetId = String((events.at(-1)!.message as { content: Array<{ id: string }> }).content[0].id);
    agent.respondToQuestion([{ header: 'Confirm', answer: 'yes' }], newSetId);
    expect(await second).toEqual({ answers: { new: { answers: ['yes'] } } });
  });

  test('a message during a running turn steers it; after the turn it starts a new one', async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const a = srv(agent);
    a.ready = Promise.resolve();
    a.threadId = 't';
    const calls: Array<[string, unknown]> = [];
    a.rpc.request = async (m, p) => { calls.push([m, p]); return {}; };
    a.activeTurn = { threadId: 't', turnId: 'turn-1' };
    agent.sendMessage('also check the tests');
    await Bun.sleep(0);
    expect(calls).toEqual([['turn/steer', { threadId: 't', input: [{ type: 'text', text: 'also check the tests', text_elements: [] }], expectedTurnId: 'turn-1' }]]);
    a.activeTurn = null;
    agent.sendMessage('next');
    await Bun.sleep(0);
    expect(calls[1][0]).toBe('turn/start');
  });

  test('two messages before turn/started: one turn/start, the second steers the acknowledged turn', async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const a = srv(agent);
    a.ready = Promise.resolve();
    a.threadId = 't';
    const calls: string[] = [];
    a.rpc.request = async (m) => { calls.push(m); return m === 'turn/start' ? { turn: { id: 'turn-9' } } : {}; };
    agent.sendMessage('one');
    agent.sendMessage('two');
    await Bun.sleep(0); await Bun.sleep(0); await Bun.sleep(0);
    expect(calls).toEqual(['turn/start', 'turn/steer']);
  });

  test('token usage: cached tokens are split out of input, missing counters become 0, no NaN', () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const events: ClaudeEvent[] = [];
    agent.on('event', (e: ClaudeEvent) => events.push(e));
    const a = agent as unknown as { handleNotification(m: string, p: Record<string, unknown>): void };
    a.handleNotification('thread/tokenUsage/updated', { tokenUsage: {
      total: { totalTokens: 1300, inputTokens: 1000, cachedInputTokens: 600, outputTokens: 300, reasoningOutputTokens: 0 },
      last: { totalTokens: 500, inputTokens: 400, cachedInputTokens: 300, outputTokens: 100, reasoningOutputTokens: 0 },
      modelContextWindow: 200000,
    } });
    a.handleNotification('turn/completed', { turn: { id: 'u', status: 'completed', error: null } });
    const result = events.find((e) => e.type === 'result') as ClaudeEvent & { usage: Record<string, number>; modelUsage: Record<string, Record<string, number>> };
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 300 });
    expect(result.modelUsage.codex).toMatchObject({ inputTokens: 400, cacheReadInputTokens: 600, cacheCreationInputTokens: 0, outputTokens: 300, contextWindow: 200000 });
    expect(agent.getStatusData()?.total_input_tokens).toBe(400); // current context = last input incl. cache, for the status-line consumer
    for (const v of Object.values(result.usage)) expect(Number.isNaN(v)).toBe(false);
  });

  test('interrupt before the thread is open drops the queued first message', async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const a = srv(agent);
    let open!: () => void;
    a.ready = new Promise<void>((r) => { open = r; });
    a.threadId = 't';
    const calls: string[] = [];
    a.rpc.request = async (m) => { calls.push(m); return {}; };
    agent.sendMessage('hello');
    expect(agent.interrupt()).toBe(true); // something was queued
    open();
    await Bun.sleep(0); await Bun.sleep(0);
    expect(calls).toEqual([]);
    agent.sendMessage('after'); // later messages are unaffected
    await Bun.sleep(0); await Bun.sleep(0);
    expect(calls).toEqual(['turn/start']);
  });

  test('interrupt while turn/start awaits its ack interrupts that turn once the id arrives', async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const a = srv(agent);
    a.ready = Promise.resolve();
    a.threadId = 't';
    const calls: Array<[string, unknown]> = [];
    let ack!: (v: unknown) => void;
    a.rpc.request = (m, p) => { calls.push([m, p]); return m === 'turn/start' ? new Promise((r) => { ack = r; }) : Promise.resolve({}); };
    agent.sendMessage('go');
    await Bun.sleep(0); await Bun.sleep(0);
    expect(agent.interrupt()).toBe(true);
    ack({ turn: { id: 'turn-7' } });
    await Bun.sleep(0); await Bun.sleep(0);
    expect(calls.map((c) => c[0])).toEqual(['turn/start', 'turn/interrupt']);
    expect(calls[1][1]).toMatchObject({ turnId: 'turn-7' });
  });

  test('a steer that loses the race against turn end falls back to a new turn', async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const a = srv(agent);
    a.ready = Promise.resolve();
    a.threadId = 't';
    const calls: string[] = [];
    a.rpc.request = async (m) => {
      calls.push(m);
      if (m === 'turn/steer') { a.activeTurn = null; throw new Error('no active turn'); }
      return {};
    };
    a.activeTurn = { threadId: 't', turnId: 'turn-1' };
    agent.sendMessage('hi');
    await Bun.sleep(0);
    expect(calls).toEqual(['turn/steer', 'turn/start']);
  });

  test('a replaced question set leaves approvals of the same turn open', async () => {
    const agent = new CodexSession({ workingDir: '/tmp', memory: null, agentFeatures: null });
    const events: ClaudeEvent[] = [];
    agent.on('event', (e: ClaudeEvent) => events.push(e));
    const a = srv(agent);
    a.activeTurn = { threadId: 't', turnId: 'u' };
    const approval = a.handleServerRequest('item/commandExecution/requestApproval', { command: 'ls' });
    const q = (id: string) => a.handleServerRequest('item/tool/requestUserInput', {
      questions: [{ id, header: 'H', question: id, isOther: false, isSecret: false, options: [{ label: 'y', description: '' }] }],
      isBlocking: true, autoResolutionMs: null,
    });
    const first = q('one');
    await Bun.sleep(0);
    void q('two');
    expect(await first).toEqual({ answers: {} }); // superseded
    await Bun.sleep(0);
    const request = events.find((e) => e.type === 'approval_request');
    expect(events.find((e) => e.type === 'approval_timeout')).toBeUndefined(); // approval still open
    agent.respondToApproval(String(request?.request_id), true);
    expect(await approval).toEqual({ decision: 'accept' });
  });

  test('image paths with spaces are extracted', () => {
    expect(extractImagePaths('[Attached files from chat — saved to disk, use Read or move/copy as needed:]\n- /tmp/up/Screenshot 2026-09-06 (1).png (image/png, 12 KB)\n\nhi'))
      .toEqual(['/tmp/up/Screenshot 2026-09-06 (1).png']);
  });
});
