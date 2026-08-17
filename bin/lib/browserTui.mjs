import React, { useState, useRef, useEffect } from 'react';
import { render, Box, Text, Static } from 'ink';
import TextInput from 'ink-text-input';
import { io } from 'socket.io-client';
import axios from 'axios';
import {
  MISSION_LOG_EVENTS,
  MISSION_DONE_EVENT_KEYS,
  openBrowserViewer,
  sendOSNotification,
  streamBrowserMissionLog,
} from './missionStream.mjs';

// ── Claude-Code-style split view for `aivin browser`: log cuộn phía trên (Ink <Static>, append-only,
// không bao giờ re-render 1 dòng đã in — đúng thứ cần cho log liên tục), 1 dòng input cố định dưới
// cùng, luôn nhận gõ. Chỉ dùng khi có TTY thật (guard ở call site, browserAutomation.mjs) - Ink cần
// raw-mode stdin, không hoạt động khi output bị pipe/redirect. Không có bundler/JSX transform trong
// CLI này (chỉ publish .mjs thô) nên toàn bộ component viết bằng React.createElement thuần, không JSX.
const h = React.createElement;

const STEP_ICON = { planning: '📋', perceiving: '👁', executing: '▶', blocked: '🛡', recovering: '↺', auditing: '🔎', done: '✅', failed: '❌' };

let nextLineId = 0;
function line(text, color, dim) {
  return { id: nextLineId++, text, color, dim };
}

function LogLine({ item }) {
  return h(Text, { color: item.color, dimColor: item.dim }, item.text);
}

