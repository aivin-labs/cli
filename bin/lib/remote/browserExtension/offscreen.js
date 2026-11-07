// AIVIN Cast — trang offscreen: quay tab (getUserMedia chromeMediaSource=tab), mã hoá + gửi qua RTCPeerConnection.
// Mỗi người xem 1 RTCPeerConnection; mỗi tab 1 luồng quay dùng chung cho mọi người xem tab đó.
// BE gọi thẳng `globalThis.aivinCast.*` ở trang này qua CDP (trang không ngủ như service worker — xem sw.js). Cần
// tabId/streamId (API chỉ có ở worker) thì nhắn worker; tin nhắn tự đánh thức worker.

/** tabId → { stream, track (hình), audioTrack (tiếng, có thể không có), users: Set<viewerId> } */
const captures = new Map();
/** viewerId → { pc, sender (hình), audioSender, tabId, opts } */
const peers = new Map();
async function toWorker(type, payload) {
    const reply = await chrome.runtime.sendMessage({ target: 'aivin-cast-sw', type, ...payload });
    if (!reply || reply.error) throw new Error(reply?.error || `cast: worker không trả lời ${type}`);
    return reply;
}

/**
 * Luồng quay của tab ứng với target CDP — tab đã có luồng thì dùng lại; chưa có mới xin streamId (Chrome từ chối xin
 * thêm cho tab đang được quay: "Cannot capture a tab with an active stream", đo 30/09/2026 với người xem thứ 2).
 */
async function captureForTarget(targetId, opts) {
    const { tabId } = await toWorker('tabId', { targetId });
    const existing = captures.get(tabId);
    if (existing && existing.track.readyState === 'live') return { tabId, capture: existing };
    const { streamId } = await toWorker('streamId', { tabId });
    return { tabId, capture: await acquireCapture(tabId, streamId, opts) };
}

async function acquireCapture(tabId, streamId, opts) {
    const tabSource = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: opts.audio ? { mandatory: tabSource } : false,
        video: {
            mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: streamId,
                maxWidth: opts.maxWidth || 1280,
                maxHeight: opts.maxHeight || 800,
                maxFrameRate: opts.maxFps || 30,
            },
        },
    });
    const track = stream.getVideoTracks()[0];
    if (opts.contentHint) track.contentHint = opts.contentHint;
    const capture = { stream, track, audioTrack: stream.getAudioTracks()[0] || null, users: new Set() };
    captures.set(tabId, capture);
    track.addEventListener('ended', () => { if (captures.get(tabId) === capture) captures.delete(tabId); });
    return capture;
}

function releaseCapture(tabId, viewerId) {
    const capture = captures.get(tabId);
    if (!capture) return;
    capture.users.delete(viewerId);
    if (capture.users.size === 0) {
        capture.track.stop();
        capture.audioTrack?.stop();
        captures.delete(tabId);
    }
}

function preferCodec(transceiver, codec) {
    if (!codec || typeof RTCRtpSender.getCapabilities !== 'function') return;
    const all = RTCRtpSender.getCapabilities('video')?.codecs || [];
    const wanted = all.filter((c) => c.mimeType.toLowerCase() === `video/${codec.toLowerCase()}`);
    if (wanted.length) transceiver.setCodecPreferences([...wanted, ...all.filter((c) => !wanted.includes(c))]);
}

/** Gom xong ICE trước khi trả SDP (không trickle) — tối đa `timeoutMs`, quá thì trả phần đã gom. */
function waitIceGathering(pc, timeoutMs) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        pc.addEventListener('icegatheringstatechange', () => {
            if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
        });
    });
}

/**
 * Gợi ý băng thông cho bộ mã hoá (x-google-start/min/max-bitrate) chèn vào dòng fmtp của các codec hình trong SDP
 * answer trước khi áp dụng — không có thì WebRTC dò băng thông từ rất thấp, ~10 s đầu chỉ 5–6 khung/giây.
 */
