import { spawn } from 'child_process';
import { CscTarget, createCscExe } from './cscExe.mjs';

/**
 * Lớp phủ "AI đang điều khiển máy" (17/11/2026, user: "khi agent điều khiển máy có lớp overlay màu sắc như AIBrowser"): khi Planner gọi công
 * cụ `gui.*`, mép mọi màn hình phát sáng một dải màu chạy vòng quanh + nhãn một dòng giữa đáy màn hình chính ("AIVIN đang bấm · Excel").
 * Hết việc vài giây thì mờ dần rồi tắt.
 *
 * - Cửa sổ nổi trên cùng, không lấy tiêu điểm, chuột bấm xuyên qua, không lên thanh tác vụ (như identifyOverlay) — người dùng vẫn làm việc
 *   bình thường; WindowFromPoint bỏ qua cửa sổ layered + transparent nên phép kiểm "điểm bấm có bị che" của host không vấp lớp phủ.
 * - Vẽ bằng UpdateLayeredWindow (trong suốt từng điểm ảnh) trên 4 dải mỏng quanh mép mỗi màn hình, không phải một cửa sổ cả màn hình: mỗi
 *   khung hình chỉ tô vài trăm nghìn điểm ảnh.
 * - `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`: lớp phủ KHÔNG lọt vào ảnh chụp màn hình (ảnh observe / OCR của agent, phiên cast) —
 *   lọt vào thì VLM / OCR đọc nhầm viền thành giao diện. Máy không hỗ trợ (Windows < 10 bản 2004) → exe thoát mã 3 trước khi hiện gì, và
 *   lớp phủ tắt hẳn cho phiên này: thà không có viền còn hơn làm bẩn ảnh agent nhìn.
 * - Một tiến trình sống lâu, nhận lệnh qua stdin (`show\t<b64 chữ nhãn>` / `hide` / `quit`); stdin đóng (daemon chết) →
 *   exe tự thoát, viền không kẹt trên màn hình. Rảnh lâu thì thoát hẳn cho nhẹ máy, lần sau dựng lại.
 * Chỉ Windows. Tắt bằng AIVIN_AGENT_OVERLAY=0.
 */

