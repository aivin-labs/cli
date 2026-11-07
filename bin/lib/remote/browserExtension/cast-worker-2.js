// AIVIN Cast — phát màn hình tab của panel "Trình duyệt" qua WebRTC.
//
// Chỉ BE điều khiển, qua CDP (Runtime.evaluate) vào TRANG OFFSCREEN (`globalThis.aivinCast.*` ở offscreen.js). Extension
// không có content script, không web_accessible_resources, không externally_connectable → trang web không thấy, không
// gọi được.
//
// Vì sao BE không gọi thẳng service worker này: Chrome cho worker ngủ sau ~30 s rảnh, gắn DevTools qua CDP KHÔNG giữ nó
// thức (đo 30/09/2026: target worker biến mất, BE không đánh thức được → mở video hỏng). Trang offscreen là trang bình
// thường, không ngủ; khi cần tabCapture/debugger (chỉ có ở worker) nó nhắn `runtime.sendMessage` — tin nhắn tự đánh thức
// worker. Worker tạo sẵn trang offscreen khi khởi động; alarm 30 s đánh thức worker để dựng lại trang nếu bị đóng.
//
// ⚠️ File này phải giữ TỐI GIẢN và ÍT ĐỔI: hồ sơ trình duyệt được giữ lại giữa các lần chạy và Chrome dùng lại script
// worker đã đăng ký — đo 30/09/2026: đổi mã + tăng `version` trong manifest, Chrome VẪN chạy worker cũ. Buộc phải đổi
// worker thì ĐỔI TÊN FILE (vd cast-worker-3.js + sửa manifest) để Chrome đăng ký script mới. Logic hay đổi để ở
// offscreen.js (trang thường, nạp lại từ đĩa mỗi lần mở).

const OFFSCREEN_URL = 'offscreen.html';
const KEEPALIVE_ALARM = 'aivin-cast-keepalive';

async function ensureOffscreen() {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['USER_MEDIA'],
        justification: 'Quay tab của panel Trình duyệt và phát qua WebRTC',
    }).catch((e) => {
        // Hai lời gọi đua nhau tạo cùng lúc → lời sau báo "Only a single offscreen document may be created".
        if (!/single offscreen/i.test(String(e?.message))) throw e;
    });
}

/**
 * Đóng rồi tạo lại trang offscreen. Đo 30/09/2026: trang offscreen tạo lúc worker mới còn đang cài đặt (lần chạy đầu sau
 * khi cập nhật extension) có kênh runtime hỏng — tin nhắn tới worker treo im lặng, mở video hỏng. Trang tạo lại thì
 * chạy bình thường.
 */
async function recreateOffscreen() {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument().catch(() => {});
    await ensureOffscreen();
}

/** Trang offscreen còn trả lời không (ping qua runtime, hạn 1,5 s). */
async function offscreenHealthy() {
    if (!(await chrome.offscreen.hasDocument())) return false;
    const reply = await Promise.race([
        chrome.runtime.sendMessage({ target: 'aivin-cast-offscreen', type: 'ping' }).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    return reply?.ok === true;
}

async function tabIdOf(targetId) {
    const targets = await chrome.debugger.getTargets();
    const hit = targets.find((t) => t.id === targetId);
    if (!hit || typeof hit.tabId !== 'number') throw new Error(`cast: không tìm thấy tab của target ${targetId}`);
    return hit.tabId;
}

const handlers = {
    ping: async () => ({ ok: true }),
    /** targetId (CDP) → tabId của chrome.tabs. */
    tabId: async (msg) => ({ tabId: await tabIdOf(msg.targetId) }),
    /** streamId để quay 1 tab — trang offscreen chỉ xin khi tab chưa có luồng quay (Chrome từ chối xin thêm). */
    streamId: async (msg) => ({ streamId: await chrome.tabCapture.getMediaStreamId({ targetTabId: msg.tabId }) }),
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.target !== 'aivin-cast-sw') return false;
    const handler = handlers[msg.type];
    if (!handler) { reply({ error: `cast: lệnh lạ ${msg.type}` }); return false; }
    handler(msg).then(reply, (err) => reply({ error: String(err?.message || err) }));
    return true;
});

// Alarm 30 s: đánh thức worker, dựng lại trang offscreen nếu mất hoặc không còn trả lời.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return;
    offscreenHealthy().then((ok) => (ok ? null : recreateOffscreen())).catch(() => {});
});
// Mở trình duyệt / cài-cập nhật extension → luôn tạo MỚI trang offscreen (xem recreateOffscreen).
chrome.runtime.onStartup.addListener(() => { recreateOffscreen().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { recreateOffscreen().catch(() => {}); });

// Đường cho BE khi trang offscreen mất/hỏng: gọi vào worker để dựng lại.
globalThis.aivinCastWorker = { ensureOffscreen, recreateOffscreen, offscreenHealthy };
