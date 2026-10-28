import axios from 'axios';
import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { io } from 'socket.io-client';
import { MISSION_LOG_EVENTS } from '../missionStream.mjs';
import { missionAuthHeaders, missionServerUrl, resolveAgentId, resolveWorkspace } from '../workspace.mjs';
import { DEVICE_API_PREFIX } from './constants.mjs';
import { deviceTokenClient, loadDeviceCredentials } from './credentials.mjs';
import { ANSWER_STATUS, askDirectQuestion } from './missionQuestion.mjs';

/** event_key kết thúc nhiệm vụ của Device Agent (BE `clientLog`). */
const DONE_KEYS = new Set(['device_agent.done', 'device_agent.failed', 'device_agent.cancelled']);

/** Dòng báo nhiệm vụ đang chờ người trả lời (BE `DEVICE_AWAITING_USER_EVENT`) — meta mang câu hỏi đã đọc cấu trúc. */
const AWAITING_USER_KEY = 'device_agent.awaiting_user';

/** Câu hỏi đang chờ: lấy trong meta của dòng tiến trình, thiếu thì hỏi BE. */
async function loadQuestion(api, sessionId, payload) {
  if (payload?.meta?.direct_question) return payload.meta.direct_question;
  const res = await axios.get(`${api.serverUrl}${DEVICE_API_PREFIX}/missions/${encodeURIComponent(sessionId)}/question`, api.authHeaders).catch(() => null);
  return res?.data?.question || null;
}

/**
 * Hỏi trong terminal rồi gửi câu trả lời; BE báo không khớp thì hỏi lại. Dòng tiến trình mới tới (đã trả lời trên web, việc chạy tiếp)
 * → `signal` huỷ câu hỏi đang gõ dở.
 */
async function answerInTerminal(api, sessionId, question, { signal, onInterrupt }) {
  for (;;) {
    const answer = await askDirectQuestion(question, { signal, onInterrupt });
    if (!answer) return;
    const res = await axios.post(`${api.serverUrl}${DEVICE_API_PREFIX}/missions/answer`, { session_id: sessionId, ...answer }, api.authHeaders)
      .then((r) => r.data)
      .catch((e) => ({ status: ANSWER_STATUS.REJECTED, error: e.response?.data?.message || e.message }));
    if (res?.status === ANSWER_STATUS.ANSWERED) return console.log(chalk.gray('   Đã gửi câu trả lời — làm tiếp trên máy...'));
    if (res?.status === ANSWER_STATUS.NO_QUESTION) return console.log(chalk.gray('   Câu hỏi này không còn chờ (đã trả lời ở nơi khác hoặc đã hết hạn).'));
    if (res?.status === ANSWER_STATUS.INVALID_ANSWER) {
      console.log(chalk.red('   Câu trả lời không khớp câu hỏi — trả lời lại.'));
      continue;
    }
    return console.log(chalk.red(`   Không gửi được câu trả lời (${res?.error || 'lỗi'}) — trả lời trên web Aivin để làm tiếp.`));
  }
}

/** Theo dõi dòng tiến trình của phiên (thread = session của lượt chạy thẳng), hỏi câu đang chờ ngay trong terminal. Không bao giờ ném lỗi. */
function watchDeviceMission(api, sessionId, { idleTimeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    const socket = io(api.serverUrl, { auth: { token: api.apiKey }, transports: ['websocket'], reconnection: true });
    let idle;
    let settled = false;
    /** Câu hỏi đang hiện trong terminal — dòng tiến trình mới tới thì huỷ (đã trả lời trên web). */
    let asking = null;
    const stop = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      asking?.abort();
      socket.disconnect();
      process.off('SIGINT', onSigint);
      resolve(reason);
    };
    const onSigint = () => stop('interrupted');
    const bump = () => {
      clearTimeout(idle);
      // Đang chờ người trả lời thì không tính "không có hoạt động" — người dùng có thể nghĩ lâu.
      if (asking) return;
      idle = setTimeout(() => { console.log(chalk.gray('\n(không có hoạt động — ngừng theo dõi; việc có thể vẫn đang chạy)')); stop('idle'); }, idleTimeoutMs);
    };
    const ask = async (payload) => {
      asking?.abort();
      const controller = new AbortController();
      asking = controller;
      clearTimeout(idle);
      try {
        const question = await loadQuestion(api, sessionId, payload);
        if (!question || controller.signal.aborted) return;
        await answerInTerminal(api, sessionId, question, { signal: controller.signal, onInterrupt: onSigint });
      } catch (e) {
        console.log(chalk.yellow(`⚠️  Không hỏi được trong terminal (${e.message}) — trả lời trên web Aivin để làm tiếp.`));
      } finally {
        if (asking === controller) asking = null;
        if (!settled) bump();
      }
    };
    process.on('SIGINT', onSigint);
    socket.on('connect_error', (e) => { console.log(chalk.yellow(`⚠️  Không theo dõi được tiến trình (${e.message})`)); stop('connect_error'); });
    socket.on('error', () => stop('error'));
    for (const event of MISSION_LOG_EVENTS) {
      socket.on(event, (payload) => {
        if (!payload || (payload.thread_id !== sessionId && payload.session_id !== sessionId)) return;
        const icon = payload.status === 'error' ? chalk.red('✗') : payload.status === 'success' ? chalk.green('✓') : payload.status === 'warning' ? chalk.yellow('!') : chalk.gray('·');
        if (payload.event_key !== AWAITING_USER_KEY) asking?.abort();
        console.log(`${chalk.gray(`[${new Date(payload.timestamp || Date.now()).toLocaleTimeString()}]`)} ${icon} ${payload.message || payload.event_key || ''}`);
        if (DONE_KEYS.has(payload.event_key)) return stop(payload.event_key);
        if (payload.event_key === AWAITING_USER_KEY) return void ask(payload);
        bump();
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
  const watching = options.watch !== false ? watchDeviceMission({ serverUrl, apiKey, authHeaders }, sessionId) : Promise.resolve(undefined);
  try {
    await axios.post(`${serverUrl}${DEVICE_API_PREFIX}/missions/start`, {
      objective,
      workspace_id: workspace.id || workspace._id,
      agent_id: agentId,
      session_id: sessionId,
      ...(options.device ? { device: options.device } : {}),
      ...(options.cwd ? { working_dir: options.cwd } : {}),
      ...(options.file?.length ? { file_ids: options.file } : {}),
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
