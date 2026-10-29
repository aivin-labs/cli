/**
 * Tiến trình ghi họp + chụp màn hình trên Windows (29/10/2026) — PowerShell dịch mã C# dưới đây một lần (lưu DLL theo dấu vân tay, như gui/),
 * chạy riêng một tiến trình cho mỗi buổi ghi (không chung host tuần tự của gui/: ghi kéo dài hàng giờ).
 *
 * - Ghi: WASAPI dùng chung (shared mode, thăm dò mỗi 10 ms) trên thiết bị LIÊN LẠC mặc định (`eCommunications` — app họp phát / thu ở đây):
 *   loopback của loa = tiếng người khác trong cuộc họp, và micro = tiếng chủ máy. Mỗi luồng đổi về 16 kHz mono 16-bit, ghi ra `system.wav` /
 *   `mic.wav`. Loopback không có gói nào khi máy im → chèn im lặng theo đồng hồ để hai tệp luôn khớp thời gian.
 * - Mỗi giây báo mức âm (RMS) của hai luồng; mỗi 10 s báo tiêu đề cửa sổ đang mở (biết khi nào cửa sổ họp đóng); khi màn hình đổi rõ (so ảnh
 *   thu nhỏ) thì lưu một ảnh JPEG (slide đang chia sẻ) vào `screens/`. Linh vật tự ẩn khỏi ảnh chụp (WDA_EXCLUDEFROMCAPTURE).
 * - Dừng: dòng `stop` ở stdin, hoặc stdin đóng (daemon thoát) → đóng tệp WAV cho đúng rồi thoát.
 * - Chế độ `snap`: chụp một màn hình (hoặc tất cả) một lần → JSON `{ image: { mime, base64, width, height }, monitors }`.
 *
 * PowerShell 5.1 dịch bằng C# 5: không `$""`, `?.`, `out var`, thân hàm dạng `=>`.
 */