function withBitrateHints(sdp, opts) {
    if (!opts.startBitrateKbps) return sdp;
    const lines = sdp.split(/\r?\n/);
    const videoPts = new Set();
    for (const line of lines) {
        const m = /^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\/90000/i.exec(line);
        if (m) videoPts.add(m[1]);
    }
    const maxKbps = opts.maxBitrate ? Math.round(opts.maxBitrate / 1000) : 0;
    const hints = `x-google-start-bitrate=${opts.startBitrateKbps};x-google-min-bitrate=${opts.minBitrateKbps || 0}`
        + (maxKbps ? `;x-google-max-bitrate=${maxKbps}` : '');
    const withFmtp = new Set();
    const out = [];
    for (const line of lines) {
        const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
        if (fmtp && videoPts.has(fmtp[1]) && !fmtp[2].includes('x-google-start-bitrate')) {
            withFmtp.add(fmtp[1]);
            out.push(`a=fmtp:${fmtp[1]} ${fmtp[2]};${hints}`);
            continue;
        }
        out.push(line);
    }
    // Codec không có dòng fmtp nào → thêm ngay sau dòng rtpmap của nó.
    const result = [];
    for (const line of out) {
        result.push(line);
        const m = /^a=rtpmap:(\d+) /.exec(line);
        if (m && videoPts.has(m[1]) && !withFmtp.has(m[1])) result.push(`a=fmtp:${m[1]} ${hints}`);
    }
    return result.join('\r\n');
}

async function applyEncoding(sender, opts) {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    if (opts.maxBitrate) params.encodings[0].maxBitrate = opts.maxBitrate;
    if (opts.maxFps) params.encodings[0].maxFramerate = opts.maxFps;
    // Chữ phải nét: nghẽn thì bớt khung/giây, KHÔNG hạ độ phân giải (đo 30/09/2026: để trình duyệt tự chọn thì
    // có lúc tụt còn 320×200).
    params.degradationPreference = opts.degradationPreference || 'maintain-resolution';
    await sender.setParameters(params).catch(() => {});
}

function closeViewer(viewerId) {
    const peer = peers.get(viewerId);
    if (!peer) return;
    peers.delete(viewerId);
    try { peer.pc.close(); } catch { /* đã đóng */ }
    releaseCapture(peer.tabId, viewerId);
}

async function start(msg) {
    closeViewer(msg.viewerId);
    const { tabId, capture } = await captureForTarget(msg.targetId, msg);
    const pc = new RTCPeerConnection({ iceServers: msg.iceServers || [] });
    const outStream = new MediaStream([capture.track]);
    const transceiver = pc.addTransceiver(capture.track, { direction: 'sendonly', streams: [outStream] });
    preferCodec(transceiver, msg.codec);
    let audioSender = null;
    if (capture.audioTrack) {
        outStream.addTrack(capture.audioTrack);
        audioSender = pc.addTransceiver(capture.audioTrack, { direction: 'sendonly', streams: [outStream] }).sender;
    }
    capture.users.add(msg.viewerId);
    peers.set(msg.viewerId, { pc, sender: transceiver.sender, audioSender, tabId, opts: msg });
    pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closeViewer(msg.viewerId);
    });
    await pc.setLocalDescription(await pc.createOffer());
    await waitIceGathering(pc, msg.iceGatherTimeoutMs || 2500);
    return { sdp: pc.localDescription.sdp };
}

async function answer(msg) {
    const peer = peers.get(msg.viewerId);
    if (!peer) throw new Error(`cast: không có kết nối cho người xem ${msg.viewerId}`);
    await peer.pc.setRemoteDescription({ type: 'answer', sdp: withBitrateHints(msg.sdp, peer.opts) });
    await applyEncoding(peer.sender, peer.opts);
    return { ok: true };
}

/** Địa chỉ mạng người xem gửi dần sau answer (trickle ICE). Candidate rỗng = người xem đã gom xong. */
async function addIce(msg) {
    const peer = peers.get(msg.viewerId);
    if (!peer) throw new Error(`cast: không có kết nối cho người xem ${msg.viewerId}`);
    for (const c of msg.candidates || []) {
        await peer.pc.addIceCandidate(c.candidate ? c : null).catch(() => {});
    }
    return { ok: true };
}

