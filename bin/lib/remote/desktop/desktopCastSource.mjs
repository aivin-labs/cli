/**
 * Tiến trình phát hình ảnh màn hình trực tiếp và điều khiển từ xa trên Windows (Desktop Scenecast).
 * Tương thích C# 5 / .NET Framework 4.5+ / PowerShell 5.1:
 * - Chụp màn hình bằng Desktop Duplication, lùi Graphics.CopyFromScreen khi không dùng được (desktopCastCaptureSource.mjs).
 * - Con trỏ: gửi vị trí + hình riêng để FE vẽ tức thì; người xem chưa hỗ trợ / đường JPEG thì lồng vào khung hình (GetCursorInfo + DrawIcon).
 * - Hỗ trợ đa màn hình: lấy danh sách màn hình và chuyển đổi màn hình cần chụp theo thời gian thực.
 * - Co ảnh về chiều rộng tối đa (giữ tỉ lệ), nén ảnh sang định dạng JPEG nhẹ, tái sử dụng vùng đệm Bitmap/I420 để tránh GC pause.
 * - So sánh nguyên khung (memcmp) để chỉ gửi khi hình đổi hoặc giữ nhịp định kỳ (1 FPS): thay đổi nhỏ như con trỏ, gõ chữ cũng phải đi ngay
 *   (đo 03/11/2026: ảnh thu nhỏ 64x36 + ngưỡng làm chúng chờ tới nhịp 1 s). Đường JPEG thì đổi nhỏ giới hạn 5 khung/giây, đỡ tải máy chủ.
 * - Nhận lệnh chuột, bàn phím, phím tắt hệ thống (hotkeys) và đồng bộ Clipboard hai chiều qua stdin / stdout.
 * - Phát hiện vùng màn hình bảo mật Windows (hộp thoại UAC / màn hình khóa) và báo trạng thái về giao diện.
 * - Hỗ trợ thay đổi độ phân giải, chất lượng nén JPEG, giới hạn FPS (tới 60 FPS) và chọn màn hình theo thời gian thực.
 * - Luồng video + âm thanh: có `pipe` → mở named pipe gửi khung thô I420 + âm thanh PCM 16-bit 48 kHz cho tiến trình WebRTC.
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
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
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
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);

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

    // Phát hiện vùng màn hình bảo mật (UAC / Lock Screen)
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hDesktop);

    // Đồng bộ Clipboard
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll")] public static extern bool CloseClipboard();
    [DllImport("user32.dll")] public static extern bool EmptyClipboard();
    [DllImport("user32.dll")] public static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll")] public static extern IntPtr GetClipboardData(uint uFormat);
    [DllImport("user32.dll")] public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
    [DllImport("kernel32.dll")] public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr hMem);
    [DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr hMem);

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
    [DllImport("ole32.dll")] public static extern void CoTaskMemFree(IntPtr p);

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

    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
  }

  static class Out {
    static readonly object gate = new object();
    static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    // stdin/stdout là ống (không console): Console.In/Out mặc định theo bảng mã OEM (437…) còn Node đọc/ghi UTF-8 — 06/11/2026 gõ
    // "tôi đang gõ tiếng Việt" từ xa ra "t├┤i ─æang g├╡ ti├ß║┐ng". Mở luồng chuẩn với UTF-8 (không BOM) khai rõ ràng.
    static readonly UTF8Encoding utf8 = new UTF8Encoding(false);
    static readonly StreamWriter stdout = new StreamWriter(Console.OpenStandardOutput(), utf8);
    public static readonly StreamReader Stdin = new StreamReader(Console.OpenStandardInput(), utf8);

    public static void Send(Dictionary<string, object> msg) {
      string line = json.Serialize(msg);
      lock (gate) { stdout.WriteLine(line); stdout.Flush(); }
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

  /** Named pipe một chiều gửi khung thô I420 + âm thanh PCM cho tiến trình Node (một khách). Khách rớt → chờ khách mới. */
  static class RawPipe {
    static readonly object gate = new object();
    static NamedPipeServerStream pipe;
    public static volatile bool Connected;
    static int videoBusy = 0;
    static readonly byte[] videoHeader = new byte[12];
    static byte[] audioPacket = new byte[12 + 1920];

    /** Khung thô là toàn bộ màn hình: chỉ đúng tài khoản đang chạy mới mở được, không nhận kết nối qua mạng. */
    static PipeSecurity OwnerOnly() {
      var security = new PipeSecurity();
      security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
      security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
      return security;
    }

    public static void Start(string name) {
      var t = new Thread(() => {
        while (CastHost.Running) {
          try {
            var p = new NamedPipeServerStream(name, PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.None, 0, 8 * 1024 * 1024, OwnerOnly());
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

    /** Ghi khung hình video I420: nếu đường ống đang bận ghi khung trước thì bỏ qua khung mới để không chặn âm thanh. */
    public static void Write(int width, int height, byte[] data) {
      if (data == null || !Connected) return;
      if (Interlocked.CompareExchange(ref videoBusy, 1, 0) != 0) return;
      try {
        bool locked = false;
        try {
          Monitor.TryEnter(gate, 5, ref locked);
          if (!locked || pipe == null || !Connected) return;
          BitConverter.GetBytes(width).CopyTo(videoHeader, 0);
          BitConverter.GetBytes(height).CopyTo(videoHeader, 4);
          BitConverter.GetBytes(data.Length).CopyTo(videoHeader, 8);
          pipe.Write(videoHeader, 0, 12);
          pipe.Write(data, 0, data.Length);
        } catch {
          Connected = false;
          try { if (pipe != null) pipe.Dispose(); } catch { }
          pipe = null;
        } finally {
          if (locked) Monitor.Exit(gate);
        }
      } finally {
        Interlocked.Exchange(ref videoBusy, 0);
      }
    }

    /** Ghi khúc âm thanh 10 ms: gộp header + mẫu vào 1 lần Write nguyên tử để giảm độ trễ và tránh tách gói. */
    public static void WriteAudio(int sampleRate, int channels, byte[] pcm) {
      if (pcm == null || pcm.Length == 0 || channels <= 0 || sampleRate <= 0 || !Connected) return;
      lock (gate) {
        if (pipe == null || !Connected) return;
        try {
          int total = 12 + pcm.Length;
          if (audioPacket.Length < total) audioPacket = new byte[total];
          BitConverter.GetBytes(-channels).CopyTo(audioPacket, 0);
          BitConverter.GetBytes(sampleRate).CopyTo(audioPacket, 4);
          BitConverter.GetBytes(pcm.Length).CopyTo(audioPacket, 8);
          Buffer.BlockCopy(pcm, 0, audioPacket, 12, pcm.Length);
          pipe.Write(audioPacket, 0, total);
        } catch {
          Connected = false;
          try { if (pipe != null) pipe.Dispose(); } catch { }
          pipe = null;
        }
      }
    }
  }

  public static class CastScreen {
    static byte[] i420Raw;
    static byte[] scaleRaw;
    static byte[] scaleOut;
    static byte[] i420Out;
    static Bitmap cursorBuffer;
    static Bitmap scaleBuffer;
    static Bitmap thumbBmp;
    static byte[] thumbRaw;

    /** Kiểm tra tiến trình có truy cập được vùng màn hình nhận thao tác không (false = đang ở hộp thoại UAC hoặc màn hình khóa). */
    public static bool IsSecureDesktop() {
      IntPtr hDesk = IntPtr.Zero;
      try {
        hDesk = Native.OpenInputDesktop(0, false, 0x0100u);
        return hDesk == IntPtr.Zero;
      } catch {
        return false;
      } finally {
        if (hDesk != IntPtr.Zero) Native.CloseDesktop(hDesk);
      }
    }

    /** BGRX 32 bit → I420: tái sử dụng mảng đệm tĩnh (tránh GC LOH) và chia luồng song song theo cặp hàng chẵn/lẻ. */
    public static byte[] ToI420(Bitmap bmp, out int w, out int h) {
      w = bmp.Width & ~1;
      h = bmp.Height & ~1;
      int width = w;
      int height = h;
      var data = bmp.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
      try {
        int stride = Math.Abs(data.Stride);
        int rawLen = stride * height;
        if (i420Raw == null || i420Raw.Length < rawLen) i420Raw = new byte[rawLen];
        byte[] raw = i420Raw;
        Marshal.Copy(data.Scan0, raw, 0, rawLen);
        int ySize = width * height;
        int totalLen = ySize + ySize / 2;
        if (i420Out == null || i420Out.Length != totalLen) i420Out = new byte[totalLen];
        byte[] outBuf = i420Out;
        int cw = width / 2;
        int uBase = ySize;
        int vBase = ySize + ySize / 4;
        int pairs = height / 2;

        Parallel.For(0, pairs, pair => {
          int y0 = pair * 2;
          int y1 = y0 + 1;
          int row0 = y0 * stride;
          int row1 = row0 + stride;
          int yRow0 = y0 * width;
          int yRow1 = y1 * width;
          int cRow = pair * cw;
          for (int x = 0; x < width; x += 2) {
            int i0 = row0 + x * 4;
            int i1 = i0 + 4;
            int i2 = row1 + x * 4;
            int i3 = i2 + 4;

            int b0 = raw[i0], g0 = raw[i0 + 1], r0 = raw[i0 + 2];
            int b1 = raw[i1], g1 = raw[i1 + 1], r1 = raw[i1 + 2];
            int b2 = raw[i2], g2 = raw[i2 + 1], r2 = raw[i2 + 2];
            int b3 = raw[i3], g3 = raw[i3 + 1], r3 = raw[i3 + 2];

            outBuf[yRow0 + x] = (byte)(((66 * r0 + 129 * g0 + 25 * b0 + 128) >> 8) + 16);
            outBuf[yRow0 + x + 1] = (byte)(((66 * r1 + 129 * g1 + 25 * b1 + 128) >> 8) + 16);
            outBuf[yRow1 + x] = (byte)(((66 * r2 + 129 * g2 + 25 * b2 + 128) >> 8) + 16);
            outBuf[yRow1 + x + 1] = (byte)(((66 * r3 + 129 * g3 + 25 * b3 + 128) >> 8) + 16);

            int bAvg = (b0 + b1 + b2 + b3) >> 2;
            int gAvg = (g0 + g1 + g2 + g3) >> 2;
            int rAvg = (r0 + r1 + r2 + r3) >> 2;
            int ci = cRow + (x >> 1);
            outBuf[uBase + ci] = (byte)(((-38 * rAvg - 74 * gAvg + 112 * bAvg + 128) >> 8) + 128);
            outBuf[vBase + ci] = (byte)(((112 * rAvg - 94 * gAvg - 18 * bAvg + 128) >> 8) + 128);
          }
        });
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
      try {
        using (var g = Graphics.FromImage(dst)) {
          g.CopyFromScreen(r.Left, r.Top, 0, 0, r.Size);
        }
      } catch {
      }
    }

    /** Bản sao của khung có lồng con trỏ thật của Windows (tái sử dụng cursorBuffer để tránh cấp phát mới mỗi khung). */
    public static Bitmap WithCursor(Bitmap src, Rectangle r) {
      if (cursorBuffer == null || cursorBuffer.Width != src.Width || cursorBuffer.Height != src.Height) {
        if (cursorBuffer != null) cursorBuffer.Dispose();
        cursorBuffer = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppRgb);
      }
      using (var g = Graphics.FromImage(cursorBuffer)) {
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
      return cursorBuffer;
    }

    /** Song tuyến tính chia theo hàng trên nhiều nhân: GDI+ DrawImage chỉ chạy một nhân, đo 14 ms mỗi khung từ 1080p xuống 1280, là khâu đắt nhất của bộ quay. */
    static void ScaleBilinear(Bitmap src, Bitmap dst) {
      int sw = src.Width, sh = src.Height, dw = dst.Width, dh = dst.Height;
      var sd = src.LockBits(new Rectangle(0, 0, sw, sh), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
      try {
        var dd = dst.LockBits(new Rectangle(0, 0, dw, dh), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
        try {
          int sStride = Math.Abs(sd.Stride), dStride = Math.Abs(dd.Stride);
          int sLen = sStride * sh, dLen = dStride * dh;
          if (scaleRaw == null || scaleRaw.Length < sLen) scaleRaw = new byte[sLen];
          if (scaleOut == null || scaleOut.Length < dLen) scaleOut = new byte[dLen];
          byte[] raw = scaleRaw, output = scaleOut;
          Marshal.Copy(sd.Scan0, raw, 0, sLen);
          long xStep = ((long)(sw - 1) << 16) / Math.Max(1, dw - 1);
          long yStep = ((long)(sh - 1) << 16) / Math.Max(1, dh - 1);
          Parallel.For(0, dh, y => {
            long fy = y * yStep;
            int sy = (int)(fy >> 16);
            int wy = (int)((fy >> 8) & 0xFF);
            int row0 = sy * sStride;
            int row1 = (sy + 1 < sh ? sy + 1 : sy) * sStride;
            int o = y * dStride;
            for (int x = 0; x < dw; x++, o += 4) {
              long fx = x * xStep;
              int sx = (int)(fx >> 16);
              int wx = (int)((fx >> 8) & 0xFF);
              int a = sx * 4;
              int b = (sx + 1 < sw ? sx + 1 : sx) * 4;
              for (int c = 0; c < 3; c++) {
                int top = raw[row0 + a + c] * (256 - wx) + raw[row0 + b + c] * wx;
                int bottom = raw[row1 + a + c] * (256 - wx) + raw[row1 + b + c] * wx;
                output[o + c] = (byte)((top * (256 - wy) + bottom * wy) >> 16);
              }
              output[o + 3] = 255;
            }
          });
          Marshal.Copy(output, 0, dd.Scan0, dLen);
        } finally {
          dst.UnlockBits(dd);
        }
      } finally {
        src.UnlockBits(sd);
      }
    }

    public static Bitmap Scale(Bitmap src, int maxWidth) {
      if (src.Width <= maxWidth) return src;
      int h = (int)Math.Round(src.Height * (double)maxWidth / src.Width);
      if (scaleBuffer == null || scaleBuffer.Width != maxWidth || scaleBuffer.Height != h) {
        if (scaleBuffer != null) scaleBuffer.Dispose();
        scaleBuffer = new Bitmap(maxWidth, h, PixelFormat.Format32bppRgb);
      }
      ScaleBilinear(src, scaleBuffer);
      return scaleBuffer;
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
      if (thumbBmp == null) thumbBmp = new Bitmap(64, 36, PixelFormat.Format24bppRgb);
      using (var g = Graphics.FromImage(thumbBmp)) {
        g.DrawImage(src, 0, 0, 64, 36);
      }
      var data = thumbBmp.LockBits(new Rectangle(0, 0, 64, 36), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
      try {
        int stride = Math.Abs(data.Stride);
        int len = stride * 36;
        if (thumbRaw == null || thumbRaw.Length < len) thumbRaw = new byte[len];
        Marshal.Copy(data.Scan0, thumbRaw, 0, len);
        for (int y = 0; y < 36; y++) {
          int rowOffset = y * stride;
          int outOffset = y * 64;
          for (int x = 0; x < 64; x++) {
            int idx = rowOffset + x * 3;
            int b = thumbRaw[idx];
            int gVal = thumbRaw[idx + 1];
            int r = thumbRaw[idx + 2];
            t[outOffset + x] = (byte)((r * 3 + gVal * 6 + b) / 10);
          }
        }
      } finally {
        thumbBmp.UnlockBits(data);
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
    const long JPEG_IDLE_REFRESH_MS = 8000;
    const long SCREENS_REFRESH_MS = 2000;
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
    static bool lastSecureDesktop = false;
    static long lastScreensMs = -SCREENS_REFRESH_MS;

    public static void Run(string argsJson) {
      Native.SetProcessDPIAware();
      Native.timeBeginPeriod(1);
      var a = Out.Parse(argsJson);
      currentMonitor = a.ContainsKey("monitor") ? Convert.ToInt32(a["monitor"]) : -1;
      targetMaxFps = a.ContainsKey("max_fps") ? Convert.ToInt32(a["max_fps"]) : 15;
      if (targetMaxFps < 1) targetMaxFps = 1;
      if (targetMaxFps > 60) targetMaxFps = 60;
      targetMaxWidth = a.ContainsKey("max_width") ? Convert.ToInt32(a["max_width"]) : 1366;
      targetQuality = a.ContainsKey("quality") ? Convert.ToInt32(a["quality"]) : 65;
      string pipeName = a.ContainsKey("pipe") ? Convert.ToString(a["pipe"]) : "";
      if (!string.IsNullOrEmpty(pipeName)) { rawEnabled = true; RawPipe.Start(pipeName); }
      if (a.ContainsKey("audio") && a["audio"] is bool) LoopbackAudio.SetEnabled((bool)a["audio"]);
      if (rawEnabled) LoopbackAudio.Start();
      ClipboardSync.Init();

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
      long lastJpegMs = 0;
      bool jpegSettled = false;
      long lastAuxCheckMs = 0;

      while (running) {
        long frameStartMs = clock.ElapsedMilliseconds;
        long targetFrameInterval = 1000 / Math.Max(1, targetMaxFps);
        try {
          if (frameStartMs - lastAuxCheckMs >= 250) {
            lastAuxCheckMs = frameStartMs;
            ClipboardSync.Poll();
            bool sec = CastScreen.IsSecureDesktop();
            if (sec != lastSecureDesktop) {
              lastSecureDesktop = sec;
              var secMsg = Out.Msg("secure_desktop");
              secMsg["active"] = sec;
              Out.Send(secMsg);
            }
          }
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
          if (refresh) {
            refreshRequested = false;
            lastScreensMs = -SCREENS_REFRESH_MS;
          }

          bool jpegMode = jpegEnabled || !rawEnabled;
          bool sendChange = changePending;
          if (sendChange && jpegMode && lastJpegThumb != null && (nowMs - lastSendMs) < JPEG_SMALL_CHANGE_INTERVAL_MS) {
            sendChange = CastScreen.Diff(CastScreen.Thumb(source.Frame), lastJpegThumb) > JPEG_BIG_CHANGE_DIFF;
          }

          if (sendChange || forceKeepAlive || refresh) {
            changePending = false;
            lastSendMs = nowMs;
            lastCursorSeq = cursorSeq;
            // Mỗi ảnh JPEG là nguyên màn hình đi qua máy chủ. Màn hình đứng yên chỉ gửi gói giữ nhịp không ảnh; sau lần đổi cuối gửi lại một ảnh phòng ảnh trước bị rơi (đường này không gửi lại), rồi thưa hẳn.
            bool changed = sendChange || refresh;
            bool withJpeg = jpegMode && (changed || !jpegSettled || nowMs - lastJpegMs >= JPEG_IDLE_REFRESH_MS);
            jpegSettled = !changed;
            if (withJpeg) {
              lastJpegMs = nowMs;
              lastJpegThumb = CastScreen.Thumb(source.Frame);
            }
            long sendStartMs = clock.ElapsedMilliseconds;
            SendFrame(source.Frame, cursorInFrame, withJpeg, nowMs, hostStats);
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
      Bitmap encodeBmp = frame;
      if (cursorInFrame) {
        encodeBmp = CastScreen.WithCursor(frame, currentBounds);
      }
      if (encodeBmp.Width > targetMaxWidth) {
        encodeBmp = CastScreen.Scale(encodeBmp, targetMaxWidth);
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
      // Danh sách màn hình ít khi đổi: không gửi và không tra lại ở mọi khung.
      if (nowMs - lastScreensMs >= SCREENS_REFRESH_MS) {
        lastScreensMs = nowMs;
        frameMsg["screens"] = CastScreen.GetScreens();
      }
      frameMsg["ts"] = nowMs;
      frameMsg["stats"] = hostStats.Snapshot(nowMs);
      if (lastSecureDesktop) frameMsg["secureDesktop"] = true;
      Out.Send(frameMsg);
    }

    static void ReadInputLoop() {
      try {
        string line;
        while (running && (line = Out.Stdin.ReadLine()) != null) {
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
      } finally {
        // Dừng phiên hoặc daemon chết (stdin đóng) lúc người xem đang kéo: không để nút chuột / phím bổ trợ kẹt xuống trên máy.
        ReleaseHeldInput();
      }
    }

    static void HandleConfig(Dictionary<string, object> cmd) {
      try {
        if (cmd.ContainsKey("max_fps")) {
          int fps = Convert.ToInt32(cmd["max_fps"]);
          if (fps >= 1 && fps <= 60) targetMaxFps = fps;
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
        if (cmd.ContainsKey("audio") && cmd["audio"] is bool) {
          LoopbackAudio.SetEnabled((bool)cmd["audio"]);
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

    /**
     * Phím thuộc cụm mở rộng phải gắn cờ extended. Thiếu cờ, Windows hiểu mũi tên / Home / End... là phím số bên phải:
     * NumLock đang bật thì Shift bị huỷ để phím đó vẫn là di chuyển, nên Shift + mũi tên chỉ di chuyển, không bôi đen.
     */
    static bool IsExtendedKey(byte vk) {
      return (vk >= 0x21 && vk <= 0x28) || vk == 0x2C || vk == 0x2D || vk == 0x2E
        || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x90 || vk == 0xA3 || vk == 0xA5;
    }

    static void SendKey(byte vk, bool up) {
      uint flags = (IsExtendedKey(vk) ? Native.KEYEVENTF_EXTENDEDKEY : 0) | (up ? Native.KEYEVENTF_KEYUP : 0);
      Native.keybd_event(vk, (byte)Native.MapVirtualKey(vk, 0), flags, UIntPtr.Zero);
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
        SendKey(mods[i], false);
      }
      if (mods.Count > 0) Thread.Sleep(8);
    }

    static void ReleaseModifiers(List<byte> mods) {
      for (int i = mods.Count - 1; i >= 0; i--) {
        SendKey(mods[i], true);
      }
    }

    static int wheelAccY = 0;
    static int wheelAccX = 0;

    static void FlushWheelAccumulator() {
      if (Math.Abs(wheelAccY) >= 40) {
        int sign = wheelAccY > 0 ? 1 : -1;
        Native.mouse_event(Native.MOUSEEVENTF_WHEEL, 0, 0, -sign * 120, 0);
      }
      wheelAccY = 0;
      if (Math.Abs(wheelAccX) >= 40) {
        int sign = wheelAccX > 0 ? 1 : -1;
        Native.mouse_event(Native.MOUSEEVENTF_HWHEEL, 0, 0, sign * 120, 0);
      }
      wheelAccX = 0;
    }

    // Nút + phím bổ trợ đang giữ qua mousedown (chỉ luồng đọc lệnh đụng tới). Gói mouseup không đủ để biết cần nhả gì: người xem có thể thả Ctrl trước khi thả chuột.
    static readonly List<int> heldButtons = new List<int>();
    static readonly List<byte> heldModifiers = new List<byte>();

    static void MouseButton(int button, bool down) {
      uint flag = button == 2 ? (down ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_RIGHTUP)
        : button == 1 ? (down ? Native.MOUSEEVENTF_MIDDLEDOWN : Native.MOUSEEVENTF_MIDDLEUP)
        : (down ? Native.MOUSEEVENTF_LEFTDOWN : Native.MOUSEEVENTF_LEFTUP);
      Native.mouse_event(flag, 0, 0, 0, 0);
    }

    static void ReleaseHeldModifiers() {
      ReleaseModifiers(heldModifiers);
      heldModifiers.Clear();
    }

    static void ReleaseHeldInput() {
      for (int i = heldButtons.Count - 1; i >= 0; i--) MouseButton(heldButtons[i], false);
      heldButtons.Clear();
      ReleaseHeldModifiers();
      FlushWheelAccumulator();
    }

    static void HandleInput(Dictionary<string, object> cmd) {
      try {
        string action = cmd.ContainsKey("action") ? Convert.ToString(cmd["action"]) : "";
        if (action == "release_all") {
          ReleaseHeldInput();
          return;
        }
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
          var newMods = new List<byte>();
          for (int i = 0; i < mods.Count; i++) {
            if (!heldModifiers.Contains(mods[i])) newMods.Add(mods[i]);
          }
          PressModifiers(newMods);
          heldModifiers.AddRange(newMods);
          MouseButton(button, true);
          if (!heldButtons.Contains(button)) heldButtons.Add(button);
        } else if (action == "mouseup") {
          int button = cmd.ContainsKey("button") ? Convert.ToInt32(cmd["button"]) : 0;
          // Gói không toạ độ = chỉ nhả tại chỗ (AI đang bấm trên máy): không kéo con trỏ đi.
          if (cmd.ContainsKey("rx") || cmd.ContainsKey("x")) Native.SetCursorPos(targetX, targetY);
          MouseButton(button, false);
          heldButtons.Remove(button);
          if (heldButtons.Count == 0) ReleaseHeldModifiers();
          if (button == 0) ProbeInputFocus();
        } else if (action == "scroll") {
          int deltaY = cmd.ContainsKey("deltaY") ? Convert.ToInt32(cmd["deltaY"]) : 0;
          int deltaX = cmd.ContainsKey("deltaX") ? Convert.ToInt32(cmd["deltaX"]) : 0;
          Native.SetCursorPos(targetX, targetY);
          PressModifiers(mods);
          try {
            if (deltaY != 0) {
              if (Math.Abs(deltaY) >= 120) {
                Native.mouse_event(Native.MOUSEEVENTF_WHEEL, 0, 0, -deltaY, 0);
                wheelAccY = 0;
              } else if (Math.Abs(deltaY) >= 70) {
                int sign = deltaY > 0 ? 1 : -1;
                Native.mouse_event(Native.MOUSEEVENTF_WHEEL, 0, 0, -sign * 120, 0);
                wheelAccY = 0;
              } else {
                wheelAccY += deltaY;
                if (Math.Abs(wheelAccY) >= 120) {
                  int steps = wheelAccY / 120;
                  Native.mouse_event(Native.MOUSEEVENTF_WHEEL, 0, 0, -steps * 120, 0);
                  wheelAccY %= 120;
                }
              }
            }
            if (deltaX != 0) {
              if (Math.Abs(deltaX) >= 120) {
                Native.mouse_event(Native.MOUSEEVENTF_HWHEEL, 0, 0, deltaX, 0);
                wheelAccX = 0;
              } else if (Math.Abs(deltaX) >= 70) {
                int sign = deltaX > 0 ? 1 : -1;
                Native.mouse_event(Native.MOUSEEVENTF_HWHEEL, 0, 0, sign * 120, 0);
                wheelAccX = 0;
              } else {
                wheelAccX += deltaX;
                if (Math.Abs(wheelAccX) >= 120) {
                  int steps = wheelAccX / 120;
                  Native.mouse_event(Native.MOUSEEVENTF_HWHEEL, 0, 0, steps * 120, 0);
                  wheelAccX %= 120;
                }
              }
            }
          } finally {
            ReleaseModifiers(mods);
          }
        } else if (action == "type") {
          string text = cmd.ContainsKey("text") ? Convert.ToString(cmd["text"]) : "";
          if (!string.IsNullOrEmpty(text)) TypeUnicode(text);
        } else if (action == "clipboard") {
          string text = cmd.ContainsKey("text") ? Convert.ToString(cmd["text"]) : "";
          if (!string.IsNullOrEmpty(text)) ClipboardSync.SetText(text);
        } else if (action == "paste") {
          string text = cmd.ContainsKey("text") ? Convert.ToString(cmd["text"]) : "";
          if (!string.IsNullOrEmpty(text)) {
            if (ClipboardSync.SetText(text)) {
              Native.keybd_event(0x11, 0, 0, UIntPtr.Zero);
              Thread.Sleep(8);
              Native.keybd_event(0x56, 0, 0, UIntPtr.Zero);
              Thread.Sleep(15);
              Native.keybd_event(0x56, 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
              Native.keybd_event(0x11, 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
            } else {
              TypeUnicode(text);
            }
          }
        } else if (action == "paste_image") {
          string b64 = cmd.ContainsKey("data") ? Convert.ToString(cmd["data"]) : "";
          if (!string.IsNullOrEmpty(b64)) {
            if (cmd.ContainsKey("click") && Convert.ToBoolean(cmd["click"])) {
              Native.SetCursorPos(targetX, targetY);
              Thread.Sleep(20);
              Native.mouse_event(Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
              Thread.Sleep(15);
              Native.mouse_event(Native.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
              Thread.Sleep(35);
            }
            var sta = new Thread(() => {
              try {
                byte[] bytes = Convert.FromBase64String(b64);
                using (var ms = new System.IO.MemoryStream(bytes)) {
                  using (var src = System.Drawing.Image.FromStream(ms)) {
                    var dataObj = new System.Windows.Forms.DataObject();
                    var bmp = new System.Drawing.Bitmap(src.Width, src.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                    using (var g = System.Drawing.Graphics.FromImage(bmp)) {
                      g.DrawImage(src, 0, 0, src.Width, src.Height);
                    }
                    dataObj.SetImage(bmp);
                    try {
                      string tempFile = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "aivin_paste_" + DateTime.Now.Ticks + ".png");
                      bmp.Save(tempFile, System.Drawing.Imaging.ImageFormat.Png);
                      var sc = new System.Collections.Specialized.StringCollection();
                      sc.Add(tempFile);
                      dataObj.SetFileDropList(sc);
                    } catch { }
                    System.Windows.Forms.Clipboard.SetDataObject(dataObj, true);
                  }
                }
              } catch { }
            });
            sta.SetApartmentState(ApartmentState.STA);
            sta.Start();
            if (sta.Join(3000)) {
              Thread.Sleep(60);
              Native.keybd_event(0x11, 0, 0, UIntPtr.Zero);
              Thread.Sleep(20);
              Native.keybd_event(0x56, 0, 0, UIntPtr.Zero);
              Thread.Sleep(30);
              Native.keybd_event(0x56, 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
              Thread.Sleep(15);
              Native.keybd_event(0x11, 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
            }
          }
        } else if (action == "paste_file") {
          string filePath = cmd.ContainsKey("path") ? Convert.ToString(cmd["path"]) : "";
          if (!string.IsNullOrEmpty(filePath) && System.IO.File.Exists(filePath)) {
            if (cmd.ContainsKey("click") && Convert.ToBoolean(cmd["click"])) {
              Native.SetCursorPos(targetX, targetY);
              Thread.Sleep(20);
              Native.mouse_event(Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
              Thread.Sleep(15);
              Native.mouse_event(Native.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
              Thread.Sleep(35);
            }
            var sta = new Thread(() => {
              try {
                var dataObj = new System.Windows.Forms.DataObject();
                var sc = new System.Collections.Specialized.StringCollection();
                sc.Add(filePath);
                dataObj.SetFileDropList(sc);
                string ext = System.IO.Path.GetExtension(filePath).ToLowerInvariant();
                if (ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".bmp" || ext == ".gif" || ext == ".webp") {
                  try {
                    using (var src = System.Drawing.Image.FromFile(filePath)) {
                      var bmp = new System.Drawing.Bitmap(src.Width, src.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                      using (var g = System.Drawing.Graphics.FromImage(bmp)) {
                        g.DrawImage(src, 0, 0, src.Width, src.Height);
                      }
                      dataObj.SetImage(bmp);
                    }
                  } catch { }
                }
                System.Windows.Forms.Clipboard.SetDataObject(dataObj, true);
              } catch { }
            });
            sta.SetApartmentState(ApartmentState.STA);
            sta.Start();
            if (sta.Join(3000)) {
              Thread.Sleep(60);
              Native.keybd_event(0x11, 0, 0, UIntPtr.Zero);
              Thread.Sleep(20);
              Native.keybd_event(0x56, 0, 0, UIntPtr.Zero);
              Thread.Sleep(30);
              Native.keybd_event(0x56, 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
              Thread.Sleep(15);
              Native.keybd_event(0x11, 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
            }
          }
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
            // Giữ tổ hợp thì trình duyệt lặp ~30 lần/giây: chậm hơn nhịp đó là lệnh dồn lại, nhả tay rồi vùng chọn vẫn chạy tiếp. Tổ hợp có Win giữ nhịp chậm vì shell xử lý chậm.
            bool withWin = vks.Contains(0x5B) || vks.Contains(0x5C);
            int stepMs = withWin ? 10 : 2;
            int holdMs = withWin ? 40 : 12;
            for (int i = 0; i < vks.Count; i++) {
              SendKey(vks[i], false);
              Thread.Sleep(stepMs);
            }
            Thread.Sleep(holdMs);
            for (int i = vks.Count - 1; i >= 0; i--) {
              SendKey(vks[i], true);
              Thread.Sleep(stepMs);
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
     * trình duyệt trên điện thoại dựa vào đó tự mở bàn phím ảo. Kiểm sớm ở 40 ms để mở bàn phím nhanh, nếu chưa thấy mới chờ thêm.
     */
    static void ProbeInputFocus() {
      int seq = Interlocked.Increment(ref focusProbeSeq);
      ThreadPool.QueueUserWorkItem(_ => {
        try {
          Thread.Sleep(40);
          if (seq != focusProbeSeq) return;
          bool editable = HasSystemCaret();
          if (!editable) {
            Thread.Sleep(90);
            if (seq != focusProbeSeq) return;
            editable = HasSystemCaret() || FocusedIsTextInput();
          }
          var msg = new Dictionary<string, object>();
          msg["t"] = "input_focus";
          msg["editable"] = editable;
          Out.Send(msg);
        } catch {
        }
      });
    }

    static bool HasSystemCaret() {
      var info = new Native.GUITHREADINFO();
      info.cbSize = Marshal.SizeOf(typeof(Native.GUITHREADINFO));
      IntPtr fg = Native.GetForegroundWindow();
      uint tid = fg == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(fg, IntPtr.Zero);
      return tid != 0 && Native.GetGUIThreadInfo(tid, ref info) && info.hwndCaret != IntPtr.Zero;
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
        SendKey(vk, false);
        Thread.Sleep(15);
        SendKey(vk, true);
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
  if ($env:AIVIN_CAST_COMPILE_ONLY -eq '1') { exit 0 }
  Add-Type -Path $dll
}
if ($env:AIVIN_CAST_COMPILE_ONLY -eq '1') { exit 0 }
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
try {
  [AivinDesktopCast.CastHost]::Run($env:AIVIN_CAST_ARGS)
} catch {
  $m = @{ t = 'error'; error = $_.Exception.Message } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($m)
  exit 1
}
`;