export const MEDIA_HOST_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace AivinMedia {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
  }

  [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out int flags, out long devicePosition, out long qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
  }

  static class Native {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
    [DllImport("ole32.dll")] public static extern void CoTaskMemFree(IntPtr p);
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
    public static Dictionary<string, object> Msg(string t) { var d = new Dictionary<string, object>(); d["t"] = t; return d; }
  }

  /** WAV 16 kHz mono 16-bit, kích thước ghi lại khi đóng. */
  class WavWriter {
    public const int Rate = 16000;
    readonly FileStream fs;
    long samples;
    public WavWriter(string path) {
      fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read);
      fs.Write(new byte[44], 0, 44);
    }
    public long Samples { get { return samples; } }
    public void Write(short[] buf, int count) {
      var bytes = new byte[count * 2];
      Buffer.BlockCopy(buf, 0, bytes, 0, count * 2);
      fs.Write(bytes, 0, bytes.Length);
      samples += count;
    }
    public void WriteSilence(long count) {
      var zero = new byte[3200];
      while (count > 0) { int n = (int)Math.Min(count, 1600); fs.Write(zero, 0, n * 2); samples += n; count -= n; }
    }
    public void Close() {
      long data = samples * 2;
      fs.Seek(0, SeekOrigin.Begin);
      var w = new BinaryWriter(fs);
      w.Write(Encoding.ASCII.GetBytes("RIFF")); w.Write((uint)(36 + data)); w.Write(Encoding.ASCII.GetBytes("WAVE"));
      w.Write(Encoding.ASCII.GetBytes("fmt ")); w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(Rate); w.Write(Rate * 2); w.Write((short)2); w.Write((short)16);
      w.Write(Encoding.ASCII.GetBytes("data")); w.Write((uint)data);
      w.Flush(); fs.Flush(); fs.Close();
    }
  }

  /** Một luồng WASAPI (loopback của loa hoặc micro) → WAV 16 kHz mono. */
  class AudioStream {
    public readonly string Name;
    readonly IAudioClient client;
    readonly IAudioCaptureClient capture;
    readonly WavWriter wav;
    readonly int channels, bits; readonly bool isFloat; readonly double step;
    double acc, sum; int n;
    short[] outBuf = new short[16000];
    byte[] raw = new byte[0];
    double levelSum; long levelCount;

    AudioStream(string name, IAudioClient c, IAudioCaptureClient cap, WavWriter w, int ch, int rate, int b, bool f) {
      Name = name; client = c; capture = cap; wav = w; channels = ch; bits = b; isFloat = f; step = (double)WavWriter.Rate / rate;
    }

    public static AudioStream Open(string name, bool loopback, string path) {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      IMMDevice dev;
      // eCommunications (app họp dùng), không có thì eConsole.
      if (en.GetDefaultAudioEndpoint(loopback ? 0 : 1, 2, out dev) != 0 && en.GetDefaultAudioEndpoint(loopback ? 0 : 1, 0, out dev) != 0) throw new Exception("no " + name + " device");
      Guid iid = typeof(IAudioClient).GUID;
      object o;
      Check(dev.Activate(ref iid, 1 | 2 | 4 | 0x10, IntPtr.Zero, out o), "activate");
      var client = (IAudioClient)o;
      IntPtr fmt;
      Check(client.GetMixFormat(out fmt), "mix format");
      int tag = Marshal.ReadInt16(fmt, 0);
      int ch = Marshal.ReadInt16(fmt, 2);
      int rate = Marshal.ReadInt32(fmt, 4);
      int bits = Marshal.ReadInt16(fmt, 14);
      bool isFloat = tag == 3;
      if (tag == unchecked((short)0xFFFE)) {
        var sub = new byte[16];
        Marshal.Copy(new IntPtr(fmt.ToInt64() + 24), sub, 0, 16);
        isFloat = new Guid(sub) == new Guid("00000003-0000-0010-8000-00aa00389b71");
      }
      if (!(isFloat && bits == 32) && !(!isFloat && (bits == 16 || bits == 32))) { Native.CoTaskMemFree(fmt); throw new Exception(name + ": unsupported format " + bits + " bit"); }
      Check(client.Initialize(0, loopback ? 0x00020000 : 0, 10000000, 0, fmt, IntPtr.Zero), "initialize");
      Native.CoTaskMemFree(fmt);
      Guid capIid = typeof(IAudioCaptureClient).GUID;
      object c2;
      Check(client.GetService(ref capIid, out c2), "capture client");
      var s = new AudioStream(name, client, (IAudioCaptureClient)c2, new WavWriter(path), ch, rate, bits, isFloat);
      Check(client.Start(), "start");
      return s;
    }

    static void Check(int hr, string what) { if (hr != 0) throw new Exception(what + " failed 0x" + hr.ToString("X8")); }

    /** Đọc hết gói đang chờ; trả số khung đã đọc. */
    public int Pump() {
      int total = 0;
      uint packet;
      while (capture.GetNextPacketSize(out packet) == 0 && packet > 0) {
        IntPtr data; uint frames; int flags; long pos, qpc;
        if (capture.GetBuffer(out data, out frames, out flags, out pos, out qpc) != 0) break;
        bool silent = (flags & 2) != 0;
        int outCount = 0;
        int bytesPerFrame = channels * bits / 8;
        int bytes = (int)frames * bytesPerFrame;
        if (!silent) { if (raw.Length < bytes) raw = new byte[bytes]; Marshal.Copy(data, raw, 0, bytes); }
        for (int i = 0; i < frames; i++) {
          double v = 0;
          if (!silent) {
            int off = i * bytesPerFrame;
            for (int c = 0; c < channels; c++, off += bits / 8) {
              if (isFloat) v += BitConverter.ToSingle(raw, off);
              else if (bits == 16) v += BitConverter.ToInt16(raw, off) / 32768.0;
              else v += BitConverter.ToInt32(raw, off) / 2147483648.0;
            }
            v /= channels;
          }
          // Giảm mẫu bằng trung bình từng khoảng (lọc thông thấp thô — đủ cho nhận dạng giọng nói).
          sum += v; n++; acc += step;
          if (acc >= 1) {
            double m = sum / n; acc -= 1; sum = 0; n = 0;
            if (m > 1) m = 1; if (m < -1) m = -1;
            if (outCount >= outBuf.Length) { wav.Write(outBuf, outCount); outCount = 0; }
            outBuf[outCount++] = (short)(m * 32767);
            levelSum += m * m; levelCount++;
          }
        }
        if (outCount > 0) wav.Write(outBuf, outCount);
        capture.ReleaseBuffer(frames);
        total += (int)frames;
      }
      return total;
    }

    /** Im lặng theo đồng hồ khi loopback không gửi gói (máy không phát tiếng). */
    public void PadTo(long expected) {
      long missing = expected - wav.Samples;
      if (missing > WavWriter.Rate / 5) wav.WriteSilence(missing);
    }

    public double TakeLevel() {
      double r = levelCount > 0 ? Math.Sqrt(levelSum / levelCount) : 0;
      levelSum = 0; levelCount = 0;
      return Math.Round(r, 4);
    }

    public long Samples { get { return wav.Samples; } }

    public void Close() {
      try { client.Stop(); } catch { }
      wav.Close();
    }
  }

  public static class Screen {
    public static Bitmap Grab(int monitor) {
      Rectangle r = monitor < 0 ? SystemInformation.VirtualScreen : System.Windows.Forms.Screen.AllScreens[Math.Min(monitor, System.Windows.Forms.Screen.AllScreens.Length - 1)].Bounds;
      var bmp = new Bitmap(r.Width, r.Height, PixelFormat.Format24bppRgb);
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(r.Left, r.Top, 0, 0, r.Size);
      return bmp;
    }

    public static Bitmap Scale(Bitmap src, int maxWidth) {
      if (src.Width <= maxWidth) return src;
      int h = (int)Math.Round(src.Height * (double)maxWidth / src.Width);
      var dst = new Bitmap(maxWidth, h, PixelFormat.Format24bppRgb);
      using (var g = Graphics.FromImage(dst)) { g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear; g.DrawImage(src, 0, 0, maxWidth, h); }
      src.Dispose();
      return dst;
    }

    public static byte[] Jpeg(Bitmap bmp, int quality) {
      var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
      var p = new EncoderParameters(1);
      p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
      using (var ms = new MemoryStream()) { bmp.Save(ms, codec, p); return ms.ToArray(); }
    }

    /** Ảnh thu nhỏ xám 64x36 để so màn hình có đổi không. */
    public static byte[] Thumb(Bitmap src) {
      var t = new byte[64 * 36];
      using (var small = new Bitmap(64, 36, PixelFormat.Format24bppRgb)) {
        using (var g = Graphics.FromImage(small)) g.DrawImage(src, 0, 0, 64, 36);
        for (int y = 0; y < 36; y++) for (int x = 0; x < 64; x++) { var c = small.GetPixel(x, y); t[y * 64 + x] = (byte)((c.R * 3 + c.G * 6 + c.B) / 10); }
      }
      return t;
    }

    public static double Diff(byte[] a, byte[] b) {
      if (a == null || b == null) return 255;
      long s = 0;
      for (int i = 0; i < a.Length; i++) s += Math.Abs(a[i] - b[i]);
      return (double)s / a.Length;
    }

    public static void Snap(string argsJson) {
      Native.SetProcessDPIAware();
      var a = Out.Parse(argsJson);
      int monitor = a.ContainsKey("monitor") ? Convert.ToInt32(a["monitor"]) : -1;
      int maxWidth = a.ContainsKey("max_width") ? Convert.ToInt32(a["max_width"]) : 1600;
      int quality = a.ContainsKey("quality") ? Convert.ToInt32(a["quality"]) : 70;
      var res = Out.Msg("snap");
      var monitors = new List<object>();
      var all = System.Windows.Forms.Screen.AllScreens;
      for (int i = 0; i < all.Length; i++) {
        var m = new Dictionary<string, object>();
        m["index"] = i; m["primary"] = all[i].Primary; m["width"] = all[i].Bounds.Width; m["height"] = all[i].Bounds.Height; m["left"] = all[i].Bounds.Left; m["top"] = all[i].Bounds.Top;
        monitors.Add(m);
      }
      using (var bmp = Scale(Grab(monitor), Math.Max(320, Math.Min(maxWidth, 3840)))) {
        var img = new Dictionary<string, object>();
        img["mime"] = "image/jpeg"; img["base64"] = Convert.ToBase64String(Jpeg(bmp, quality)); img["width"] = bmp.Width; img["height"] = bmp.Height;
        res["image"] = img;
      }
      res["monitors"] = monitors;
      Out.Send(res);
    }
  }

  public static class Recorder {
    static volatile bool stopping;

    public static void Run(string argsJson) {
      Native.SetProcessDPIAware();
      var a = Out.Parse(argsJson);
      string dir = (string)a["dir"];
      bool screens = !a.ContainsKey("screens") || Convert.ToBoolean(a["screens"]);
      int screenEvery = a.ContainsKey("screens_every_sec") ? Convert.ToInt32(a["screens_every_sec"]) : 15;
      int maxScreens = a.ContainsKey("max_screens") ? Convert.ToInt32(a["max_screens"]) : 300;
      Directory.CreateDirectory(dir);
      if (screens) Directory.CreateDirectory(Path.Combine(dir, "screens"));

      AudioStream sys = null, mic = null;
      try { sys = AudioStream.Open("system", true, Path.Combine(dir, "system.wav")); }
      catch (Exception e) { var w = Out.Msg("warn"); w["what"] = "system"; w["error"] = e.Message; Out.Send(w); }
      try { mic = AudioStream.Open("mic", false, Path.Combine(dir, "mic.wav")); }
      catch (Exception e) { var w = Out.Msg("warn"); w["what"] = "mic"; w["error"] = e.Message; Out.Send(w); }
      if (sys == null && mic == null) { var f = Out.Msg("error"); f["error"] = "No audio device could be opened"; Out.Send(f); return; }

      var reader = new Thread(() => {
        try { string line; while ((line = Console.In.ReadLine()) != null) { if (line.Trim() == "stop") break; } } catch { }
        stopping = true;
      });
      reader.IsBackground = true;
      reader.Start();

      var ready = Out.Msg("ready"); ready["system"] = sys != null; ready["mic"] = mic != null; Out.Send(ready);
      var clock = System.Diagnostics.Stopwatch.StartNew();
      long nextLevel = 1000, nextWindows = 0, nextScreen = 2000;
      byte[] lastThumb = null;
      int screenCount = 0;
      while (!stopping) {
        long expected = clock.ElapsedMilliseconds * WavWriter.Rate / 1000;
        if (sys != null && sys.Pump() == 0) sys.PadTo(expected);
        if (mic != null && mic.Pump() == 0) mic.PadTo(expected);
        long ms = clock.ElapsedMilliseconds;
        if (ms >= nextLevel) {
          nextLevel += 1000;
          var l = Out.Msg("level"); l["secs"] = ms / 1000; l["system"] = sys != null ? sys.TakeLevel() : 0; l["mic"] = mic != null ? mic.TakeLevel() : 0;
          Out.Send(l);
        }
        if (ms >= nextWindows) {
          nextWindows = ms + 10000;
          var titles = new List<object>();
          Native.EnumWindows((h, p) => {
            if (titles.Count >= 200 || !Native.IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512);
            if (Native.GetWindowText(h, sb, 512) > 0) titles.Add(sb.ToString());
            return true;
          }, IntPtr.Zero);
          var wmsg = Out.Msg("windows"); wmsg["titles"] = titles; Out.Send(wmsg);
        }
        if (screens && ms >= nextScreen && screenCount < maxScreens) {
          nextScreen = ms + screenEvery * 1000;
          try {
            using (var full = Screen.Grab(-1)) {
              var thumb = Screen.Thumb(full);
              if (Screen.Diff(thumb, lastThumb) > 6) {
                lastThumb = thumb;
                long secs = ms / 1000;
                string name = string.Format("{0:D2}-{1:D2}-{2:D2}.jpg", secs / 3600, (secs / 60) % 60, secs % 60);
                using (var scaled = Screen.Scale(new Bitmap(full), 1600)) File.WriteAllBytes(Path.Combine(dir, "screens", name), Screen.Jpeg(scaled, 70));
                screenCount++;
                var s = Out.Msg("screen"); s["file"] = name; s["secs"] = secs; Out.Send(s);
              }
            }
          } catch (Exception e) { var w = Out.Msg("warn"); w["what"] = "screen"; w["error"] = e.Message; Out.Send(w); }
        }
        Thread.Sleep(10);
      }
      long end = clock.ElapsedMilliseconds * WavWriter.Rate / 1000;
      if (sys != null) { sys.Pump(); sys.PadTo(end); sys.Close(); }
      if (mic != null) { mic.Pump(); mic.PadTo(end); mic.Close(); }
      var done = Out.Msg("done"); done["secs"] = clock.ElapsedMilliseconds / 1000; done["system"] = sys != null; done["mic"] = mic != null; done["screens"] = screenCount;
      Out.Send(done);
    }
  }
}
`;

export const MEDIA_HOST_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
$dll = $env:AIVIN_MEDIA_DLL
$src = $env:AIVIN_MEDIA_SRC
$refs = @('System.Drawing', 'System.Windows.Forms', 'System.Web.Extensions')
foreach ($r in $refs) { Add-Type -AssemblyName $r }
if ($dll -and (Test-Path -LiteralPath $dll)) {
  Add-Type -Path $dll
} else {
  Add-Type -TypeDefinition ([IO.File]::ReadAllText($src)) -ReferencedAssemblies $refs -OutputAssembly $dll -OutputType Library
  Add-Type -Path $dll
}
try {
  if ($env:AIVIN_MEDIA_MODE -eq 'snap') { [AivinMedia.Screen]::Snap($env:AIVIN_MEDIA_ARGS) } else { [AivinMedia.Recorder]::Run($env:AIVIN_MEDIA_ARGS) }
} catch {
  $m = @{ t = 'error'; error = $_.Exception.Message } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($m)
  exit 1
}
`;
