import { spawn } from 'child_process';
import { CscTarget, createCscExe } from './cscExe.mjs';

/**
 * "Máy này đây" (16/11/2026): người dùng rê chuột lên dòng máy trong menu chọn máy trên web → máy hiện tên to giữa mọi màn hình + viền sáng
 * quanh mép màn hình trong vài giây. Hai máy để cạnh nhau, màn hình nào sáng lên là máy đó — không phải đọc tên Windows na ná nhau.
 *
 * Cửa sổ WinForms nổi trên cùng, KHÔNG lấy tiêu điểm (`WS_EX_NOACTIVATE`), chuột bấm xuyên qua (`WS_EX_TRANSPARENT`), không hiện trên thanh
 * tác vụ — người đang làm việc ở máy đó không bị gián đoạn. Exe biên dịch một lần (cscExe.mjs). Chỉ Windows.
 */

const SOURCE = String.raw`using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Text; using System.Text; using System.Windows.Forms; using System.Runtime.InteropServices;
class AivinIdentify : Form {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  static readonly Color Key = Color.FromArgb(255, 1, 2, 3);
  static readonly Color Accent = Color.FromArgb(255, 59, 130, 246);
  readonly string title; readonly string subtitle;
  AivinIdentify(Rectangle bounds, string title, string subtitle) {
    this.title = title; this.subtitle = subtitle;
    FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
    Bounds = bounds; BackColor = Key; TransparencyKey = Key; DoubleBuffered = true;
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var cp = base.CreateParams; cp.ExStyle |= 0x08000000 | 0x00000080 | 0x00000020 | 0x00080000 | 0x00000008; return cp; } }
  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics; float dpi = g.DpiX / 96f; int edge = (int)(10 * dpi);
    using (var pen = new SolidBrush(Accent)) {
      g.FillRectangle(pen, 0, 0, Width, edge); g.FillRectangle(pen, 0, Height - edge, Width, edge);
      g.FillRectangle(pen, 0, 0, edge, Height); g.FillRectangle(pen, Width - edge, 0, edge, Height);
    }
    using (var big = new Font("Segoe UI", 44, FontStyle.Bold)) using (var small = new Font("Segoe UI", 15)) {
      g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
      SizeF t = g.MeasureString(title, big); SizeF s = g.MeasureString(subtitle, small);
      float padX = 56 * dpi, padY = 34 * dpi, gap = 6 * dpi;
      float w = Math.Max(t.Width, s.Width) + padX * 2, h = t.Height + s.Height + gap + padY * 2;
      w = Math.Min(w, Width - edge * 4);
      var card = new RectangleF((Width - w) / 2, (Height - h) / 2, w, h);
      g.SmoothingMode = SmoothingMode.None;
      using (var path = Rounded(card, 22 * dpi)) using (var fill = new SolidBrush(Color.FromArgb(255, 17, 24, 39))) g.FillPath(fill, path);
      using (var bar = new SolidBrush(Accent)) g.FillRectangle(bar, card.X + 22 * dpi, card.Bottom - 5 * dpi, card.Width - 44 * dpi, 5 * dpi);
      var fmt = new StringFormat { Alignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap };
      using (var white = new SolidBrush(Color.White)) g.DrawString(title, big, white, new RectangleF(card.X + padX / 2, card.Y + padY, card.Width - padX, t.Height), fmt);
      using (var grey = new SolidBrush(Color.FromArgb(255, 203, 213, 225))) g.DrawString(subtitle, small, grey, new RectangleF(card.X + padX / 2, card.Y + padY + t.Height + gap, card.Width - padX, s.Height), fmt);
    }
  }
  static GraphicsPath Rounded(RectangleF r, float rad) {
    var p = new GraphicsPath(); float d = rad * 2;
    p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.X, r.Bottom - d, d, d, 90, 90); p.CloseFigure(); return p;
  }
  static string Arg(string[] a, int i) { try { return Encoding.UTF8.GetString(Convert.FromBase64String(a[i])); } catch { return ""; } }
  [STAThread] static int Main(string[] a) {
    if (a.Length < 3) return 2;
    try { SetProcessDPIAware(); } catch { }
    string title = Arg(a, 0), subtitle = Arg(a, 1); int ms; if (!int.TryParse(a[2], out ms)) ms = 2500;
    ms = Math.Max(500, Math.Min(ms, 10000));
    Application.EnableVisualStyles();
    foreach (var screen in Screen.AllScreens) new AivinIdentify(screen.Bounds, title, subtitle).Show();
    var timer = new Timer { Interval = ms }; timer.Tick += delegate { timer.Stop(); Application.Exit(); }; timer.Start();
    Application.Run();
    return 0;
  }
}
`;

const SUBTITLE = Object.freeze({
  vi: 'Máy tính này trên AIVIN',
  en: 'This computer on AIVIN',
});
/** Trần chờ tiến trình tự thoát; quá thì giết (cửa sổ không được kẹt trên màn hình người dùng). */
const KILL_GRACE_MS = 3_000;

const exe = createCscExe({ name: 'aivin-identify', source: SOURCE, refs: ['System.Windows.Forms.dll', 'System.Drawing.dll'], target: CscTarget.WINDOWS });
let current = null;

export function identifySupported(platform = process.platform) {
  return platform === 'win32' && process.env.AIVIN_IDENTIFY !== '0';
}

export function prepareIdentify({ platform = process.platform } = {}) {
  return identifySupported(platform) ? exe.prepare({ platform }) : Promise.resolve(null);
}

const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');

/** Hiện tên máy trên mọi màn hình `durationMs` ms. Đang hiện dở thì thay bằng lần mới. Trả `true` khi đã mở được cửa sổ. */
export async function showIdentify({ name, durationMs = 2500, lang = 'en', platform = process.platform, prepare = prepareIdentify, spawnImpl = spawn } = {}) {
  const file = await prepare({ platform });
  const title = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!file || !title) return false;
  const ms = Math.max(500, Math.min(Number(durationMs) || 2500, 10_000));
  try { current?.kill(); } catch { /* đã thoát */ }
  const child = spawnImpl(file, [b64(title), b64(SUBTITLE[lang] || SUBTITLE.en), String(ms)], { windowsHide: false, stdio: 'ignore' });
  current = child;
  const killer = setTimeout(() => { try { child.kill(); } catch { /* đã thoát */ } }, ms + KILL_GRACE_MS);
  killer.unref?.();
  child.on?.('exit', () => { clearTimeout(killer); if (current === child) current = null; });
  child.on?.('error', () => { clearTimeout(killer); if (current === child) current = null; });
  return true;
}