async function retarget(msg) {
    const ids = (msg.viewerIds || []).filter((id) => peers.has(id));
    if (ids.length === 0) return { ok: true, moved: 0 };
    const { tabId, capture } = await captureForTarget(msg.targetId, { ...peers.get(ids[0]).opts, ...msg });
    for (const id of ids) {
        const peer = peers.get(id);
        if (peer.tabId === tabId) continue;
        await peer.sender.replaceTrack(capture.track);
        if (peer.audioSender) await peer.audioSender.replaceTrack(capture.audioTrack);
        capture.users.add(id);
        releaseCapture(peer.tabId, id);
        peer.tabId = tabId;
    }
    return { ok: true, moved: ids.length };
}

/**
 * Viewport trang đổi (panel FE hẹp/rộng hơn → BE setViewport) → đổi cỡ luồng quay theo. Không đổi thì Chrome giữ cỡ lúc
 * bắt đầu và thêm VIỀN ĐEN quanh trang (đo 30/09/2026: panel 500 px, trang khổ dọc → dải hẹp giữa khung đen, chữ bị bóp).
 * Thử applyConstraints; không được / không khớp → quay lại tab với cỡ mới và thay track cho mọi người xem.
 */
async function resize(msg) {
    const results = [];
    for (const [tabId, capture] of [...captures]) {
        let ok = false;
        try {
            await capture.track.applyConstraints({ width: { max: msg.maxWidth }, height: { max: msg.maxHeight }, resizeMode: 'crop-and-scale' });
            const s = capture.track.getSettings();
            ok = Math.abs(s.width / s.height - msg.maxWidth / msg.maxHeight) < 0.02;
        } catch { ok = false; }
        if (!ok) await recapture(tabId, capture, msg);
        results.push({ tabId, via: ok ? 'constraints' : 'recapture' });
    }
    for (const peer of peers.values()) Object.assign(peer.opts, { maxWidth: msg.maxWidth, maxHeight: msg.maxHeight });
    return { ok: true, results };
}

/** Bỏ luồng quay cũ của tab, quay lại với cỡ mới, thay track (hình + tiếng) cho mọi người xem tab đó. */
async function recapture(tabId, oldCapture, opts) {
    const users = [...oldCapture.users];
    const baseOpts = peers.get(users[0])?.opts || {};
    oldCapture.track.stop();
    oldCapture.audioTrack?.stop();
    captures.delete(tabId);
    const { streamId } = await toWorker('streamId', { tabId });
    const capture = await acquireCapture(tabId, streamId, { ...baseOpts, ...opts });
    for (const id of users) {
        const peer = peers.get(id);
        if (!peer) continue;
        await peer.sender.replaceTrack(capture.track);
        if (peer.audioSender) await peer.audioSender.replaceTrack(capture.audioTrack);
        capture.users.add(id);
    }
}

async function stats() {
    const viewers = [];
    for (const [viewerId, peer] of peers) {
        const out = {};
        (await peer.pc.getStats()).forEach((r) => {
            if (r.type === 'outbound-rtp' && r.kind === 'video') {
                Object.assign(out, {
                    framesEncoded: r.framesEncoded, bytesSent: r.bytesSent, frameWidth: r.frameWidth, frameHeight: r.frameHeight,
                    framesPerSecond: r.framesPerSecond, encoder: r.encoderImplementation, qualityLimitation: r.qualityLimitationReason,
                });
            }
        });
        viewers.push({ viewerId, tabId: peer.tabId, state: peer.pc.connectionState, ...out });
    }
    return { viewers };
}

// ── Ghi phiên (Session Observer, 25/10/2026) ─────────────────────────────────────────────────────────────────────────────
// Quay tab KÈM TIẾNG → (1) PCM16 mono (mặc định 16 kHz) cho phiên âm, (2) tệp webm hình + tiếng. BE kéo phần mới định kỳ qua
// `recordPull`; trang này chỉ giữ phần chưa kéo, có trần (BE ngừng kéo thì bỏ PCM cũ nhất, video thì dừng ghi — cắt giữa tệp webm
// là hỏng tệp). Dùng chung luồng quay với người xem panel (`captures`): tab đang được quay mà KHÔNG có tiếng thì không xin được luồng
// thứ hai (Chrome từ chối) → `audio: false`, BE tự lui về phụ đề.

