// Smoke: startet CodexSession mit der Völund-Plattform-Config und listet die MCP-Server/Tools,
// die Codex im Thread sieht. Braucht kein Turn-Kontingent.
import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import { CodexSession } from '../src/agents/codex/session.js';

const cfg = yaml.load(readFileSync(`${process.env.HOME}/.volund/.config/claude-threads/config.yaml`, 'utf8')) as {
  platforms: Array<{ type: string; url: string; token: string; channelId: string; allowedUsers: string[] }>;
};
const p = cfg.platforms[0];
const agent = new CodexSession({
  workingDir: '/home/jadefalkner/.claude/jobs/1fce641d/tmp',
  threadId: 'smoke-thread',
  permissionMode: 'default',
  platformConfig: { type: p.type, url: p.url, token: p.token, channelId: p.channelId, allowedUsers: p.allowedUsers },
  memory: null,
  agentFeatures: null,
});
const init = new Promise<string>((resolve) => agent.on('event', (e) => { if (e.type === 'system' && e.subtype === 'init') resolve(String(e.session_id)); }));
agent.start();
const threadId = await init;
const rpc = (agent as unknown as { rpc: { request<T>(m: string, p: unknown): Promise<T> } }).rpc;
const status = await rpc.request<{ data: Array<{ name: string; runtimeStatus: unknown; tools: Record<string, unknown>; authStatus: unknown }> }>('mcpServerStatus/list', { threadId });
for (const s of status.data) console.log(`[mcp] ${s.name} status=${JSON.stringify(s.runtimeStatus)} tools=${Object.keys(s.tools).join(',')}`);
await agent.kill();