const SOURCE = String.raw`using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Drawing.Text; using System.IO; using System.Runtime.InteropServices; using System.Text; using System.Threading; using System.Windows.Forms;
static class N {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
  [DllImport("user32.dll")] public static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref PT pos, ref SZ size, IntPtr src, ref PT srcPos, int key, ref BLEND blend, int flags);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr dc, ref BMI bmi, uint usage, out IntPtr bits, IntPtr sec, uint off);
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SZ { public int W, H; }
  [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct BLEND { public byte Op, Flags, Alpha, Format; }
  [StructLayout(LayoutKind.Sequential)] public struct BMI { public int Size, Width, Height; public short Planes, Bits; public int Compression, SizeImage, XPels, YPels, ClrUsed, ClrImportant, Color0; }
}
class Layer : Form {
  public Rectangle R { get; private set; } public readonly int[] Px; IntPtr mem, bmp, old, bits;
  public Layer(Rectangle r) {
    R = r; Px = new int[r.Width * r.Height];
    FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual; Bounds = r;
    IntPtr screen = N.GetDC(IntPtr.Zero); mem = N.CreateCompatibleDC(screen);
    var bmi = new N.BMI(); bmi.Size = 40; bmi.Width = r.Width; bmi.Height = -r.Height; bmi.Planes = 1; bmi.Bits = 32;
    bmp = N.CreateDIBSection(screen, ref bmi, 0, out bits, IntPtr.Zero, 0); old = N.SelectObject(mem, bmp); N.ReleaseDC(IntPtr.Zero, screen);
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var cp = base.CreateParams; cp.ExStyle |= 0x08000000 | 0x00000080 | 0x00000020 | 0x00080000 | 0x00000008; return cp; } }
  protected override void OnPaintBackground(PaintEventArgs e) { }
  protected override void OnPaint(PaintEventArgs e) { }
  public void Push(byte alpha, bool pixels) {
    if (bits == IntPtr.Zero) return;
    if (pixels) Marshal.Copy(Px, 0, bits, Px.Length);
    IntPtr screen = N.GetDC(IntPtr.Zero);
    var pos = new N.PT(); pos.X = R.X; pos.Y = R.Y; var size = new N.SZ(); size.W = R.Width; size.H = R.Height; var src = new N.PT();
    var bl = new N.BLEND(); bl.Alpha = alpha; bl.Format = 1;
    N.UpdateLayeredWindow(Handle, screen, ref pos, ref size, mem, ref src, 0, ref bl, 2);
    N.ReleaseDC(IntPtr.Zero, screen);
  }
  public void Raise() { N.SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0200); }
  protected override void Dispose(bool disposing) {
    if (mem != IntPtr.Zero) { N.SelectObject(mem, old); N.DeleteObject(bmp); N.DeleteDC(mem); mem = IntPtr.Zero; bits = IntPtr.Zero; }
    base.Dispose(disposing);
  }
}
class Strip {
  public Layer L; public int Side; public int Sw, Sh, T, Line; public float[] Fall;
  // Side: 0 trên, 1 phải, 2 dưới, 3 trái. Dải trên / dưới phủ cả góc, dải trái / phải chỉ phần giữa.
  public void Render(double phase) {
    int w = L.R.Width, h = L.R.Height; bool alongX = Side == 0 || Side == 2; int len = alongX ? w : h; double per = 2.0 * (Sw + Sh);
    var col = new int[len];
    for (int k = 0; k < len; k++) {
      double along;
      if (Side == 0) along = k; else if (Side == 1) along = Sw + T + k; else if (Side == 2) along = Sw + Sh + (Sw - 1 - k); else along = 2 * Sw + Sh + (Sh - T - 1 - k);
      col[k] = App.Palette(along / per * 2.0 + phase);
    }
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      int k = alongX ? x : y, d;
      if (Side == 0) d = y; else if (Side == 2) d = h - 1 - y; else if (Side == 1) d = w - 1 - x; else d = x;
      if (alongX) { if (x < T) d = Math.Min(d, x); else if (x >= w - T) d = Math.Min(d, w - 1 - x); }
      float a = Fall[d]; int c = col[k];
      int A = (int)(a * 255), Rr = (int)(((c >> 16) & 255) * a), G = (int)(((c >> 8) & 255) * a), B = (int)((c & 255) * a);
      L.Px[y * w + x] = (A << 24) | (Rr << 16) | (G << 8) | B;
    }
  }
}
static class App {
  static readonly int[] Stops = { 0x3B82F6, 0x8B5CF6, 0xEC4899, 0x22D3EE };
  public static int Palette(double t) {
    t = t - Math.Floor(t); double p = t * Stops.Length; int i = (int)p % Stops.Length, j = (i + 1) % Stops.Length; double f = p - Math.Floor(p);
    int a = Stops[i], b = Stops[j];
    int r = (int)(((a >> 16) & 255) * (1 - f) + ((b >> 16) & 255) * f), g = (int)(((a >> 8) & 255) * (1 - f) + ((b >> 8) & 255) * f), bl = (int)((a & 255) * (1 - f) + (b & 255) * f);
    return (r << 16) | (g << 8) | bl;
  }
  static readonly List<Strip> strips = new List<Strip>(); static Layer label; static Rectangle area; static float dpi = 1;
  static string text = ""; static bool want; static double level, phase; static int ticks;
  static System.Windows.Forms.Timer timer; static Control ui;
  static string Dec(string s) { try { return Encoding.UTF8.GetString(Convert.FromBase64String(s)); } catch { return ""; } }
  static void Exclude(Layer l) {
    // Không loại được khỏi ảnh chụp → thoát trước khi hiện: viền mà lọt vào ảnh observe / OCR thì agent đọc nhầm.
    if (!N.SetWindowDisplayAffinity(l.Handle, 0x11)) { Console.Out.WriteLine("noexclude"); Console.Out.Flush(); Environment.Exit(3); }
  }
  static void Build() {
    using (var g = Graphics.FromHwnd(IntPtr.Zero)) dpi = g.DpiX / 96f;
    int T = Math.Max(10, (int)(28 * dpi)), line = Math.Max(2, (int)(3 * dpi));
    var fall = new float[T];
    for (int d = 0; d < T; d++) { double u = 1.0 - (double)d / T; fall[d] = d < line ? 1f : (float)(0.9 * Math.Pow(u, 1.7)); }
    foreach (var s in Screen.AllScreens) {
      var b = s.Bounds; if (b.Width < 4 * T || b.Height < 4 * T) continue;
      var rects = new[] { new Rectangle(b.X, b.Y, b.Width, T), new Rectangle(b.Right - T, b.Y + T, T, b.Height - 2 * T), new Rectangle(b.X, b.Bottom - T, b.Width, T), new Rectangle(b.X, b.Y + T, T, b.Height - 2 * T) };
      for (int i = 0; i < 4; i++) {
        var st = new Strip(); st.L = new Layer(rects[i]); st.Side = i; st.Sw = b.Width; st.Sh = b.Height; st.T = T; st.Line = line; st.Fall = fall;
        Exclude(st.L); strips.Add(st);
      }
    }
    area = Screen.PrimaryScreen.WorkingArea;
  }
  static void Teardown() {
    foreach (var s in strips) { s.L.Hide(); s.L.Dispose(); }
    strips.Clear();
    if (label != null) { label.Hide(); label.Dispose(); label = null; }
  }
  static GraphicsPath Rounded(RectangleF r, float rad) {
    var p = new GraphicsPath(); float d = rad * 2;
    p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.X, r.Bottom - d, d, d, 90, 90); p.CloseFigure(); return p;
  }
  static void RenderLabel(byte alpha) {
    using (var font = new Font("Segoe UI Semibold", 10f * dpi, GraphicsUnit.Point)) {
      SizeF ts;
      using (var probe = new Bitmap(1, 1)) using (var g0 = Graphics.FromImage(probe)) ts = g0.MeasureString(text, font);
      float padX = 14 * dpi, padY = 7 * dpi, dot = 9 * dpi, gap = 9 * dpi, slack = 6 * dpi;
      int pw = (int)Math.Min(ts.Width + slack + padX * 2 + dot + gap, area.Width - 40 * dpi);
      int ph = (int)(ts.Height + padY * 2);
      if (label == null || label.R.Width < pw || label.R.Height != ph) {
        if (label != null) { label.Hide(); label.Dispose(); }
        int lw = Math.Max(pw, (int)(320 * dpi));
        label = new Layer(new Rectangle(area.X + (area.Width - lw) / 2, area.Bottom - ph - (int)(18 * dpi), lw, ph)); Exclude(label);
      }
      int W = label.R.Width, H = label.R.Height;
      using (var bmp = new Bitmap(W, H, PixelFormat.Format32bppPArgb)) {
        using (var g = Graphics.FromImage(bmp)) {
          g.Clear(Color.Transparent); g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
          var card = new RectangleF((W - pw) / 2f + 0.5f, 0.5f, pw - 1, H - 1);
          int c = Palette(phase), c2 = Palette(phase + 0.25);
          using (var path = Rounded(card, H / 2f - 1)) {
            using (var fill = new SolidBrush(Color.FromArgb(236, 17, 24, 39))) g.FillPath(fill, path);
            using (var lg = new LinearGradientBrush(card, Color.FromArgb(255, Color.FromArgb(c)), Color.FromArgb(255, Color.FromArgb(c2)), 0f)) using (var pen = new Pen(lg, 1.5f * dpi)) g.DrawPath(pen, path);
          }
          float pulse = (float)(0.55 + 0.45 * Math.Sin(ticks * 0.25));
          float cx = card.X + padX + dot / 2, cy = H / 2f;
          using (var halo = new SolidBrush(Color.FromArgb((int)(90 * pulse), Color.FromArgb(c)))) g.FillEllipse(halo, cx - dot, cy - dot, dot * 2, dot * 2);
          using (var dotB = new SolidBrush(Color.FromArgb(255, Color.FromArgb(c)))) g.FillEllipse(dotB, cx - dot / 2, cy - dot / 2, dot, dot);
          float tx = card.X + padX + dot + gap, tw = card.Right - padX - tx + slack;
          var fmt = new StringFormat { Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap, LineAlignment = StringAlignment.Center };
          using (var white = new SolidBrush(Color.White)) g.DrawString(text, font, white, new RectangleF(tx, 0, tw, H), fmt);
        }
        var data = bmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
        try { Marshal.Copy(data.Scan0, label.Px, 0, label.Px.Length); } finally { bmp.UnlockBits(data); }
      }
    }
    label.Push(alpha, true);
    if (!label.Visible) label.Show();
  }
  static void Tick(object sender, EventArgs e) {
    ticks++;
    level = want ? Math.Min(1, level + 0.2) : Math.Max(0, level - 0.1);
    if (!want && level <= 0) { Teardown(); timer.Stop(); return; }
    if (strips.Count == 0) Build();
    phase += 0.008;
    byte glow = (byte)(255 * level * (0.8 + 0.2 * Math.Sin(ticks * 0.13)));
    foreach (var s in strips) { s.Render(phase); s.L.Push(glow, true); if (!s.L.Visible) s.L.Show(); }
    RenderLabel((byte)(255 * level));
    // Cửa sổ khác cũng "trên cùng" (thanh tác vụ, video toàn màn hình) có thể đè lên: thỉnh thoảng giành lại.
    if (ticks % 20 == 0) { foreach (var s in strips) s.L.Raise(); if (label != null) label.Raise(); }
  }
  static void Command(string line) {
    var p = line.Split('\t');
    if (p[0] == "show") {
      text = p.Length > 1 ? Dec(p[1]) : "";
      if (!want) { want = true; if (strips.Count == 0) Build(); timer.Start(); }
    } else if (p[0] == "hide") want = false;
    else if (p[0] == "quit") Application.Exit();
  }
  [STAThread] static int Main(string[] a) {
    try { N.SetProcessDPIAware(); } catch { }
    Application.EnableVisualStyles();
    ui = new Control(); ui.CreateControl(); var unused = ui.Handle;
    timer = new System.Windows.Forms.Timer(); timer.Interval = 50; timer.Tick += Tick;
    if (a.Length > 0 && a[0] == "--probe") { Build(); Teardown(); return 0; }
    var reader = new Thread(delegate () {
      try {
        var r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)); string line;
        while ((line = r.ReadLine()) != null) { var l = line.Trim(); if (l.Length > 0) ui.BeginInvoke((MethodInvoker)delegate { Command(l); }); }
      } catch { }
      try { ui.BeginInvoke((MethodInvoker)delegate { Application.Exit(); }); } catch { Environment.Exit(0); }
    });
    reader.IsBackground = true; reader.Start();
    Application.Run();
    return 0;
  }
}
`;