/** recordingId → { tabId, userKey, pcm: Int16Array[], pcmSamples, droppedSamples, media: Blob[], mediaBytes, mediaOverflow, ctx, recorder, lastPullAt, … } */
const recordings = new Map();

// BE chết giữa phiên (deploy, crash) thì không ai gọi recordStop: bản ghi + luồng quay tab chạy mãi trong Chrome hồ sơ. Không được kéo
// dữ liệu quá `maxIdleMs` → tự dừng.
setInterval(() => {
    const now = Date.now();
    for (const [id, rec] of [...recordings]) {
        if (now - rec.lastPullAt > rec.maxIdleMs) recordStop({ recordingId: id }).catch(() => {});
    }
}, 30_000);

function pcm16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
}

function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

/**
 * PCM16 mono qua AudioWorklet (pcm-worklet.js, chạy ở luồng âm thanh, không phụ thuộc luồng chính của trang).
 *
 * Context chạy ở TẦN SỐ GỐC (không truyền `sampleRate`). Đo 25/10/2026: `new AudioContext({sampleRate: 16000})` + luồng tab 48 kHz → Chrome
 * đưa luồng vào context KHÔNG đổi tần số, chỉ ~1/3 dữ liệu tới nơi (16 nghìn mẫu/giây, gắn 16 kHz thì Qwen ra rác, gắn 48 kHz thì tiếng bị
 * nén thời gian). `ctx.sampleRate` có thể bị CloakBrowser giả → báo kèm `measuredRate` (số mẫu / thời gian thật), BE theo số đo và tự đổi
 * về 16 kHz (ffmpeg) trước khi phiên âm.
 */
async function startPcm(rec, audioTrack, msg) {
    const ctx = new AudioContext();
    rec.sampleRate = ctx.sampleRate;
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const tap = new AudioWorkletNode(ctx, 'aivin-pcm-tap');
    const mute = ctx.createGain();
    mute.gain.value = 0;
    // Trần bộ đệm tính theo 48 kHz (tần số lớn nhất context có thể chạy thật).
    const maxSamples = (msg.maxBufferedSeconds || 120) * 48_000;
    tap.port.onmessage = (ev) => {
        const chunk = pcm16(ev.data);
        rec.firstChunkAt ??= Date.now();
        rec.totalSamples += chunk.length;
        rec.pcm.push(chunk);
        rec.pcmSamples += chunk.length;
        while (rec.pcmSamples > maxSamples && rec.pcm.length) {
            const dropped = rec.pcm.shift();
            rec.pcmSamples -= dropped.length;
            rec.droppedSamples += dropped.length;
        }
    };
    source.connect(tap);
    tap.connect(mute);
    mute.connect(ctx.destination);
    Object.assign(rec, { ctx, source, processor: tap, mute });
}

