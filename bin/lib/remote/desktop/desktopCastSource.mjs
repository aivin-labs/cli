/**
 * Tiến trình phát hình ảnh màn hình trực tiếp và điều khiển từ xa trên Windows (Desktop Scenecast).
 * Tương thích C# 5 / .NET Framework 4.5+ / PowerShell 5.1:
 * - Chụp màn hình bằng Desktop Duplication, lùi Graphics.CopyFromScreen khi không dùng được (desktopCastCaptureSource.mjs).
 * - Con trỏ: gửi vị trí + hình riêng để FE vẽ tức thì; người xem chưa hỗ trợ / đường JPEG thì lồng vào khung hình (GetCursorInfo + DrawIcon).
 * - Hỗ trợ đa màn hình: lấy danh sách màn hình và chuyển đổi màn hình cần chụp theo thời gian thực.
 * - Co ảnh về chiều rộng tối đa (giữ tỉ lệ), nén ảnh sang định dạng JPEG nhẹ.
 * - So sánh nguyên khung (memcmp) để chỉ gửi khi hình đổi hoặc giữ nhịp định kỳ (1 FPS): thay đổi nhỏ như con trỏ, gõ chữ cũng phải đi ngay
 *   (đo 03/11/2026: ảnh thu nhỏ 64x36 + ngưỡng làm chúng chờ tới nhịp 1 s). Đường JPEG thì đổi nhỏ giới hạn 5 khung/giây, đỡ tải máy chủ.
 * - Nhận lệnh chuột, bàn phím và phím tắt hệ thống (hotkeys) qua stdin và thực thi qua Win32 API.
 * - Hỗ trợ thay đổi độ phân giải, chất lượng nén JPEG, giới hạn FPS và chọn màn hình theo thời gian thực.
 * - Luồng video (02/11/2026): có `pipe` → mở named pipe gửi khung thô I420 ([rộng, cao, độ dài] int32 LE + dữ liệu) cho Node đưa vào
 *   RTCVideoSource (WebRTC tự mã hoá VP8, chỉ gửi phần đổi). JPEG chỉ nén khi còn người xem cần (`jpeg` qua config); không thì gửi dòng
 *   `meta` (kích thước, màn hình) để FE quy đổi toạ độ.
 */

import { DESKTOP_CAST_CAPTURE_CSHARP } from './desktopCastCaptureSource.mjs';

export const DESKTOP_CAST_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

namespace AivinDesktopCast {
  static class Native {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, ushort bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);

    // Gõ chữ: keybd_event chỉ mang được 1 byte mã quét (BYTE bScan) → chữ ngoài Latin-1 (ư ơ đ ạ ế…) bị cắt thành ký tự rác.
    // SendInput + KEYEVENTF_UNICODE mang đủ 16 bit mỗi đơn vị UTF-16.
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    public const uint INPUT_KEYBOARD = 1;

    // Ô nhập chữ đang có tiêu điểm: cửa sổ trước mặt có caret hệ thống (ô Win32, Office, Chromium / Edge đều tạo caret cho trợ năng).
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int left; public int top; public int right; public int bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO {
      public int cbSize; public uint flags; public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture;
      public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret;
    }
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO {
      public int cbSize;
      public int flags;
      public IntPtr hCursor;
      public POINT ptScreenPos;
    }

    [DllImport("user32.dll")] public static extern bool GetCursorInfo(out CURSORINFO pci);
    [DllImport("user32.dll")] public static extern bool DrawIcon(IntPtr hDC, int X, int Y, IntPtr hIcon);
    [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int memcmp(IntPtr a, IntPtr b, UIntPtr count);
    [DllImport("kernel32.dll", EntryPoint = "RtlMoveMemory")] public static extern void CopyMemory(IntPtr dst, IntPtr src, uint count);
    [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
    [DllImport("kernel32.dll")] public static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
    [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO info);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern int GetObject(IntPtr obj, int size, out BITMAP bm);
    [DllImport("gdi32.dll")] public static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint lines, [Out] int[] bits, ref BITMAPINFOHEADER info, uint usage);

    [StructLayout(LayoutKind.Sequential)]
    public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }

    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAP { public int bmType; public int bmWidth; public int bmHeight; public int bmWidthBytes; public ushort bmPlanes; public ushort bmBitsPixel; public IntPtr bmBits; }

    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFOHEADER {
      public int biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount;
      public int biCompression; public int biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter; public int biClrUsed; public int biClrImportant;
    }