/** Loại việc đang làm — quyết định chữ trên nhãn. */
export const OverlayActivity = Object.freeze({
  LOOK: 'look', CLICK: 'click', TYPE: 'type', KEY: 'key', SCROLL: 'scroll', SELECT: 'select', DRAG: 'drag', FOCUS: 'focus', OPEN: 'open',
});

/** Nhãn MỘT dòng (user: "1 dòng thôi, 2 dòng làm gì"): "AIVIN đang bấm · Excel". */
const TEXT = Object.freeze({
  vi: {
    look: 'AIVIN đang xem màn hình', click: 'AIVIN đang bấm', type: 'AIVIN đang gõ', key: 'AIVIN đang nhấn phím', scroll: 'AIVIN đang cuộn',
    select: 'AIVIN đang chọn', drag: 'AIVIN đang kéo thả', focus: 'AIVIN đang chuyển cửa sổ', open: 'AIVIN đang mở ứng dụng',
  },
  en: {
    look: 'AIVIN is looking at the screen', click: 'AIVIN is clicking', type: 'AIVIN is typing', key: 'AIVIN is pressing keys',
    scroll: 'AIVIN is scrolling', select: 'AIVIN is selecting', drag: 'AIVIN is dragging', focus: 'AIVIN is switching windows', open: 'AIVIN is opening an app',
  },
});

