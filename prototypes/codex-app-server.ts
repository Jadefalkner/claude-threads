#!/usr/bin/env bun
// Prototyp: codex app-server ueber stdio (JSON-RPC, newline-delimited).
// Deckt ab: Text-Turn mit Streaming, Freigabe/Ablehnung, Interrupt, Resume nach Prozessneustart.
//
//   bun prototypes/codex-app-server.ts start "Sag hallo"
//   bun prototypes/codex-app-server.ts resume <threadId> "Was habe ich zuvor gefragt?"
//   bun prototypes/codex-app-server.ts interrupt "Zaehle mit sleep 1 bis 100"   # bricht nach 5s ab
//   DECISION=decline bun prototypes/codex-app-server.ts start "Fuehre 'date' aus"
//
// ponytail: ein Prozess pro Aufruf, kein Reconnect, kein Timeout — Schnittstelle fuer src/agents/ spaeter.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class CodexAppServer {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  onNotification: (method: string, params: Json) => void = () => {};
  onServerRequest: (method: string, params: Json) => Promise<unknown> = async () => ({});

  constructor(bin = process.env.CODEX_BIN ?? "codex", extraArgs: string[] = []) {
    this.proc = spawn(bin, ["app-server", "--listen", "stdio://", ...extraArgs], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr.on("data", (d) => process.env.CODEX_DEBUG && process.stderr.write(`[codex] ${d}`));
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.handle(line));
    this.proc.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`codex exited (${code})`));
      this.pending.clear();
    });
  }

  private handle(line: string) {
    if (!line.trim()) return;
    let msg: Json;
    try { msg = JSON.parse(line); } catch { return; }
    if (process.env.CODEX_DEBUG) process.stderr.write(`<- ${line.slice(0, 300)}\n`);
    const { id, method, params, result, error } = msg as { id?: number; method?: string; params?: Json; result?: unknown; error?: { message: string } };
    if (method && id !== undefined) {
      // Server-Request (z.B. Approval): antworten
      this.onServerRequest(method, params ?? {})
        .then((r) => this.write({ id, result: r }))
        .catch((e) => this.write({ id, error: { code: -32000, message: String(e) } }));
    } else if (method) {
      this.onNotification(method, params ?? {});
    } else if (id !== undefined) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error.message)); else p.resolve(result);
    }
  }

  private write(msg: Json) {
    if (process.env.CODEX_DEBUG) process.stderr.write(`-> ${JSON.stringify(msg).slice(0, 300)}\n`);
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) { this.write({ method, params }); }

  async initialize() {
    await this.request("initialize", { clientInfo: { name: "volund-proto", title: "Völund Prototyp", version: "0.0.1" }, capabilities: null });
    this.notify("initialized");
  }

  close() { this.proc.kill(); }
}

// ---- Demo-Runner ---------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);
if (!mode) { console.error("usage: start|resume|interrupt ..."); process.exit(2); }

const codex = new CodexAppServer();
let activeTurn: { threadId: string; turnId: string } | null = null;
let turnDone: () => void = () => {};
const finished = new Promise<void>((r) => (turnDone = r));

codex.onNotification = (method, p) => {
  if (method === "item/agentMessage/delta") process.stdout.write(String(p.delta));
  else if (method === "turn/started") activeTurn = { threadId: String(p.threadId), turnId: String((p.turn as Json).id) };
  else if (method === "item/started" || method === "item/completed") {
    const item = p.item as Json;
    if (item.type !== "agentMessage") console.log(`\n[${method}] ${item.type} ${item.command ?? ""} ${item.status ?? ""}`);
  } else if (method === "turn/completed") {
    const turn = p.turn as Json;
    console.log(`\n[turn ${turn.status}]${turn.error ? " " + JSON.stringify(turn.error) : ""}`);
    turnDone();
  } else if (method === "error") console.error("[error]", JSON.stringify(p));
};

codex.onServerRequest = async (method, p) => {
  const decision = process.env.DECISION ?? "accept";
  if (method === "item/commandExecution/requestApproval") {
    console.log(`\n[approval] ${p.command} (cwd ${p.cwd}) ${p.reason ?? ""} -> ${decision}`);
    return { decision };
  }
  if (method === "item/fileChange/requestApproval") {
    console.log(`\n[approval] fileChange -> ${decision}`);
    return { decision };
  }
  console.log(`\n[serverRequest ${method}] unbeantwortet -> decline`);
  return { decision: "decline" };
};

const send = (threadId: string, text: string) =>
  codex.request<{ turn: Json }>("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });

await codex.initialize();
const auth = await codex.request<Json>("getAuthStatus", { includeToken: false, refreshToken: false });
console.log(`[auth] ${JSON.stringify(auth)}`);

const threadOpts = { cwd: process.cwd(), approvalPolicy: "untrusted", sandbox: "workspace-write" };
let threadId: string;

if (mode === "resume") {
  threadId = rest[0];
  const r = await codex.request<{ thread: Json }>("thread/resume", { threadId, ...threadOpts, excludeTurns: true });
  console.log(`[resumed] ${r.thread.id}`);
  await send(threadId, rest[1] ?? "Fasse kurz zusammen, was wir bisher besprochen haben.");
} else {
  const r = await codex.request<{ thread: Json; model: string }>("thread/start", threadOpts);
  threadId = String(r.thread.id);
  console.log(`[thread] ${threadId} model=${r.model}`);
  await send(threadId, rest[0] ?? "Sag in einem Satz hallo.");
  if (mode === "interrupt") {
    setTimeout(async () => {
      if (!activeTurn) return;
      console.log("\n[interrupt] sende turn/interrupt");
      await codex.request("turn/interrupt", activeTurn);
    }, 5000);
  }
}

await finished;
console.log(`[threadId] ${threadId}`);
codex.close();
