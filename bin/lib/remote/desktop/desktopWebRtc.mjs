/**
 * Desktop Cast WebRTC transport. Có `nonstandard.RTCVideoSource` (02/11/2026): hình đi video track — libwebrtc mã hoá VP8 liên khung, tự
 * chỉnh bitrate theo mạng; âm thanh hệ thống đi `nonstandard.RTCAudioSource` (Opus 48 kHz); kênh `aivin-desktop-frames` chỉ mang gói meta
 * (kích thước, màn hình) để FE quy đổi toạ độ. Không có: JPEG theo khung qua kênh dữ liệu không thứ tự (khung cũ không bao giờ xếp trước
 * khung mới). Quay màn hình + thu âm ở desktopCast.mjs; JPEG qua Socket.IO là đường lùi khi không có runtime native.
 */

const MAX_BUFFERED_BYTES = 512 * 1024;
/** Kênh thao tác chuột / phím người xem → máy: tin cậy + đúng thứ tự (nhả chuột không được đến trước nhấn), đi thẳng peer-to-peer. */
export const INPUT_CHANNEL = 'aivin-desktop-input';
const MAX_INPUT_MESSAGE_BYTES = 25 * 1024 * 1024;
/** Kênh tệp người xem kéo thả / dán vào màn hình (castFileDrop.mjs): tin cậy + đúng thứ tự, tách khỏi kênh thao tác để tệp lớn không làm trễ chuột. */
export const FILE_CHANNEL = 'aivin-desktop-files';
const MAX_FILE_CHUNK_BYTES = 256 * 1024;

const MAX_CURSOR_SHAPES = 64;
/** Thử nối lại khi peer hỏng hẳn (`failed`): dựng peer mới, cùng người xem; hết lượt thì ở lại JPEG. Peer nối được thì đặt lại. */
const RECONNECT_DELAYS_MS = [1000, 3000, 8000];

/**
 * Ghi băng thông video vào SDP answer (bên gửi đọc từ đây): mặc định libwebrtc trần ~2,5 Mbps, cuộn trang chữ 1440x810 chỉ còn ~7,5 khung/giây
 * (đo 03/11/2026). `{ start_kbps, min_kbps, max_kbps }` do BE gửi (`config/device_agent.json`); thiếu thì giữ nguyên SDP.
 */
export function withVideoBitrate(sdp, bitrate) {
  const params = [['x-google-start-bitrate', bitrate?.start_kbps], ['x-google-min-bitrate', bitrate?.min_kbps], ['x-google-max-bitrate', bitrate?.max_kbps]]
    .filter(([, v]) => Number.isFinite(v) && v > 0)
    .map(([k, v]) => `${k}=${Math.round(v)}`)
    .join(';');
  if (!params || typeof sdp !== 'string') return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const out = [];
  for (const line of lines) {
    const vp8 = line.match(/^a=rtpmap:(\d+) VP8\/90000/i);
    out.push(line);
    if (!vp8) continue;
    const fmtp = lines.findIndex(l => l.startsWith(`a=fmtp:${vp8[1]} `));
    if (fmtp < 0) out.push(`a=fmtp:${vp8[1]} ${params}`);
    else lines[fmtp] = `${lines[fmtp]};${params}`;
  }
  return out.join(eol);
}

export function packDesktopFrame(frame) {
  const image = Buffer.from(String(frame?.image || ''), 'base64');
  const meta = Buffer.from(JSON.stringify({
    t: 'frame', sessionId: frame?.sessionId, seq: frame?.seq, ts: frame?.ts,
    width: frame?.width, height: frame?.height,
    screenWidth: frame?.screenWidth, screenHeight: frame?.screenHeight,
    screenX: frame?.screenX, screenY: frame?.screenY,
    monitor: frame?.monitor, screens: frame?.screens, stats: frame?.stats,
    ...(frame?.secureDesktop ? { secureDesktop: true } : {}),
    mime: 'image/jpeg', bytes: image.length,
  }) + '\n');
  return Buffer.concat([meta, image]);
}

