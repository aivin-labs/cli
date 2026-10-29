/** Chữ trên menu khay hệ thống (Aivin.exe) — ghi vào launch.cfg theo ngôn ngữ máy (mascotLang). */
export const TRAY_STRINGS = Object.freeze({
  vi: {
    running: 'Đang chạy — sẵn sàng nhận việc',
    paused: 'Đang tạm dừng — từ chối mọi việc từ xa',
    stopped: 'Đang không chạy',
    notPaired: 'Chưa kết nối với Aivin',
    connecting: 'Đang kết nối…',
    open: 'Mở Aivin',
    connect: 'Kết nối máy này…',
    pause: 'Tạm dừng nhận việc',
    resume: 'Tiếp tục nhận việc',
    startup: 'Khởi động cùng Windows',
    folder: 'Mở thư mục Aivin',
    quit: 'Thoát Aivin',
    firstRun: 'Aivin đang chạy ở khay hệ thống — bấm biểu tượng để mở.',
    connectHint: 'Aivin đã ở khay hệ thống — bấm biểu tượng rồi nhập mã từ Aivin để kết nối máy này.',
    connected: 'Đã kết nối máy này với Aivin.',
    pairFailed: 'Không kết nối được — mã sai hoặc đã hết hạn. Tạo mã mới trong Aivin rồi thử lại.',
    pairPrompt: 'Nhập mã kết nối từ Aivin (khung chat → Browser ▾ → Thêm máy tính này):',
    pairOk: 'Kết nối',
    pairCancel: 'Huỷ',
    shortcut: 'Aivin — cho các agent Aivin làm việc trên máy tính này',
  },
  en: {
    running: 'Running — ready for work',
    paused: 'Paused — refusing all remote work',
    stopped: 'Not running',
    notPaired: 'Not connected to Aivin',
    connecting: 'Connecting…',
    open: 'Open Aivin',
    connect: 'Connect this computer…',
    pause: 'Pause work',
    resume: 'Resume work',
    startup: 'Start with Windows',
    folder: 'Open Aivin folder',
    quit: 'Quit Aivin',
    firstRun: 'Aivin is running in the system tray — click the icon to open it.',
    connectHint: 'Aivin is in the system tray — click the icon and enter the code from Aivin to connect this computer.',
    connected: 'This computer is now connected to Aivin.',
    pairFailed: 'Could not connect — the code is wrong or expired. Create a new code in Aivin and try again.',
    pairPrompt: 'Enter the connect code from Aivin (chat box → Browser ▾ → Add this computer):',
    pairOk: 'Connect',
    pairCancel: 'Cancel',
    shortcut: 'Aivin — lets your Aivin agents work on this computer',
  },
});

/** Chữ khác đi theo hệ điều hành (macOS: thanh menu; macOS / Linux: khởi động cùng máy thay vì cùng Windows). */
const PLATFORM_STRINGS = Object.freeze({
  darwin: {
    vi: {
      startup: 'Mở khi đăng nhập',
      firstRun: 'Aivin đang chạy trên thanh menu — bấm biểu tượng để xem.',
      connectHint: 'Aivin đã ở thanh menu — bấm biểu tượng rồi chọn "Kết nối máy này…" để nhập mã từ Aivin.',
      folder: 'Mở thư mục Aivin trong Finder',
    },
    en: {
      startup: 'Open at login',
      firstRun: 'Aivin is running in the menu bar — click its icon to see it.',
      connectHint: 'Aivin is in the menu bar — click its icon, then "Connect this computer…" to enter the code from Aivin.',
      folder: 'Show Aivin folder in Finder',
    },
  },
  linux: {
    vi: { startup: 'Khởi động cùng máy' },
    en: { startup: 'Start at login' },
  },
});

export function trayStrings(lang, platform = 'win32') {
  const code = TRAY_STRINGS[lang] ? lang : 'en';
  return { ...TRAY_STRINGS[code], ...(PLATFORM_STRINGS[platform]?.[code] || {}) };
}