function MissionTuiApp({ serverUrl, apiKey, threadId, tenantClient, idleTimeoutMs, openViewerOnHIL, onSettle }) {
  const [lines, setLines] = useState([]);
  const [inputValue, setInputValue] = useState('');
  // Khác `paused=false` (mission đang tự chạy, Enter -> steer) - khi có giá trị, Enter gửi
  // browser:resolve nhắm đúng session HIL đang treo thay vì đi qua kênh steer.
  const [pausedSessionKey, setPausedSessionKey] = useState(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  const socketRef = useRef(null);
  const settledRef = useRef(false);
  const viewerServerRef = useRef(null);
  const idleTimerRef = useRef(null);
  const viewerOpenedRef = useRef(false);

  const appendLine = (text, color, dim) => setLines((prev) => [...prev, line(text, color, dim)]);

  useEffect(() => {
    const socket = io(serverUrl, { auth: { token: apiKey || 'dev-token' }, transports: ['websocket'], reconnection: true });
    socketRef.current = socket;

    // `reason` - cùng lý do với streamBrowserMissionLog's stop(reason): phân biệt kết quả mission
    // thật ('success'/'failed') với "chỉ đơn giản là ngừng theo dõi" ('idle'/'connect_error') - CLI
    // dùng để quyết định có nên retry tunnel hay không (chỉ retry ở nhóm sau).
    const settle = (reason) => {
      if (settledRef.current) return;
      settledRef.current = true;
      clearTimeout(idleTimerRef.current);
      socket.disconnect();
      viewerServerRef.current?.close();
      setDone(true);
      onSettle(reason);
    };

    const bumpIdle = () => {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        appendLine(`\n(không có hoạt động ${Math.round(idleTimeoutMs / 1000)}s - dừng theo dõi; mission có thể vẫn đang chạy nền)`, 'gray');
        settle('idle');
      }, idleTimeoutMs);
    };

    socket.on('connect_error', (error) => {
      appendLine(`⚠️  Không theo dõi được tiến độ trực tiếp (${error.message}) - mission vẫn tiếp tục.`, 'yellow');
      settle('connect_error');
    });

    // Học đúng sessionKey (clientId) của phiên HIL hiện tại - browser:cast-start bắn vào room
    // `client:<tenant>` (auto-join, cùng room browser:agent-step dùng - xem comment tại nơi emit
    // trong AIBrowserService.ts), nhưng browser:resolved/cast-error lại bắn vào room
    // `aibrowser:<sessionKey>` (chỉ join khi biết sessionKey, KHÔNG auto-join) - phải tự emit
    // join-room ngay khi biết sessionKey, đúng như browserViewerHtml's script đã làm, nếu không 2
    // event này không bao giờ tới được đây.
    socket.on('browser:cast-start', (payload) => {
      if (!payload?.clientId) return;
      setPausedSessionKey(payload.clientId);
      socket.emit('join-room', { name: 'aivin-cli-tui', rooms: [`aibrowser:${payload.clientId}`] });
    });
    socket.on('browser:resolved', () => setPausedSessionKey(null));
    socket.on('browser:cast-error', (payload) => {
      appendLine(`⚠️ ${payload?.reason || 'Mất kết nối phiên trình duyệt'}`, 'yellow');
    });

    for (const eventName of MISSION_LOG_EVENTS) {
      socket.on(eventName, (payload) => {
        if (!payload || payload.thread_id !== threadId) return;
        bumpIdle();
        const time = new Date(payload.timestamp || Date.now()).toLocaleTimeString();
        const icon = payload.status === 'error' ? '✗' : payload.status === 'success' ? '✓' : payload.status === 'warning' ? '!' : '·';
        const iconColor = payload.status === 'error' ? 'red' : payload.status === 'success' ? 'green' : payload.status === 'warning' ? 'yellow' : 'gray';
        const label = payload.event_key || eventName;
        appendLine(`[${time}] ${icon} ${label} ${payload.message || ''}`.trimEnd(), iconColor);

        if (payload.event_key === 'ai_browser.hil_required' && !viewerOpenedRef.current) {
          viewerOpenedRef.current = true;
          sendOSNotification('AI Browser cần bạn hỗ trợ', payload.message || 'Mission đang chờ bạn tương tác');
          if (openViewerOnHIL) {
            appendLine('\n👤 Mission cần bạn tương tác trực tiếp (captcha/đăng nhập/xác nhận) - đang mở trình duyệt... (hoặc gõ "done" bên dưới sau khi xong)', 'magenta');
            openBrowserViewer(serverUrl, apiKey, tenantClient)
              .then((server) => {
                if (settledRef.current) server.close();
                else viewerServerRef.current = server;
              })
              .catch((e) => appendLine(`⚠️  Không mở được viewer tự động: ${e.message}`, 'yellow'));
          } else {
            appendLine(`\n👤 ${payload.message || 'Mission cần bạn hỗ trợ'} - kiểm tra cửa sổ trình duyệt (banner xanh ở đầu trang), hoặc gõ "done" bên dưới khi xong.`, 'magenta');
          }
        }
        if (payload.event_key === 'ai_browser.success' || payload.event_key === 'ai_browser.failed' || MISSION_DONE_EVENT_KEYS.has(payload.event_key)) {
          const ok = payload.event_key !== 'ai_browser.failed' && payload.status !== 'error';
          sendOSNotification(ok ? '✅ AI Browser hoàn tất' : '❌ AI Browser thất bại', payload.message || '');
          settle(ok ? 'success' : 'failed');
        }
      });
    }

    socket.on('browser:agent-step', (payload) => {
      if (!payload) return;
      bumpIdle();
      const time = new Date().toLocaleTimeString();
      const icon = STEP_ICON[payload.type] || '·';
      appendLine(`[${time}] ${icon} step ${payload.step} ${payload.type} ${payload.summary || ''}`.trimEnd(), 'cyan');
      if (payload.url) appendLine(`         url: ${payload.url}`, 'gray');
      const detail = payload.detail;
      if (Array.isArray(detail)) {
        for (const a of detail) {
          appendLine(`         - ${a.type}${a.detail ? ` (${a.detail})` : ''}`, 'gray');
          if (a.reason) appendLine(`           reason: ${a.reason}`, 'gray', true);
        }
      } else if (detail && typeof detail === 'object') {
        if (detail.reason) appendLine(`         reason: ${detail.reason}`, 'gray', true);
        for (const a of detail.revisedActions || []) {
          appendLine(`         - ${a.type}${a.detail ? ` (${a.detail})` : ''}`, 'gray');
          if (a.reason) appendLine(`           reason: ${a.reason}`, 'gray', true);
        }
      }
    });

    appendLine(`📡 Đang theo dõi tiến độ cho ${threadId}... (gõ bên dưới để phản hồi/hướng dẫn, Ctrl+C để dừng theo dõi)\n`, 'gray');
    bumpIdle();

    return () => {
      clearTimeout(idleTimerRef.current);
      socket.disconnect();
    };
    // Chỉ setup socket 1 lần lúc mount ([] deps có chủ đích) - props (serverUrl/apiKey/threadId/...)
    // không đổi trong suốt đời sống component này (1 lần chạy mission = 1 lần mount).
  }, []);

  const submit = async (value) => {
    const message = value.trim();
    setInputValue('');
    if (!message || sending) return;
    setSending(true);
    try {
      if (pausedSessionKey) {
        // Đang pause chờ HIL (loại SCREENCAST - captcha/login/2FA, xem escalateToHIL) - kênh này CHỈ
        // mang tín hiệu boolean "xong hay chưa" (resolveSession/escalateToHIL chỉ check
        // hilResult !== 'cancel', KHÔNG đọc nội dung text) - đúng bản chất "user tự thao tác thẳng
        // trên trang thật rồi", không phải "gõ câu trả lời ở đây thay việc thao tác". Enter ở đây
        // tương đương bấm nút "✅ Xong" trên viewer/banner cũ; gõ đúng "cancel" mới có nghĩa khác
        // (huỷ HIL). Bất kỳ text nào khác chỉ có tác dụng như 1 cú Enter trống.
        socketRef.current?.emit('browser:resolve', { clientId: pausedSessionKey, option: message });
        appendLine(`> ${message}  (đã gửi tín hiệu hoàn tất HIL - gõ "cancel" nếu muốn huỷ thay vì tiếp tục)`, 'blue');
        // Tự xoá ngay, không đợi round-trip browser:resolved - phòng trường hợp join-room (join lúc
        // cast-start) chưa kịp có hiệu lực phía server khi broadcast resolved bắn ra, khiến state kẹt
        // ở "vẫn đang pause" và mọi input sau đó bị hiểu nhầm là resolve cho session đã đóng.
        setPausedSessionKey(null);
      } else {
        // Mission đang tự chạy - gửi làm hướng dẫn real-time cho vòng plan kế tiếp.
        await axios.post(
          `${serverUrl}/plugins/ai-browser/steer`,
          { message },
          { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` } },
        );
        appendLine(`> ${message}  (đã gửi làm hướng dẫn - áp dụng ở bước kế tiếp)`, 'blue');
      }
    } catch (e) {
      appendLine(`⚠️  Gửi phản hồi thất bại: ${e.response?.data?.message || e.message}`, 'yellow');
    } finally {
      setSending(false);
    }
  };

  return h(
    Box,
    { flexDirection: 'column' },
    h(Static, { items: lines }, (item) => h(LogLine, { key: item.id, item })),
    !done &&
      h(
        Box,
        { borderStyle: 'round', borderColor: pausedSessionKey ? 'magenta' : 'blue', paddingX: 1, marginTop: 1 },
        h(Text, { color: pausedSessionKey ? 'magenta' : 'blue' }, pausedSessionKey ? '👤 HIL > ' : '💬 > '),
        h(TextInput, { value: inputValue, onChange: setInputValue, onSubmit: submit }),
      ),
  );
}

/**
 * Thay thế `streamBrowserMissionLog` (missionStream.mjs) khi có TTY thật - cùng semantics resolve
 * (event terminal / idle timeout / Ctrl+C), cùng logic parse event (log/HIL/notification), chỉ khác
 * cách hiển thị (Ink split-view thay vì console.log tuần tự) và thêm được ô input nhận feedback.
 */
export function runBrowserMissionTui(serverUrl, apiKey, threadId, tenantClient, { idleTimeoutMs = 120_000, openViewerOnHIL = true } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const onSettle = (reason) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', onSigint);
      unmount();
      resolve(reason);
    };
    const onSigint = () => onSettle('sigint');
    process.on('SIGINT', onSigint);

    const { unmount } = render(
      h(MissionTuiApp, { serverUrl, apiKey, threadId, tenantClient, idleTimeoutMs, openViewerOnHIL, onSettle }),
    );
  });
}

/**
 * Chọn đúng cách theo dõi mission: TUI Ink (log cuộn + input cố định) khi có TTY thật cả 2 chiều
 * (stdout để vẽ, stdin để nhận raw-mode input); fallback về `streamBrowserMissionLog` (console.log
 * tuần tự, không nhận input) cho môi trường không có TTY thật (CI, output bị pipe/redirect) - Ink
 * throw ngay khi cố bật raw mode trên stdin không phải TTY.
 */
export function watchBrowserMission(serverUrl, apiKey, threadId, tenantClient, opts = {}) {
  if (process.stdout.isTTY && process.stdin.isTTY) {
    return runBrowserMissionTui(serverUrl, apiKey, threadId, tenantClient, opts);
  }
  return streamBrowserMissionLog(serverUrl, apiKey, threadId, tenantClient, opts);
}