export function unpackDesktopFrame(packet) {
  const buf = Buffer.isBuffer(packet) ? packet : Buffer.from(packet);
  const nl = buf.indexOf(0x0a);
  if (nl <= 0) return null;
  try {
    const meta = JSON.parse(buf.subarray(0, nl).toString('utf8'));
    const imageBytes = buf.subarray(nl + 1);
    return { meta, imageBytes, jpeg: imageBytes };
  } catch {
    return null;
  }
}

export function createDesktopWebRtc({ emitSignal = () => {}, emitStatus = () => {}, onInput = () => {}, onFile = () => {}, onFileChunk = () => {}, onPeerReady = () => {}, onCursorMode = () => {}, loadRuntime } = {}) {
  const peers = new Map();
  /** Hình con trỏ đã thấy trong phiên — người xem nối sau vẫn nhận đủ (bộ quay chỉ gửi mỗi hình một lần). */
  const cursorShapes = new Map();
  let runtime = null;
  let sequence = 0;
  /**
   * Một nguồn video + một nguồn âm thanh dùng chung mọi người xem (một lần quay → nhiều track). Bẫy wrtc 0.10.0 (đo 02/11/2026): đã tạo
   * RTCVideoSource / RTCAudioSource thì tiến trình THOÁT TỰ NHIÊN (hết event loop) bị segfault lúc huỷ native — `process.exit()` thì sạch.
   * Daemon luôn thoát bằng `process.exit` (stopForGood / tín hiệu / tự cập nhật); thêm đường thoát mới phải giữ như vậy, không thì trình giữ chạy tưởng CLI sập.
   */
  let videoSource = null;
  let audioSource = null;
  // Không nhớ kết quả rỗng: runtime có thể vừa tải xong ở nền (webrtcRuntime.mjs) — phiên xem sau dùng được ngay, không cần khởi động lại.
  const load = async () => {
    if (runtime) return runtime;
    runtime = await (loadRuntime ? loadRuntime() : import('@roamhq/wrtc').catch(() => null));
    return runtime;
  };

  /** Peer hỏng hẳn: dựng lại sau một nhịp (BE chuyển offer mới, FE tự nối lại). Trong lúc chờ người xem nhận JPEG. */
  function scheduleReconnect(peer) {
    if (peer.retryTimer || peer.attempt >= RECONNECT_DELAYS_MS.length) return;
    peer.retryTimer = setTimeout(() => {
      if (peers.get(peer.viewerId) !== peer) return;
      start({ sessionId: peer.sessionId, viewerId: peer.viewerId, iceServers: peer.iceServers, videoBitrate: peer.videoBitrate, audio: peer.audioEnabled, attempt: peer.attempt + 1 }).catch(() => false);
    }, RECONNECT_DELAYS_MS[peer.attempt]);
    peer.retryTimer.unref?.();
  }

  async function start({ sessionId, viewerId, iceServers = [], videoBitrate = null, audio = true, attempt = 0 }) {
    close(viewerId);
    const wrtc = await load();
    const RTCPeerConnection = wrtc?.RTCPeerConnection || wrtc?.default?.RTCPeerConnection;
    if (!RTCPeerConnection) return false;
    const pc = new RTCPeerConnection({ iceServers });
    const channel = pc.createDataChannel('aivin-desktop-frames', { ordered: false, maxRetransmits: 0 });
    const inputChannel = pc.createDataChannel(INPUT_CHANNEL, { ordered: true });
    const fileChannel = pc.createDataChannel(FILE_CHANNEL, { ordered: true });
    const VideoSource = wrtc?.nonstandard?.RTCVideoSource || wrtc?.default?.nonstandard?.RTCVideoSource;
    const AudioSource = wrtc?.nonstandard?.RTCAudioSource || wrtc?.default?.nonstandard?.RTCAudioSource;
    const MediaStream = wrtc?.MediaStream || wrtc?.default?.MediaStream;
    if (VideoSource && !videoSource) videoSource = new VideoSource({ isScreencast: true });
    if (AudioSource && !audioSource) audioSource = new AudioSource();
    const track = videoSource ? videoSource.createTrack() : null;
    const audioTrack = audioSource && audio !== false ? audioSource.createTrack() : null;
    const stream = MediaStream && (track || audioTrack) ? new MediaStream([track, audioTrack].filter(Boolean)) : null;
    if (track) stream ? pc.addTrack(track, stream) : pc.addTrack(track);
    if (audioTrack) stream ? pc.addTrack(audioTrack, stream) : pc.addTrack(audioTrack);
    const peer = {
      pc, channel, inputChannel, fileChannel,
      track, video: !!track,
      audioTrack, audio: !!audioTrack, audioEnabled: audio !== false,
      sessionId, viewerId, iceServers, videoBitrate, attempt, retryTimer: null, open: false, dropped: 0,
    };
    fileChannel.binaryType = 'arraybuffer';
    fileChannel.onmessage = ({ data }) => {
      if (typeof data !== 'string') {
        const bytes = Buffer.from(data);
        if (bytes.length <= MAX_FILE_CHUNK_BYTES) onFileChunk(viewerId, bytes);
        return;
      }
      if (data.length > MAX_INPUT_MESSAGE_BYTES) return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      // Mã phiên lấy từ peer như kênh thao tác.
      onFile(viewerId, msg, peer.sessionId);
    };
    inputChannel.onmessage = ({ data }) => {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      if (text.length > MAX_INPUT_MESSAGE_BYTES) return;
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg?.control === 'cursor') {
        peer.localCursor = msg.local === true;
        if (peer.localCursor) for (const shape of cursorShapes.values()) sendShape(peer, shape);
        onCursorMode();
        return;
      }
      if (msg?.control === 'audio') {
        peer.audioEnabled = msg.enabled !== false && msg.muted !== true;
        if (peer.audioTrack) peer.audioTrack.enabled = peer.audioEnabled;
        onCursorMode();
        return;
      }
      if (msg?.control === 'clipboard') {
        if (typeof msg.text === 'string' && msg.text) {
          onInput({ action: msg.paste === true ? 'paste' : 'clipboard', text: msg.text, session_id: peer.sessionId }, viewerId);
        }
        return;
      }
      // Mã phiên lấy từ peer (đã gắn lúc BE mời), không tin mã trong gói.
      onInput({ ...msg, session_id: peer.sessionId }, viewerId);
    };
    peers.set(viewerId, peer);
    channel.binaryType = 'arraybuffer';
    const markConnected = () => {
      peer.open = true;
      peer.attempt = 0;
      emitStatus({ session_id: sessionId, viewer_id: viewerId, state: 'connected', transport: 'webrtc', video: peer.video, audio: peer.audio });
      onPeerReady(viewerId);
    };
    channel.onopen = markConnected;
    // Kênh đóng trước khi peer báo `failed` (chạy thật: ~19 s): báo ngay để BE gửi JPEG, không để người xem đứng hình trong lúc đó.
    channel.onclose = () => {
      const wasOpen = peer.open;
      peer.open = false;
      if (wasOpen && peers.get(viewerId) === peer) emitStatus({ session_id: sessionId, viewer_id: viewerId, state: 'disconnected', transport: 'jpeg' });
    };
    pc.onicecandidate = ({ candidate }) => {
      emitSignal({ session_id: sessionId, viewer_id: viewerId, type: 'ice', candidate: candidate?.toJSON?.() || candidate || null });
    };
    pc.onconnectionstatechange = () => {
      if (peers.get(viewerId) !== peer) return;
      const state = pc.connectionState;
      if (['failed', 'closed', 'disconnected'].includes(state)) {
        const wasOpen = peer.open;
        peer.open = false;
        if (wasOpen || state !== 'disconnected') emitStatus({ session_id: sessionId, viewer_id: viewerId, state, transport: 'jpeg' });
        if (state === 'failed') scheduleReconnect(peer);
      } else if (state === 'connected' && !peer.open && channel.readyState === 'open') {
        // Mạng chập chờn: `disconnected` tự hồi về `connected` nhưng kênh không mở lại (onopen không chạy lần nữa) — không có nhánh này là kẹt JPEG.
        markConnected();
      }
    };
    await pc.setLocalDescription(await pc.createOffer());
    emitSignal({ session_id: sessionId, viewer_id: viewerId, type: 'offer', sdp: pc.localDescription?.sdp, ice_servers: iceServers });
    return true;
  }

  async function signal(msg) {
    const peer = peers.get(String(msg?.viewer_id || ''));
    if (!peer || msg?.session_id !== peer.sessionId) return false;
    if (msg.type === 'answer' && msg.sdp) {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: withVideoBitrate(msg.sdp, peer.videoBitrate) });
      return true;
    }
    if (msg.type === 'ice') {
      await peer.pc.addIceCandidate(msg.candidate || null).catch(() => {});
      return true;
    }
    return false;
  }

  /** JPEG cho người xem chưa có video; người có video chỉ nhận gói meta (không ảnh). */
  function push(frame) {
    const packet = packDesktopFrame({ ...frame, seq: ++sequence });
    const metaPacket = packDesktopFrame({ ...frame, image: '', seq: sequence });
    let sent = 0;
    for (const peer of peers.values()) {
      if (!peer.open || peer.channel.readyState !== 'open') continue;
      if (peer.video) {
        try { peer.channel.send(metaPacket); } catch { /* kênh vừa đóng */ }
        continue;
      }
      if (peer.channel.bufferedAmount > MAX_BUFFERED_BYTES) { peer.dropped++; continue; }
      try { peer.channel.send(packet); sent++; } catch { peer.dropped++; }
    }
    return sent;
  }

  function sendShape(peer, shape) {
    if (peer.inputChannel?.readyState !== 'open') return;
    try { peer.inputChannel.send(JSON.stringify({ t: 'cursor_shape', ...shape })); } catch { /* kênh vừa đóng */ }
  }

  /** Vị trí con trỏ: kênh không gửi lại — mất một gói thì gói sau đè lên. Chỉ tới người xem đã báo tự vẽ con trỏ. */
  function pushCursor(cursor) {
    const packet = Buffer.from(JSON.stringify({ t: 'cursor', ...cursor }) + '\n');
    for (const peer of peers.values()) {
      if (!peer.localCursor || !peer.open || peer.channel.readyState !== 'open') continue;
      try { peer.channel.send(packet); } catch { /* kênh vừa đóng */ }
    }
  }

  /** Hình con trỏ: kênh tin cậy (kênh thao tác) vì chỉ gửi một lần. */
  function pushCursorShape(shape) {
    if (cursorShapes.size >= MAX_CURSOR_SHAPES) cursorShapes.delete(cursorShapes.keys().next().value);
    cursorShapes.set(shape.id, shape);
    for (const peer of peers.values()) if (peer.localCursor) sendShape(peer, shape);
  }

  /** Ô đang có tiêu điểm trên máy có phải ô nhập chữ không (sau cú nhấp của người xem) — trình duyệt điện thoại tự mở / đóng bàn phím ảo. */
  function pushInputFocus(focus) {
    const packet = JSON.stringify({ t: 'input_focus', editable: focus?.editable === true });
    for (const peer of peers.values()) {
      if (peer.inputChannel?.readyState !== 'open') continue;
      try { peer.inputChannel.send(packet); } catch { /* kênh vừa đóng */ }
    }
  }

  /** Nội dung Clipboard văn bản mới trên máy từ xa → gửi qua kênh điều khiển cho trình duyệt người xem. */
  function pushClipboard(clip) {
    const text = typeof clip?.text === 'string' ? clip.text : '';
    if (!text) return;
    const packet = JSON.stringify({ t: 'clipboard', text });
    for (const peer of peers.values()) {
      if (peer.inputChannel?.readyState !== 'open') continue;
      try { peer.inputChannel.send(packet); } catch { /* kênh vừa đóng */ }
    }
  }

  /** Báo máy từ xa vừa vào / thoát vùng màn hình bảo mật Windows (hộp thoại quyền quản trị UAC hoặc màn hình khóa). */
  function pushSecureDesktop(sec) {
    const packet = JSON.stringify({ t: 'secure_desktop', active: sec?.active === true });
    for (const peer of peers.values()) {
      if (peer.inputChannel?.readyState !== 'open') continue;
      try { peer.inputChannel.send(packet); } catch { /* kênh vừa đóng */ }
    }
  }

  /** Trả lời đúng người xem đang gửi tệp. */
  function replyFile(viewerId, msg) {
    const channel = peers.get(String(viewerId || ''))?.fileChannel;
    if (channel?.readyState !== 'open') return;
    try { channel.send(JSON.stringify(msg)); } catch { /* kênh vừa đóng */ }
  }

  /** Mọi người xem đều có video và tự vẽ con trỏ → bộ quay thôi lồng con trỏ vào khung. */
  function localCursor() {
    return peers.size > 0 && [...peers.values()].every(p => p.video && p.open && p.localCursor);
  }

  /** Khung thô I420 từ tiến trình quay → nguồn video (mọi track cùng nguồn). */
  function pushRaw(frame) {
    if (!videoSource || ![...peers.values()].some(p => p.video && p.open)) return false;
    try { videoSource.onFrame(frame); return true; } catch { return false; }
  }

  /** Khung âm thanh PCM 16-bit 10 ms từ tiến trình quay → nguồn âm thanh (mọi track cùng nguồn). */
  function pushAudio(audio) {
    if (!audioSource || !needsAudio()) return false;
    const sampleRate = audio?.sampleRate || 48000;
    const channelCount = audio?.channelCount || 2;
    const framesPer10ms = Math.floor(sampleRate / 100);
    const samplesPer10ms = framesPer10ms * channelCount;
    const samples = audio?.samples;
    if (!samples || samples.length < samplesPer10ms) return false;
    try {
      for (let off = 0; off + samplesPer10ms <= samples.length; off += samplesPer10ms) {
        const chunk = off === 0 && samples.length === samplesPer10ms ? samples : samples.subarray(off, off + samplesPer10ms);
        audioSource.onData({
          samples: chunk,
          sampleRate,
          bitsPerSample: audio.bitsPerSample || 16,
          channelCount,
          numberOfFrames: framesPer10ms,
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Còn người xem cần âm thanh (đã nối WebRTC + có audio track + chưa tắt tiếng). */
  function needsAudio() { return [...peers.values()].some(p => p.audio && p.open && p.audioEnabled !== false); }
  function hasAudio() { return [...peers.values()].some(p => p.audio); }

  /** Bật / tắt âm thanh cho toàn bộ người xem trong phiên. */
  function setAudio(enabled) {
    const next = enabled !== false;
    for (const peer of peers.values()) {
      peer.audioEnabled = next;
      if (peer.audioTrack) peer.audioTrack.enabled = next;
    }
    onCursorMode();
  }

  /** Còn người xem cần ảnh JPEG (chưa nối WebRTC, hoặc nối nhưng không có video). */
  function needsJpeg() { return needsFallback() || [...peers.values()].some(p => !p.video); }
  function hasVideo() { return [...peers.values()].some(p => p.video); }

  function anyOpen() { return [...peers.values()].some(p => p.open && p.channel.readyState === 'open'); }
  function needsFallback() { return peers.size === 0 || [...peers.values()].some(p => !p.open || p.channel.readyState !== 'open'); }

  function close(viewerId) {
    const peer = peers.get(String(viewerId || ''));
    if (!peer) return;
    peers.delete(String(viewerId));
    clearTimeout(peer.retryTimer);
    try { peer.channel.close(); } catch { /* already closed */ }
    try { peer.inputChannel?.close(); } catch { /* already closed */ }
    try { peer.fileChannel?.close(); } catch { /* already closed */ }
    try { peer.track?.stop(); } catch { /* already stopped */ }
    try { peer.audioTrack?.stop(); } catch { /* already stopped */ }
    try { peer.pc.close(); } catch { /* already closed */ }
  }

  function closeAll() { for (const id of [...peers.keys()]) close(id); cursorShapes.clear(); }
  return {
    start, signal, push, pushRaw, pushAudio, pushCursor, pushCursorShape, pushInputFocus, pushClipboard, pushSecureDesktop, replyFile,
    localCursor, needsJpeg, hasVideo, needsAudio, hasAudio, setAudio, anyOpen, needsFallback, close, closeAll,
  };
}
