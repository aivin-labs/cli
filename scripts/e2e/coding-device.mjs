// "Máy" của phép thử trọn luồng: CLI daemon thật (codingAgents.mjs) với Claude Code thật trên máy này.
// Nhận lời gọi công cụ qua stdin (mỗi dòng một JSON { id, tool, args }), trả { id, ok, result | error, error_code } qua stdout.
// AIVIN_REMOTE_HOME và E2E_ROOT do bên gọi đặt — không đụng ~/.aivin thật.
import readline from 'readline';
import fs from 'fs';
import { spawn } from 'child_process';

const cli = new URL('../../bin/lib/remote/', import.meta.url).href;
const { createAgentRunner } = await import(`${cli}codingAgents.mjs`);
const runner = createAgentRunner();
const env = { roots: [process.env.E2E_ROOT] };
const log = (m) => process.stderr.write(`[device] ${m}\n`);
log(`installed: ${JSON.stringify(runner.installed())}`);

/** Lệnh chạy xong → { exitCode, stdout, stderr } như công cụ thật của CLI (git.*, shell.exec). */
const exec = (cmd, argv, opts = {}) => new Promise((resolve) => {
  const child = spawn(cmd, argv, { windowsHide: true, ...opts });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (e) => resolve({ exitCode: -1, stdout, stderr: String(e.message) }));
  child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
});
const dir = (p) => p || process.env.E2E_ROOT;

const handlers = {
  // Công cụ tối thiểu cho bước merge sau khi nhận (BE DeviceCodingIntegrationService) — cùng khuôn kết quả với CLI thật.
  'git.status': (a) => exec('git', ['-C', dir(a.path), 'status', '--porcelain=v1', '--branch']),
  'git.log': (a) => exec('git', ['-C', dir(a.path), 'log', `-${Math.min(Number(a.limit) || 20, 200)}`, '--pretty=format:%h %ad %an %s', '--date=short']),
  'fs.info': (a) => { const s = fs.existsSync(a.path) ? fs.statSync(a.path) : null; return s ? { exists: true, dir: s.isDirectory() } : { exists: false }; },
  'shell.exec': (a) => exec(String(a.command), [], { cwd: dir(a.cwd), shell: true }),
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
