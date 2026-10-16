import axios from 'axios';
import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { io } from 'socket.io-client';
import { MISSION_LOG_EVENTS } from '../missionStream.mjs';
import { missionAuthHeaders, missionServerUrl, resolveAgentId, resolveWorkspace } from '../workspace.mjs';
import { DEVICE_API_PREFIX } from './constants.mjs';
import { deviceTokenClient, loadDeviceCredentials } from './credentials.mjs';

/** event_key kết thúc nhiệm vụ của Device Agent (BE `clientLog`). */
const DONE_KEYS = new Set(['device_agent.done', 'device_agent.failed', 'device_agent.cancelled']);

/** Theo dõi dòng tiến trình của phiên (thread = session của lượt chạy thẳng). Không bao giờ ném lỗi. */
function watchDeviceMission(serverUrl, apiKey, sessionId, { idleTimeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    const socket = io(serverUrl, { auth: { token: apiKey }, transports: ['websocket'], reconnection: true });
    let idle;
    let settled = false;
    const stop = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      socket.disconnect();
      process.off('SIGINT', onSigint);
      resolve(reason);
    };
    const onSigint = () => stop('interrupted');
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { console.log(chalk.gray('\n(không có hoạt động — ngừng theo dõi; việc có thể vẫn đang chạy)')); stop('idle'); }, idleTimeoutMs);
    };
    process.on('SIGINT', onSigint);
    socket.on('connect_error', (e) => { console.log(chalk.yellow(`⚠️  Không theo dõi được tiến trình (${e.message})`)); stop('connect_error'); });
    socket.on('error', () => stop('error'));
    for (const event of MISSION_LOG_EVENTS) {
      socket.on(event, (payload) => {
        if (!payload || (payload.thread_id !== sessionId && payload.session_id !== sessionId)) return;
        bump();
        const icon = payload.status === 'error' ? chalk.red('✗') : payload.status === 'success' ? chalk.green('✓') : payload.status === 'warning' ? chalk.yellow('!') : chalk.gray('·');
        console.log(`${chalk.gray(`[${new Date(payload.timestamp || Date.now()).toLocaleTimeString()}]`)} ${icon} ${payload.message || payload.event_key || ''}`);
        if (DONE_KEYS.has(payload.event_key)) stop(payload.event_key);
      });
    }
    bump();
  });
}

/**
 * `aivin remote do "<việc>"` — giao thẳng cho Device Agent (không qua bước chọn công cụ), chạy nền phía BE, CLI in tiến trình.
 */
export async function runRemoteMission(objective, options = {}) {
  const serverUrl = missionServerUrl();
  const apiKey = process.env.API_KEY;
  const authHeaders = missionAuthHeaders();
  // Đăng nhập bằng JWT (không phải API key `<client>-ak-…`) thì không suy ra được tenant → lấy từ token thiết bị đã ghép.
  const client = deviceTokenClient(loadDeviceCredentials()?.device_token);
  if (client && !authHeaders.headers['x-client-slug']) authHeaders.headers['x-client-slug'] = client;
  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  const agentId = resolveAgentId(workspace, options.agent);
  const sessionId = `device-cli-${randomUUID()}`;
  console.log(chalk.blue('💻 Device Agent:'), objective);
  console.log(chalk.gray(`   Workspace: ${workspace.name || workspace.id}${options.device ? ` · máy: ${options.device}` : ''}`));
  const watching = options.watch !== false ? watchDeviceMission(serverUrl, apiKey, sessionId) : Promise.resolve(undefined);
  try {
    await axios.post(`${serverUrl}${DEVICE_API_PREFIX}/missions/start`, {
      objective,
      workspace_id: workspace.id || workspace._id,
      agent_id: agentId,
      session_id: sessionId,
      ...(options.device ? { device: options.device } : {}),
      ...(options.cwd ? { working_dir: options.cwd } : {}),
    }, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Không giao được việc cho máy: ${message}`, { cause: error });
  }
  const reason = await watching;
  if (reason === 'interrupted') {
    // Ctrl+C = huỷ thật: BE dừng vòng nhiệm vụ ở nhịp kế tiếp và gửi lệnh huỷ xuống máy (kill cả cây tiến trình đang chạy).
    console.log(chalk.yellow('\n⏹  Đang huỷ việc trên máy...'));
    await axios.post(`${serverUrl}${DEVICE_API_PREFIX}/missions/cancel`, { session_id: sessionId }, authHeaders)
      .then(() => console.log(chalk.gray('   Đã gửi lệnh huỷ.')))
      .catch((e) => console.log(chalk.red(`   Không gửi được lệnh huỷ (${e.response?.data?.message || e.message}) — việc có thể vẫn chạy.`)));
  }
  return { sessionId, reason };
}