    public const int CURSOR_SHOWING = 0x00000001;

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x01000;

    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
  }

  static class Out {
    static readonly object gate = new object();
    static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

    public static void Send(Dictionary<string, object> msg) {
      string line = json.Serialize(msg);
      lock (gate) { Console.Out.WriteLine(line); Console.Out.Flush(); }
    }

    public static Dictionary<string, object> Parse(string text) {
      if (string.IsNullOrEmpty(text)) return new Dictionary<string, object>();
      return json.Deserialize<Dictionary<string, object>>(text);
    }

    public static Dictionary<string, object> Msg(string t) {
      var d = new Dictionary<string, object>();
      d["t"] = t;
      return d;
    }
  }

  /** Named pipe một chiều gửi khung thô cho tiến trình Node (một khách). Khách rớt → chờ khách mới. */
  static class RawPipe {
    static readonly object gate = new object();
    static NamedPipeServerStream pipe;
    public static volatile bool Connected;

    public static void Start(string name) {
      var t = new Thread(() => {
        while (CastHost.Running) {
          try {
            var p = new NamedPipeServerStream(name, PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.None, 0, 4 * 1024 * 1024);
            p.WaitForConnection();
            lock (gate) { pipe = p; Connected = true; }
            while (CastHost.Running && p.IsConnected) Thread.Sleep(200);
          } catch {
            Thread.Sleep(300);
          } finally {
            lock (gate) { Connected = false; if (pipe != null) { try { pipe.Dispose(); } catch { } pipe = null; } }
          }
        }
      });
      t.IsBackground = true;
      t.Start();
    }

    public static void Write(int width, int height, byte[] data) {
      lock (gate) {
        if (pipe == null || !Connected) return;
        try {
          var header = new byte[12];
          BitConverter.GetBytes(width).CopyTo(header, 0);
          BitConverter.GetBytes(height).CopyTo(header, 4);
          BitConverter.GetBytes(data.Length).CopyTo(header, 8);
          pipe.Write(header, 0, 12);
          pipe.Write(data, 0, data.Length);
          pipe.Flush();
        } catch {
          Connected = false;
          try { pipe.Dispose(); } catch { }
          pipe = null;
        }
      }
    }
  }

  public static class CastScreen {
    /** BGRX 32 bit → I420 (Y đủ, U/V lấy trung bình khối 2x2); kích thước cắt về số chẵn. */
    public static byte[] ToI420(Bitmap bmp, out int w, out int h) {
      w = bmp.Width & ~1;
      h = bmp.Height & ~1;
      var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
      try {
        int stride = Math.Abs(data.Stride);
        var raw = new byte[stride * h];
        Marshal.Copy(data.Scan0, raw, 0, raw.Length);
        int ySize = w * h;
        int cw = w / 2;
        var outBuf = new byte[ySize + ySize / 2];
        int uBase = ySize;
        int vBase = ySize + ySize / 4;
        for (int y = 0; y < h; y++) {
          int row = y * stride;
          int yRow = y * w;
          for (int x = 0; x < w; x++) {
            int i = row + x * 4;
            int b = raw[i], g = raw[i + 1], r = raw[i + 2];
            outBuf[yRow + x] = (byte)(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
          }
        }
        for (int y = 0; y < h; y += 2) {
          int row0 = y * stride;
          int row1 = row0 + stride;
          int cRow = (y / 2) * cw;
          for (int x = 0; x < w; x += 2) {
            int i0 = row0 + x * 4, i1 = i0 + 4, i2 = row1 + x * 4, i3 = i2 + 4;
            int b = (raw[i0] + raw[i1] + raw[i2] + raw[i3]) >> 2;
            int g = (raw[i0 + 1] + raw[i1 + 1] + raw[i2 + 1] + raw[i3 + 1]) >> 2;
            int r = (raw[i0 + 2] + raw[i1 + 2] + raw[i2 + 2] + raw[i3 + 2]) >> 2;
            int ci = cRow + x / 2;
            outBuf[uBase + ci] = (byte)(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
            outBuf[vBase + ci] = (byte)(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
          }
        }
        return outBuf;
      } finally {
        bmp.UnlockBits(data);
      }
    }

    public static Rectangle GetBounds(int monitor) {
      if (monitor < 0 || monitor >= Screen.AllScreens.Length) {
        return SystemInformation.VirtualScreen;
      }
      return Screen.AllScreens[monitor].Bounds;
    }

    public static List<Dictionary<string, object>> GetScreens() {
      var list = new List<Dictionary<string, object>>();
      var all = Screen.AllScreens;
      for (int i = 0; i < all.Length; i++) {
        var s = all[i];
        var d = new Dictionary<string, object>();
        d["index"] = i;
        d["name"] = "Màn hình " + (i + 1) + (s.Primary ? " (Chính)" : "");
        d["primary"] = s.Primary;
        d["width"] = s.Bounds.Width;
        d["height"] = s.Bounds.Height;
        d["x"] = s.Bounds.X;
        d["y"] = s.Bounds.Y;
        list.Add(d);
      }
      return list;
    }

    /** Chụp vùng màn hình vào ảnh có sẵn (không kèm con trỏ). */
    public static void CopyScreen(Bitmap dst, Rectangle r) {
      using (var g = Graphics.FromImage(dst)) {
        g.CopyFromScreen(r.Left, r.Top, 0, 0, r.Size);
      }
    }

    /** Bản sao của khung có lồng con trỏ thật của Windows (đường JPEG / người xem chưa tự vẽ con trỏ). */
    public static Bitmap WithCursor(Bitmap src, Rectangle r) {
      var copy = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppRgb);
      using (var g = Graphics.FromImage(copy)) {
        g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
        g.DrawImageUnscaled(src, 0, 0);
        try {
          Native.CURSORINFO pci;
          pci.cbSize = Marshal.SizeOf(typeof(Native.CURSORINFO));
          if (Native.GetCursorInfo(out pci) && (pci.flags & Native.CURSOR_SHOWING) != 0) {
            var hot = CursorTracker.Hotspot(pci.hCursor);
            int cursorX = pci.ptScreenPos.x - hot.X - r.Left;
            int cursorY = pci.ptScreenPos.y - hot.Y - r.Top;
            if (cursorX >= -32 && cursorX < r.Width && cursorY >= -32 && cursorY < r.Height) {
              IntPtr hdc = g.GetHdc();
              try {
                Native.DrawIcon(hdc, cursorX, cursorY, pci.hCursor);
              } finally {
                g.ReleaseHdc(hdc);
              }
            }
          }
        } catch {}
      }
      return copy;
    }

    public static Bitmap Scale(Bitmap src, int maxWidth) {
      if (src.Width <= maxWidth) return src;
      int h = (int)Math.Round(src.Height * (double)maxWidth / src.Width);
      var dst = new Bitmap(maxWidth, h, PixelFormat.Format32bppRgb);
      using (var g = Graphics.FromImage(dst)) {
        g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
        g.DrawImage(src, 0, 0, maxWidth, h);
      }
      return dst;
    }

    public static byte[] Jpeg(Bitmap bmp, int quality) {
      var encoders = ImageCodecInfo.GetImageEncoders();
      ImageCodecInfo codec = null;
      for (int i = 0; i < encoders.Length; i++) {
        if (encoders[i].MimeType == "image/jpeg") { codec = encoders[i]; break; }
      }
      if (codec == null) {
        using (var ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Jpeg); return ms.ToArray(); }
      }
      var p = new EncoderParameters(1);
      p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
      using (var ms = new MemoryStream()) {
        bmp.Save(ms, codec, p);
        return ms.ToArray();
      }
    }

    public static byte[] Thumb(Bitmap src) {
      var t = new byte[64 * 36];
      using (var small = new Bitmap(64, 36, PixelFormat.Format24bppRgb)) {
        using (var g = Graphics.FromImage(small)) {
          g.DrawImage(src, 0, 0, 64, 36);
        }
        var data = small.LockBits(new Rectangle(0, 0, 64, 36), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try {
          int stride = Math.Abs(data.Stride);
          var raw = new byte[stride * 36];
          Marshal.Copy(data.Scan0, raw, 0, raw.Length);
          for (int y = 0; y < 36; y++) {
            int rowOffset = y * stride;
            int outOffset = y * 64;
            for (int x = 0; x < 64; x++) {
              int idx = rowOffset + x * 3;
              int b = raw[idx];
              int gVal = raw[idx + 1];
              int r = raw[idx + 2];
              t[outOffset + x] = (byte)((r * 3 + gVal * 6 + b) / 10);
            }
          }
        } finally {
          small.UnlockBits(data);
        }
      }
      return t;
    }

    public static double Diff(byte[] a, byte[] b) {
      if (a == null || b == null) return 255;
      long s = 0;
      for (int i = 0; i < a.Length; i++) s += Math.Abs(a[i] - b[i]);
      return (double)s / a.Length;
    }

    /** Hai khung giống hệt từng điểm ảnh — ~0,3 ms ở 1080p, rẻ hơn tạo ảnh thu nhỏ. */
    public static bool SameFrame(Bitmap a, Bitmap b) {
      if (a == null || b == null || a.Width != b.Width || a.Height != b.Height) return false;
      var rect = new Rectangle(0, 0, a.Width, a.Height);
      var da = a.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
      try {
        var db = b.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
        try {
          return Native.memcmp(da.Scan0, db.Scan0, (UIntPtr)(ulong)((long)Math.Abs(da.Stride) * a.Height)) == 0;
        } finally {
          b.UnlockBits(db);
        }
      } finally {
        a.UnlockBits(da);
      }
    }
  }

  public static class CastHost {
    const long JPEG_SMALL_CHANGE_INTERVAL_MS = 200;
    const double JPEG_BIG_CHANGE_DIFF = 4.5;
    const int RATIO_SCALE = 65535;
    static volatile bool running = true;
    public static bool Running { get { return running; } }
    static volatile bool jpegEnabled = true;
    static volatile bool refreshRequested = false;
    static bool rawEnabled = false;
    static volatile int currentMonitor = -1;
    static Rectangle currentBounds;
    public static Rectangle CurrentBounds { get { return currentBounds; } }
    static int currentImageWidth = 0;
    static int currentImageHeight = 0;
    static volatile int targetMaxFps = 15;
    static volatile int targetMaxWidth = 1366;
    static volatile int targetQuality = 65;

    public static void Run(string argsJson) {
      Native.SetProcessDPIAware();
      Native.timeBeginPeriod(1);
      var a = Out.Parse(argsJson);
      currentMonitor = a.ContainsKey("monitor") ? Convert.ToInt32(a["monitor"]) : -1;
      targetMaxFps = a.ContainsKey("max_fps") ? Convert.ToInt32(a["max_fps"]) : 15;
      if (targetMaxFps < 1) targetMaxFps = 1;
      if (targetMaxFps > 30) targetMaxFps = 30;
      targetMaxWidth = a.ContainsKey("max_width") ? Convert.ToInt32(a["max_width"]) : 1366;
      targetQuality = a.ContainsKey("quality") ? Convert.ToInt32(a["quality"]) : 65;
      string pipeName = a.ContainsKey("pipe") ? Convert.ToString(a["pipe"]) : "";
      if (!string.IsNullOrEmpty(pipeName)) { rawEnabled = true; RawPipe.Start(pipeName); }

      currentBounds = CastScreen.GetBounds(currentMonitor);

      // Luồng đọc lệnh điều khiển từ xa từ stdin
      var inputThread = new Thread(ReadInputLoop);
      inputThread.IsBackground = true;
      inputThread.Start();

      var readyMsg = Out.Msg("ready");
      readyMsg["monitor"] = currentMonitor;
      readyMsg["screens"] = CastScreen.GetScreens();
      readyMsg["bounds"] = new Dictionary<string, object> {
        { "x", currentBounds.X }, { "y", currentBounds.Y },
        { "width", currentBounds.Width }, { "height", currentBounds.Height }
      };
      Out.Send(readyMsg);

      var clock = System.Diagnostics.Stopwatch.StartNew();
      var source = new FrameSource();
      var hostStats = new HostStats();
      CursorTracker.Start();
      byte[] lastJpegThumb = null;
      bool changePending = false;
      int lastCursorSeq = -1;
      long lastSendMs = 0;

      while (running) {
        long frameStartMs = clock.ElapsedMilliseconds;
        long targetFrameInterval = 1000 / Math.Max(1, targetMaxFps);
        try {
          currentBounds = CastScreen.GetBounds(currentMonitor);
          if (source.Capture(currentBounds, (int)targetFrameInterval, frameStartMs)) {
            changePending = true;
            hostStats.OnChange(source.Frame, clock.ElapsedMilliseconds);
          }
          bool cursorInFrame = CursorTracker.DrawInFrame;
          int cursorSeq = CursorTracker.Seq;
          if (cursorInFrame && cursorSeq != lastCursorSeq) changePending = true;
          long nowMs = clock.ElapsedMilliseconds;
          bool forceKeepAlive = (nowMs - lastSendMs) >= 1000;
          bool refresh = refreshRequested;
          if (refresh) refreshRequested = false;

          bool jpegMode = jpegEnabled || !rawEnabled;
          bool sendChange = changePending;
          if (sendChange && jpegMode && lastJpegThumb != null && (nowMs - lastSendMs) < JPEG_SMALL_CHANGE_INTERVAL_MS) {
            sendChange = CastScreen.Diff(CastScreen.Thumb(source.Frame), lastJpegThumb) > JPEG_BIG_CHANGE_DIFF;
          }

          if (sendChange || forceKeepAlive || refresh) {
            changePending = false;
            lastSendMs = nowMs;
            lastCursorSeq = cursorSeq;
            if (jpegMode) lastJpegThumb = CastScreen.Thumb(source.Frame);
            long sendStartMs = clock.ElapsedMilliseconds;
            SendFrame(source.Frame, cursorInFrame, jpegMode, nowMs, hostStats);
            hostStats.AddLoad(clock.ElapsedMilliseconds - sendStartMs);
          }
        } catch (Exception ex) {
          var warnMsg = Out.Msg("warn");
          warnMsg["error"] = ex.Message;
          Out.Send(warnMsg);
        }

        long sleepMs = targetFrameInterval - (clock.ElapsedMilliseconds - frameStartMs);
        if (sleepMs > 0) Thread.Sleep((int)sleepMs);
        else if (!source.UsingDxgi) Thread.Sleep(1);
      }
      source.Dispose();

      var stoppedMsg = Out.Msg("stopped");
      Out.Send(stoppedMsg);
    }

    static void SendFrame(Bitmap frame, bool cursorInFrame, bool jpegMode, long nowMs, HostStats hostStats) {
      Bitmap withCursor = null;
      Bitmap scaled = null;
      try {
        Bitmap encodeBmp = frame;
        if (cursorInFrame) {
          withCursor = CastScreen.WithCursor(frame, currentBounds);
          encodeBmp = withCursor;
        }
        if (encodeBmp.Width > targetMaxWidth) {
          scaled = CastScreen.Scale(encodeBmp, targetMaxWidth);
          encodeBmp = scaled;
        }
        currentImageWidth = encodeBmp.Width;
        currentImageHeight = encodeBmp.Height;
        if (rawEnabled && RawPipe.Connected) {
          int rw, rh;
          byte[] i420 = CastScreen.ToI420(encodeBmp, out rw, out rh);
          RawPipe.Write(rw, rh, i420);
        }
        var frameMsg = Out.Msg(jpegMode ? "frame" : "meta");
        if (jpegMode) frameMsg["image"] = Convert.ToBase64String(CastScreen.Jpeg(encodeBmp, targetQuality));
        frameMsg["width"] = currentImageWidth;
        frameMsg["height"] = currentImageHeight;
        frameMsg["screenWidth"] = currentBounds.Width;
        frameMsg["screenHeight"] = currentBounds.Height;
        frameMsg["screenX"] = currentBounds.X;
        frameMsg["screenY"] = currentBounds.Y;
        frameMsg["monitor"] = currentMonitor;
        frameMsg["screens"] = CastScreen.GetScreens();
        frameMsg["ts"] = nowMs;
        frameMsg["stats"] = hostStats.Snapshot(nowMs);
        Out.Send(frameMsg);
      } finally {
        if (scaled != null) scaled.Dispose();
        if (withCursor != null) withCursor.Dispose();
      }
    }

    static void ReadInputLoop() {
      try {
        string line;
        while (running && (line = Console.In.ReadLine()) != null) {
          line = line.Trim();
          if (string.IsNullOrEmpty(line)) continue;
          if (line == "stop") {
            running = false;
            break;
          }
          var cmd = Out.Parse(line);
          string op = cmd.ContainsKey("op") ? Convert.ToString(cmd["op"]) : "";
          if (op == "stop") {
            running = false;
            break;
          } else if (op == "input") {
            HandleInput(cmd);
          } else if (op == "config") {
            HandleConfig(cmd);
          } else if (op == "refresh") {
            refreshRequested = true;
          }
        }
      } catch {
        running = false;
      }
    }

    static void HandleConfig(Dictionary<string, object> cmd) {
      try {
        if (cmd.ContainsKey("max_fps")) {
          int fps = Convert.ToInt32(cmd["max_fps"]);
          if (fps >= 1 && fps <= 30) targetMaxFps = fps;
        }
        if (cmd.ContainsKey("quality")) {
          int q = Convert.ToInt32(cmd["quality"]);
          if (q >= 10 && q <= 95) targetQuality = q;
        }
        if (cmd.ContainsKey("max_width")) {
          int w = Convert.ToInt32(cmd["max_width"]);
          if (w >= 640 && w <= 2560) {
            // Đổi độ rộng lúc màn hình đứng yên: phải có khung mới ngay, không chờ nhịp giữ.
            if (w != targetMaxWidth) refreshRequested = true;
            targetMaxWidth = w;
          }
        }
        if (cmd.ContainsKey("jpeg") && cmd["jpeg"] is bool) {
          jpegEnabled = (bool)cmd["jpeg"];
          refreshRequested = true;
        }
        if (cmd.ContainsKey("cursor") && cmd["cursor"] is bool) {
          CursorTracker.SetDrawInFrame((bool)cmd["cursor"]);
          refreshRequested = true;
        }
        if (cmd.ContainsKey("monitor")) {
          int m = Convert.ToInt32(cmd["monitor"]);
          if (m >= -1 && m < Screen.AllScreens.Length) {
            currentMonitor = m;
          }
        }
        var ack = Out.Msg("config_ack");
        ack["max_fps"] = targetMaxFps;
        ack["quality"] = targetQuality;
        ack["max_width"] = targetMaxWidth;
        ack["monitor"] = currentMonitor;
        Out.Send(ack);
      } catch {
      }
    }

    static byte KeyNameToVk(string name) {
      if (string.IsNullOrEmpty(name)) return 0;
      switch (name.ToLower().Trim()) {
        case "win": case "windows": case "lwin": case "meta": case "cmd": return 0x5B;
        case "rwin": return 0x5C;
        case "ctrl": case "control": case "lctrl": return 0x11;
        case "rctrl": return 0xA3;
        case "alt": case "menu": case "lalt": return 0x12;
        case "ralt": return 0xA5;
        case "shift": case "lshift": return 0x10;
        case "rshift": return 0xA1;
        case "tab": return 0x09;
        case "escape": case "esc": return 0x1B;
        case "enter": case "return": return 0x0D;
        case "backspace": return 0x08;
        case "space": return 0x20;
        case "delete": case "del": return 0x2E;
        case "insert": case "ins": return 0x2D;
        case "home": return 0x24;
        case "end": return 0x23;
        case "pageup": return 0x21;
        case "pagedown": return 0x22;
        case "up": case "arrowup": return 0x26;
        case "down": case "arrowdown": return 0x28;
        case "left": case "arrowleft": return 0x25;
        case "right": case "arrowright": return 0x27;
        case "f1": return 0x70;
        case "f2": return 0x71;
        case "f3": return 0x72;
        case "f4": return 0x73;
        case "f5": return 0x74;
        case "f6": return 0x75;
        case "f7": return 0x76;
        case "f8": return 0x77;
        case "f9": return 0x78;
        case "f10": return 0x79;
        case "f11": return 0x7A;
        case "f12": return 0x7B;
        case "printscreen": case "prtsc": return 0x2C;
        case "capslock": return 0x14;
        case "numlock": return 0x90;
        case "scrolllock": return 0x91;
        case "contextmenu": case "apps": return 0x5D;
        default:
          if (name.Length == 1) {
            char ch = char.ToUpperInvariant(name[0]);
            if (ch >= 'A' && ch <= 'Z') return (byte)ch;
            if (ch >= '0' && ch <= '9') return (byte)ch;
            short vks = Native.VkKeyScan(name[0]);
            if (vks != -1) return (byte)(vks & 0xFF);
          }
          return 0;
      }
    }

    static List<byte> ExtractModifiers(Dictionary<string, object> cmd) {
      var list = new List<byte>();
      if (!cmd.ContainsKey("modifiers") || cmd["modifiers"] == null) return list;
      System.Collections.ArrayList raw = cmd["modifiers"] as System.Collections.ArrayList;
      if (raw != null) {
        for (int i = 0; i < raw.Count; i++) {
          byte vk = KeyNameToVk(Convert.ToString(raw[i]));
          if (vk != 0 && !list.Contains(vk)) list.Add(vk);
        }
      }
      return list;
    }

    static void PressModifiers(List<byte> mods) {
      for (int i = 0; i < mods.Count; i++) {
        Native.keybd_event(mods[i], 0, 0, UIntPtr.Zero);
      }
      if (mods.Count > 0) Thread.Sleep(8);
    }

    static void ReleaseModifiers(List<byte> mods) {
      for (int i = mods.Count - 1; i >= 0; i--) {
        Native.keybd_event(mods[i], 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
      }
    }

    static void HandleInput(Dictionary<string, object> cmd) {
      try {
        string action = cmd.ContainsKey("action") ? Convert.ToString(cmd["action"]) : "";
        double rx = cmd.ContainsKey("x") ? Convert.ToDouble(cmd["x"]) : 0;
        double ry = cmd.ContainsKey("y") ? Convert.ToDouble(cmd["y"]) : 0;
        var mods = ExtractModifiers(cmd);

        int targetX = currentBounds.X;
        int targetY = currentBounds.Y;
        if (cmd.ContainsKey("rx") && cmd.ContainsKey("ry")) {
          // Toạ độ theo tỷ lệ: đúng cả khi độ rộng khung vừa đổi (chế độ Tự động) hoặc video bị hạ độ phân giải.
          targetX += (int)Math.Round(Convert.ToDouble(cmd["rx"]) / RATIO_SCALE * (currentBounds.Width - 1));
          targetY += (int)Math.Round(Convert.ToDouble(cmd["ry"]) / RATIO_SCALE * (currentBounds.Height - 1));
        } else if (currentImageWidth > 0 && currentImageHeight > 0) {
          targetX += (int)Math.Round((rx / currentImageWidth) * currentBounds.Width);
          targetY += (int)Math.Round((ry / currentImageHeight) * currentBounds.Height);
        }

        if (action == "move") {
          Native.SetCursorPos(targetX, targetY);
        } else if (action == "click") {
          int button = cmd.ContainsKey("button") ? Convert.ToInt32(cmd["button"]) : 0;
          Native.SetCursorPos(targetX, targetY);
          Thread.Sleep(10);
          PressModifiers(mods);
          try {
            if (button == 2) {
              Native.mouse_event(Native.MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0);
              Thread.Sleep(15);
              Native.mouse_event(Native.MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
            } else if (button == 1) {
              Native.mouse_event(Native.MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, 0);
              Thread.Sleep(15);
              Native.mouse_event(Native.MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0);
            } else {
              Native.mouse_event(Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
              Thread.Sleep(15);
              Native.mouse_event(Native.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
            }
          } finally {
            ReleaseModifiers(mods);
          }
          if (button == 0) ProbeInputFocus();
        } else if (action == "dblclick") {
          Native.SetCursorPos(targetX, targetY);
          Thread.Sleep(10);
          PressModifiers(mods);
          try {
            Native.mouse_event(Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
            Native.mouse_event(Native.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
            Thread.Sleep(40);
            Native.mouse_event(Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
            Native.mouse_event(Native.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
          } finally {
            ReleaseModifiers(mods);
          }
        } else if (action == "rightclick") {
          Native.SetCursorPos(targetX, targetY);
          Thread.Sleep(10);
          PressModifiers(mods);
          try {
            Native.mouse_event(Native.MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0);
            Thread.Sleep(15);
            Native.mouse_event(Native.MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
          } finally {
            ReleaseModifiers(mods);
          }
        } else if (action == "mousedown") {
          int button = cmd.ContainsKey("button") ? Convert.ToInt32(cmd["button"]) : 0;
          Native.SetCursorPos(targetX, targetY);
          PressModifiers(mods);
          if (button == 2) Native.mouse_event(Native.MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0);
          else if (button == 1) Native.mouse_event(Native.MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, 0);
          else Native.mouse_event(Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        } else if (action == "mouseup") {
          int button = cmd.ContainsKey("button") ? Convert.ToInt32(cmd["button"]) : 0;
          Native.SetCursorPos(targetX, targetY);
          try {
            if (button == 2) Native.mouse_event(Native.MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
            else if (button == 1) Native.mouse_event(Native.MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0);
            else Native.mouse_event(Native.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
          } finally {
            ReleaseModifiers(mods);
          }
          if (button == 0) ProbeInputFocus();
        } else if (action == "scroll") {
          int deltaY = cmd.ContainsKey("deltaY") ? Convert.ToInt32(cmd["deltaY"]) : 0;
          int deltaX = cmd.ContainsKey("deltaX") ? Convert.ToInt32(cmd["deltaX"]) : 0;
          Native.SetCursorPos(targetX, targetY);
          PressModifiers(mods);
          try {
            if (deltaY != 0) Native.mouse_event(Native.MOUSEEVENTF_WHEEL, 0, 0, -deltaY, 0);
            if (deltaX != 0) Native.mouse_event(Native.MOUSEEVENTF_HWHEEL, 0, 0, deltaX, 0);
          } finally {
            ReleaseModifiers(mods);
          }
        } else if (action == "type") {
          string text = cmd.ContainsKey("text") ? Convert.ToString(cmd["text"]) : "";
          if (!string.IsNullOrEmpty(text)) TypeUnicode(text);
        } else if (action == "key") {
          string key = cmd.ContainsKey("key") ? Convert.ToString(cmd["key"]) : "";
          HandleSpecialKey(key);
        } else if (action == "hotkey") {
          System.Collections.ArrayList keys = cmd.ContainsKey("keys") ? cmd["keys"] as System.Collections.ArrayList : null;
          if (keys != null && keys.Count > 0) {
            var vks = new List<byte>();
            for (int i = 0; i < keys.Count; i++) {
              byte vk = KeyNameToVk(Convert.ToString(keys[i]));
              if (vk != 0) vks.Add(vk);
            }
            for (int i = 0; i < vks.Count; i++) {
              Native.keybd_event(vks[i], 0, 0, UIntPtr.Zero);
              Thread.Sleep(10);
            }
            Thread.Sleep(40);
            for (int i = vks.Count - 1; i >= 0; i--) {
              Native.keybd_event(vks[i], 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
              Thread.Sleep(10);
            }
          }
        }
      } catch {
      }
    }

    /** Gõ nguyên văn: mỗi đơn vị UTF-16 một cặp nhấn / nhả KEYEVENTF_UNICODE (cặp đại diện của emoji đi liền nhau), gửi theo lô. */
    static void TypeUnicode(string text) {
      const int chunk = 64;
      int size = Marshal.SizeOf(typeof(Native.INPUT));
      int start = 0;
      while (start < text.Length) {
        int end = Math.Min(text.Length, start + chunk);
        // Không cắt đôi một cặp đại diện giữa hai lô.
        if (end < text.Length && char.IsHighSurrogate(text[end - 1])) end--;
        var inputs = new Native.INPUT[(end - start) * 2];
        for (int i = start; i < end; i++) {
          int k = (i - start) * 2;
          inputs[k].type = Native.INPUT_KEYBOARD;
          inputs[k].u.ki = new Native.KEYBDINPUT { wVk = 0, wScan = text[i], dwFlags = Native.KEYEVENTF_UNICODE };
          inputs[k + 1].type = Native.INPUT_KEYBOARD;
          inputs[k + 1].u.ki = new Native.KEYBDINPUT { wVk = 0, wScan = text[i], dwFlags = Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP };
        }
        Native.SendInput((uint)inputs.Length, inputs, size);
        start = end;
      }
    }

    static int focusProbeSeq = 0;

    /**
     * Sau cú nhấp trái của người xem: chờ ứng dụng nhận tiêu điểm rồi báo ô đang chọn có phải ô nhập chữ (có caret) không —
     * trình duyệt trên điện thoại dựa vào đó tự mở bàn phím ảo. Chạy luồng riêng, không giữ hàng thao tác.
     */
    static void ProbeInputFocus() {
      int seq = Interlocked.Increment(ref focusProbeSeq);
      ThreadPool.QueueUserWorkItem(_ => {
        try {
          Thread.Sleep(150);
          if (seq != focusProbeSeq) return;
          var info = new Native.GUITHREADINFO();
          info.cbSize = Marshal.SizeOf(typeof(Native.GUITHREADINFO));
          IntPtr fg = Native.GetForegroundWindow();
          uint tid = fg == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(fg, IntPtr.Zero);
          bool editable = (tid != 0 && Native.GetGUIThreadInfo(tid, ref info) && info.hwndCaret != IntPtr.Zero) || FocusedIsTextInput();
          var msg = new Dictionary<string, object>();
          msg["t"] = "input_focus";
          msg["editable"] = editable;
          Out.Send(msg);
        } catch {
        }
      });
    }

    /** Chromium / Edge / Electron chỉ tạo caret hệ thống khi bật trợ năng → hỏi UI Automation: ô Edit, hoặc ô có giá trị sửa được. */
    static bool FocusedIsTextInput() {
      try {
        var fe = AutomationElement.FocusedElement;
        if (fe == null) return false;
        var ct = fe.Current.ControlType;
        if (ct == ControlType.Edit) return true;
        if (ct == ControlType.ComboBox || ct == ControlType.Document) {
          object vp;
          if (fe.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) return !((ValuePattern)vp).Current.IsReadOnly;
        }
      } catch {
      }
      return false;
    }

    static void HandleSpecialKey(string key) {
      byte vk = KeyNameToVk(key);
      if (vk != 0) {
        Native.keybd_event(vk, 0, 0, UIntPtr.Zero);
        Thread.Sleep(15);
        Native.keybd_event(vk, 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
      }
    }
  }
}
` + DESKTOP_CAST_CAPTURE_CSHARP;

export const DESKTOP_CAST_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
$dll = $env:AIVIN_CAST_DLL
$src = $env:AIVIN_CAST_SRC
$refs = @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Drawing', 'System.Windows.Forms', 'System.Web.Extensions', 'System.Core')
foreach ($r in $refs) { Add-Type -AssemblyName $r }
if ($dll -and (Test-Path -LiteralPath $dll)) {
  Add-Type -Path $dll
} else {
  Add-Type -TypeDefinition ([IO.File]::ReadAllText($src)) -ReferencedAssemblies $refs -OutputAssembly $dll -OutputType Library
  Add-Type -Path $dll
}
try {
  [AivinDesktopCast.CastHost]::Run($env:AIVIN_CAST_ARGS)
} catch {
  $m = @{ t = 'error'; error = $_.Exception.Message } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($m)
  exit 1
}
`;