function startMedia(rec, capture, msg) {
    if (typeof MediaRecorder === 'undefined') return;
    const tracks = [capture.track, ...(capture.audioTrack ? [capture.audioTrack] : [])];
    const mimeType = [msg.mimeType, 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => m && MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(new MediaStream(tracks), {
        mimeType, videoBitsPerSecond: msg.videoBitsPerSecond || 600_000, audioBitsPerSecond: msg.audioBitsPerSecond || 64_000,
    });
    const maxBytes = msg.maxBufferedMediaBytes || 64 * 1024 * 1024;
    recorder.ondataavailable = (ev) => {
        if (!ev.data?.size) return;
        rec.media.push(ev.data);
        rec.mediaBytes += ev.data.size;
        if (rec.mediaBytes > maxBytes && recorder.state !== 'inactive') {
            rec.mediaOverflow = true;
            recorder.stop();
        }
    };
    recorder.start(msg.timesliceMs || 2000);
    rec.recorder = recorder;
    rec.mimeType = recorder.mimeType;
}

async function recordStart(msg) {
    const existing = recordings.get(msg.recordingId);
    if (existing) return { ok: true, reused: true, audio: !!existing.ctx, video: !!existing.recorder, mimeType: existing.mimeType };
    const { tabId, capture } = await captureForTarget(msg.targetId, { ...msg, audio: true });
    const rec = {
        tabId, userKey: `rec:${msg.recordingId}`, capture, pcm: [], pcmSamples: 0, totalSamples: 0, droppedSamples: 0, media: [], mediaBytes: 0,
        mediaOverflow: false, startedAt: Date.now(), lastPullAt: Date.now(), maxIdleMs: msg.maxIdleMs || 180_000,
    };
    capture.users.add(rec.userKey);
    recordings.set(msg.recordingId, rec);
    try {
        if (capture.audioTrack && msg.pcm !== false) await startPcm(rec, capture.audioTrack, msg);
        if (msg.video !== false) startMedia(rec, capture, msg);
        if (rec.ctx && rec.ctx.state !== 'running') await rec.ctx.resume().catch(() => {});
    } catch (e) {
        await recordStop({ recordingId: msg.recordingId }).catch(() => {});
        throw e;
    }
    return {
        ok: true, audio: !!rec.ctx, video: !!rec.recorder, mimeType: rec.mimeType, sampleRate: rec.sampleRate,
        audioContextState: rec.ctx?.state,
    };
}

/** Số mẫu / giây thật kể từ mẩu đầu tiên (cần ≥ 3 s) — kiểm tần số context có đúng như đã xin. */
function measuredRate(rec) {
    const secs = rec.firstChunkAt ? (Date.now() - rec.firstChunkAt) / 1000 : 0;
    return secs >= 3 ? Math.round(rec.totalSamples / secs) : undefined;
}

async function recordPull(msg) {
    const rec = recordings.get(msg.recordingId);
    if (!rec) return { ok: false, missing: true };
    rec.lastPullAt = Date.now();
    const chunks = rec.pcm.splice(0);
    const samples = rec.pcmSamples;
    rec.pcmSamples = 0;
    const merged = new Int16Array(samples);
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.length; }
    const blobs = rec.media.splice(0);
    rec.mediaBytes = 0;
    const media = blobs.length ? bytesToBase64(new Uint8Array(await new Blob(blobs).arrayBuffer())) : '';
    const dropped = rec.droppedSamples;
    rec.droppedSamples = 0;
    return {
        ok: true, pcm: samples ? bytesToBase64(new Uint8Array(merged.buffer)) : '', pcmSamples: samples, droppedSamples: dropped,
        media, sampleRate: rec.sampleRate, measuredRate: measuredRate(rec), audioContextState: rec.ctx?.state, mediaOverflow: rec.mediaOverflow,
        videoLive: rec.capture.track.readyState === 'live', audioLive: rec.capture.audioTrack?.readyState === 'live',
    };
}

async function recordStop(msg) {
    const rec = recordings.get(msg.recordingId);
    if (!rec) return { ok: false, missing: true };
    if (rec.recorder && rec.recorder.state !== 'inactive') {
        await new Promise((resolve) => {
            rec.recorder.addEventListener('stop', resolve, { once: true });
            rec.recorder.stop();
            setTimeout(resolve, 3000);
        });
    }
    try { rec.processor?.disconnect(); rec.source?.disconnect(); } catch { /* đã ngắt */ }
    await rec.ctx?.close().catch(() => {});
    const last = await recordPull(msg);
    recordings.delete(msg.recordingId);
    releaseCapture(rec.tabId, rec.userKey);
    return last;
}

/** Kênh tới worker còn sống không — tin nhắn tới worker hỏng thì treo im lặng (xem cast-worker-2.js recreateOffscreen). */
async function health() {
    const reply = await Promise.race([
        chrome.runtime.sendMessage({ target: 'aivin-cast-sw', type: 'ping' }).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    return { ok: reply?.ok === true };
}

// Worker hỏi trang này còn sống không (alarm 30 s).
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.target !== 'aivin-cast-offscreen' || msg.type !== 'ping') return false;
    reply({ ok: true });
    return false;
});

/** Cửa BE gọi vào (CDP Runtime.evaluate) — xem src/official-plugins/ai-browser/service/AIBrowserWebRTCService.ts. */
globalThis.aivinCast = {
    version: 5,
    health,
    recordStart,
    recordPull,
    recordStop,
    start,
    answer,
    addIce,
    retarget,
    resize,
    stop: async (msg) => { closeViewer(msg.viewerId); return { ok: true }; },
    stats,
};