/** Sau việc cuối cùng chừng này thì viền mờ dần — đủ dài để các bước liền nhau của một nhiệm vụ không làm viền nhấp nháy. */
export const OVERLAY_IDLE_MS = 3_000;
/** Hiện viền sau chừng này kể từ lúc thao tác bắt đầu (thao tác xong sớm hơn mà thành công thì hiện ngay lúc xong). */
const SHOW_DELAY_MS = 120;
/** Rảnh chừng này thì cho exe thoát hẳn (lần sau dựng lại ~50 ms). */
const EXIT_AFTER_MS = 2 * 60_000;
/** Exe chết sớm hơn chừng này sau khi chạy là coi như hỏng; hai lần liền thì thôi cả phiên. */
const QUICK_EXIT_MS = 5_000;
const EXIT_NO_EXCLUDE = 3;

const exe = createCscExe({ name: 'aivin-agent-overlay', source: SOURCE, refs: ['System.Windows.Forms.dll', 'System.Drawing.dll'], target: CscTarget.WINDOWS });

export function agentOverlaySupported(platform = process.platform, env = process.env) {
  return platform === 'win32' && env.AIVIN_AGENT_OVERLAY !== '0';
}

export function prepareAgentOverlay({ platform = process.platform } = {}) {
  return agentOverlaySupported(platform) ? exe.prepare({ platform }) : Promise.resolve(null);
}

const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
const HANDLE_RE = /^0x[0-9a-f]+$/i;

/** Tên ứng dụng hiển thị trên nhãn: bỏ handle "0x…", bỏ ".exe", gọn khoảng trắng, cắt ngắn. */
export function overlayAppName(app) {
  const s = String(app ?? '').replace(/\s+/g, ' ').trim().replace(/\.exe$/i, '');
  if (!s || HANDLE_RE.test(s)) return '';
  return s.length > 48 ? `${s.slice(0, 47)}…` : s;
}

export function overlayText({ kind, app } = {}, lang = 'en') {
  const t = TEXT[lang] || TEXT.en;
  const verb = t[kind] || t.look;
  const name = overlayAppName(app);
  return name ? `${verb} · ${name}` : verb;
}

