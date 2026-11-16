// "Máy" của phép thử trọn luồng: CLI daemon thật (codingAgents.mjs) với Claude Code thật trên máy này.
// Nhận lời gọi công cụ qua stdin (mỗi dòng một JSON { id, tool, args }), trả { id, ok, result | error, error_code } qua stdout.
// AIVIN_REMOTE_HOME và E2E_ROOT do bên gọi đặt — không đụng ~/.aivin thật.
import readline from 'readline';

const cli = new URL('../../bin/lib/remote/', import.meta.url).href;
const { createAgentRunner } = await import(`${cli}codingAgents.mjs`);
const runner = createAgentRunner();
const env = { roots: [process.env.E2E_ROOT] };
const log = (m) => process.stderr.write(`[device] ${m}\n`);
log(`installed: ${JSON.stringify(runner.installed())}`);

const handlers = {
  'agent.run': (a) => runner.run(a, { onOutput: (s) => log(`agent: ${s.trim().slice(0, 200)}`) }, env),
  'agent.status': (a) => runner.status(a, {}),
  'agent.job_file': (a) => runner.jobFile(a),
  'agent.cleanup': (a) => runner.cleanup(a),
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const h = handlers[msg.tool];
  const reply = (o) => process.stdout.write(`${JSON.stringify({ id: msg.id, ...o })}\n`);
  if (!h) return reply({ ok: false, error: `Tool ${msg.tool} not on this device`, error_code: 'TOOL_UNKNOWN' });
  try {
    const result = await h(msg.args || {});
    log(`${msg.tool} → ${result?.status || (result?.removed !== undefined ? `removed=${result.removed}` : 'ok')}`);
    reply({ ok: true, result });
  } catch (e) {
    log(`${msg.tool} ✗ ${e.code || ''} ${e.message}`);
    reply({ ok: false, error: e.message, error_code: e.code || 'EXECUTION_FAILED' });
  }
});
process.on('SIGTERM', () => { runner.stopAll('e2e ended'); process.exit(0); });
