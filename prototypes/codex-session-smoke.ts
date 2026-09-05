// Smoke: CodexSession-Adapter gegen echten codex app-server.
//   bun prototypes/codex-session-smoke.ts [resume-thread-id]
import { CodexSession } from '../src/agents/codex/session.js';

const resumeId = process.argv[2];
const agent = new CodexSession({
  workingDir: '/home/jadefalkner/.claude/jobs/1fce641d/tmp',
  permissionMode: 'default',
  sessionId: resumeId,
  resume: Boolean(resumeId),
  memory: null,
  agentFeatures: null,
});
let threadId = '';
const done = new Promise<void>((resolve) => {
  agent.on('event', (e) => {
    const short = JSON.stringify(e).slice(0, 220);
    console.log(`[event] ${short}`);
    if (e.type === 'system' && e.subtype === 'init') threadId = String(e.session_id);
    if (e.type === 'approval_request') {
      const decline = process.env.DECISION === 'decline';
      console.log(`[approve] ${e.request_id} -> ${decline ? 'decline' : 'accept'}`);
      agent.respondToApproval(String(e.request_id), !decline);
    }
    if (e.type === 'result') resolve();
  });
  agent.on('exit', (code) => { console.log(`[exit] ${code}`); resolve(); });
});
agent.start();
agent.sendMessage(resumeId
  ? 'Welchen Befehl hast du zuvor ausgefuehrt? Nur den Befehl nennen.'
  : "Fuehre 'hostname' als Shell-Befehl aus und nenne nur die Ausgabe.");
await done;
console.log(`[status] ${JSON.stringify(agent.getStatusData())?.slice(0, 160)}`);
console.log(`[threadId] ${threadId}`);
await agent.kill();
console.log(`[running] ${agent.isRunning()}`);