/**
 * Bộ điều khiển lớp phủ. `begin({ kind, app })` lúc một công cụ gui bắt đầu, gọi hàm trả về `end(ok)` khi nó xong; còn việc thì viền còn
 * sáng, hết việc `idleMs` thì tắt. Không bao giờ ném lỗi ra ngoài — lớp phủ là phần phụ, không được làm hỏng thao tác.
 */
export function createAgentOverlay({
  lang = () => 'en', platform = process.platform, env = process.env, prepare = prepareAgentOverlay, spawnImpl = spawn,
  idleMs = OVERLAY_IDLE_MS, exitAfterMs = EXIT_AFTER_MS, showDelayMs = SHOW_DELAY_MS, now = Date.now,
} = {}) {
  let disabled = !agentOverlaySupported(platform, env);
  let child = null;
  let starting = null;
  let busy = 0;
  let wanted = false;
  let shown = '';
  let idleTimer = null;
  let exitTimer = null;
  let quickExits = 0;

  const clear = (t) => { if (t) clearTimeout(t); return null; };
  const send = (line) => {
    try { child?.stdin?.write(`${line}\n`); return !!child; } catch { return false; }
  };

  function spawnChild(file) {
    const startedAt = now();
    const c = spawnImpl(file, [], { windowsHide: false, stdio: ['pipe', 'pipe', 'ignore'] });
    c.stdin?.on?.('error', () => {});
    c.stdout?.on?.('data', (d) => { if (String(d).includes('noexclude')) disabled = true; });
    const gone = (code) => {
      if (child !== c) return;
      child = null;
      shown = '';
      if (code === EXIT_NO_EXCLUDE) disabled = true;
      if (now() - startedAt < QUICK_EXIT_MS && code !== 0) quickExits += 1;
      if (quickExits >= 2) disabled = true;
    };
    c.on?.('exit', gone);
    c.on?.('error', () => gone(-1));
    return c;
  }

  async function ensure() {
    if (disabled) return null;
    if (child) return child;
    if (!starting) {
      starting = Promise.resolve()
        .then(() => prepare({ platform }))
        .then((file) => { if (file && !disabled && !child) child = spawnChild(file); return child; })
        .catch(() => null)
        .finally(() => { starting = null; });
    }
    return starting;
  }

  function push(activity) {
    if (!wanted) return;
    const line = `show\t${b64(overlayText(activity, safeLang()))}`;
    void ensure().then((c) => {
      if (!c || !wanted || line === shown) return;
      if (send(line)) shown = line;
    });
  }

  function safeLang() {
    try { return lang() || 'en'; } catch { return 'en'; }
  }

  function hide() {
    idleTimer = clear(idleTimer);
    if (busy > 0) return;
    wanted = false;
    if (shown) send('hide');
    shown = '';
    exitTimer = clear(exitTimer);
    exitTimer = setTimeout(() => {
      exitTimer = null;
      if (wanted || !child) return;
      try { child.stdin?.end(); } catch { /* đã đóng */ }
    }, exitAfterMs);
    exitTimer.unref?.();
  }

  function begin(activity = {}) {
    if (disabled) return () => {};
    busy += 1;
    wanted = true;
    idleTimer = clear(idleTimer);
    exitTimer = clear(exitTimer);
    // Hiện trễ một chút: thao tác bị từ chối ngay (ứng dụng bị chặn, tham số sai) thì không nháy viền "AIVIN đang bấm" cho việc không làm.
    let pending = setTimeout(() => { pending = null; try { push(activity); } catch { /* phụ */ } }, showDelayMs);
    pending.unref?.();
    let ended = false;
    return (ok = true) => {
      if (ended) return;
      ended = true;
      if (pending) {
        pending = clear(pending);
        if (ok) { try { push(activity); } catch { /* phụ */ } }
      }
      busy = Math.max(0, busy - 1);
      if (busy > 0) return;
      idleTimer = clear(idleTimer);
      idleTimer = setTimeout(hide, idleMs);
      idleTimer.unref?.();
    };
  }

  function close() {
    busy = 0;
    wanted = false;
    idleTimer = clear(idleTimer);
    exitTimer = clear(exitTimer);
    const c = child;
    child = null;
    shown = '';
    if (!c) return;
    try { c.stdin?.end(); } catch { /* đã đóng */ }
    const killer = setTimeout(() => { try { c.kill(); } catch { /* đã thoát */ } }, 2_000);
    killer.unref?.();
  }

  return { begin, close, get disabled() { return disabled; } };
}
