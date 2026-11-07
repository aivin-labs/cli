/**
 * Phần chụp hình + con trỏ của tiến trình quay (ghép vào DESKTOP_CAST_CSHARP, cùng C# 5 / .NET Framework 4.5+, không thư viện ngoài):
 * - DxgiScreen: Desktop Duplication API qua vtable COM thô — chờ tới khi màn hình đổi thật (không tốn CPU lúc đứng yên), nhanh hơn GDI, không kèm con trỏ.
 * - FrameSource: dùng DXGI khi được, không thì CopyFromScreen (máy ảo / RDP không có duplication, xoay màn hình, màn hình bảo mật UAC / khoá);
 *   DXGI hỏng giữa chừng (đổi độ phân giải, desktop bảo mật) thì lùi GDI + thử lại sau, không ngắt phiên.
 * - CursorTracker: vị trí + hình con trỏ tách khỏi khung hình để FE vẽ tức thì; `drawInFrame` (mặc định) thì vẽ vào khung như trước.
 */
export const DESKTOP_CAST_CAPTURE_CSHARP = String.raw`
namespace AivinDesktopCast {
  using System;
  using System.Collections.Generic;
  using System.Drawing;
  using System.Drawing.Imaging;
  using System.IO;
  using System.Runtime.InteropServices;
  using System.Threading;

  static class Com {
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate uint ReleaseFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int QueryFn(IntPtr self, ref Guid iid, out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int EnumFn(IntPtr self, uint index, out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int OutputDescFn(IntPtr self, out DxgiOutputDesc desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int DuplicateFn(IntPtr self, IntPtr device, out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int AcquireFn(IntPtr self, uint timeoutMs, out DxgiFrameInfo info, out IntPtr resource);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int ReleaseFrameFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate void TexDescFn(IntPtr self, out D3dTexDesc desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int CreateTexFn(IntPtr self, ref D3dTexDesc desc, IntPtr init, out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate void CopyResourceFn(IntPtr self, IntPtr dst, IntPtr src);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int MapFn(IntPtr self, IntPtr resource, uint sub, int mapType, uint flags, out D3dMapped mapped);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate void UnmapFn(IntPtr self, IntPtr resource, uint sub);

    public static T Fn<T>(IntPtr self, int slot) where T : class {
      IntPtr vtable = Marshal.ReadIntPtr(self);
      return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtable, slot * IntPtr.Size), typeof(T));
    }

    public static void Release(ref IntPtr p) {
      if (p == IntPtr.Zero) return;
      Fn<ReleaseFn>(p, 2)(p);
      p = IntPtr.Zero;
    }

    public static IntPtr Query(IntPtr self, Guid iid) {
      IntPtr result;
      int hr = Fn<QueryFn>(self, 0)(self, ref iid, out result);
      return hr < 0 ? IntPtr.Zero : result;
    }
  }

  [StructLayout(LayoutKind.Sequential)] public struct DxgiRect { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DxgiOutputDesc {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    public DxgiRect Coordinates;
    public int AttachedToDesktop;
    public int Rotation;
    public IntPtr Monitor;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct DxgiFrameInfo {
    public long LastPresentTime;
    public long LastMouseUpdateTime;
    public uint AccumulatedFrames;
    public int RectsCoalesced;
    public int ProtectedContentMaskedOut;
    public int PointerX, PointerY, PointerVisible;
    public uint TotalMetadataBufferSize;
    public uint PointerShapeBufferSize;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct D3dTexDesc {
    public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CpuAccessFlags, MiscFlags;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct D3dMapped { public IntPtr Data; public uint RowPitch; public uint DepthPitch; }

  /** Một màn hình đang được nhân bản (Desktop Duplication). */
  class DuplicatedOutput {
    const int WAIT_TIMEOUT = unchecked((int)0x887A0027);
    const uint FORMAT_BGRA = 87;
    const uint USAGE_STAGING = 3;
    const uint CPU_ACCESS_READ = 0x20000;
    const int MAP_READ = 1;
    static readonly Guid IID_TEXTURE2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");

    public Rectangle Rect;
    public IntPtr Device, Context, Duplication, Staging;
    readonly Com.AcquireFn acquire;
    readonly Com.ReleaseFrameFn releaseFrame;
    readonly Com.CopyResourceFn copyResource;
    readonly Com.MapFn map;
    readonly Com.UnmapFn unmap;

    public DuplicatedOutput(Rectangle rect, IntPtr device, IntPtr context, IntPtr duplication) {
      Rect = rect; Device = device; Context = context; Duplication = duplication;
      acquire = Com.Fn<Com.AcquireFn>(duplication, 8);
      releaseFrame = Com.Fn<Com.ReleaseFrameFn>(duplication, 14);
      copyResource = Com.Fn<Com.CopyResourceFn>(context, 47);
      map = Com.Fn<Com.MapFn>(context, 14);
      unmap = Com.Fn<Com.UnmapFn>(context, 15);
    }

    /** 1 = đã chép khung mới vào đích, 0 = màn hình không đổi, -1 = hỏng (mất quyền nhân bản: đổi chế độ hiển thị, desktop bảo mật). */
    public int Acquire(uint timeoutMs, IntPtr dst, int dstStride, Rectangle dstBounds) {
      DxgiFrameInfo info;
      IntPtr resource;
      int hr = acquire(Duplication, timeoutMs, out info, out resource);
      if (hr == WAIT_TIMEOUT) return 0;
      if (hr < 0) return -1;
      try {
        // Chỉ con trỏ đổi: hình màn hình không có gì mới (con trỏ đi đường riêng).
        if (info.LastPresentTime == 0) return 0;
        IntPtr texture = Com.Query(resource, IID_TEXTURE2D);
        if (texture == IntPtr.Zero) return -1;
        try {
          return CopyTexture(texture, dst, dstStride, dstBounds) ? 1 : -1;
        } finally {
          Com.Release(ref texture);
        }
      } finally {
        Com.Release(ref resource);
        releaseFrame(Duplication);
      }
    }

    bool CopyTexture(IntPtr texture, IntPtr dst, int dstStride, Rectangle dstBounds) {
      if (Staging == IntPtr.Zero && !CreateStaging(texture)) return false;
      copyResource(Context, Staging, texture);
      D3dMapped mapped;
      if (map(Context, Staging, 0, MAP_READ, 0, out mapped) < 0) return false;
      try {
        int offX = Rect.Left - dstBounds.Left;
        int offY = Rect.Top - dstBounds.Top;
        uint rowBytes = (uint)(Math.Min(Rect.Width, dstBounds.Width - offX) * 4);
        int rows = Math.Min(Rect.Height, dstBounds.Height - offY);
        long dstBase = dst.ToInt64() + (long)offY * dstStride + offX * 4;
        long srcBase = mapped.Data.ToInt64();
        for (int y = 0; y < rows; y++) {
          Native.CopyMemory(new IntPtr(dstBase + (long)y * dstStride), new IntPtr(srcBase + (long)y * mapped.RowPitch), rowBytes);
        }
        return true;
      } finally {
        unmap(Context, Staging, 0);
      }
    }

    bool CreateStaging(IntPtr texture) {
      D3dTexDesc desc;
      Com.Fn<Com.TexDescFn>(texture, 10)(texture, out desc);
      if (desc.Format != FORMAT_BGRA) return false;
      desc.MipLevels = 1;
      desc.ArraySize = 1;
      desc.SampleCount = 1;
      desc.SampleQuality = 0;
      desc.Usage = USAGE_STAGING;
      desc.BindFlags = 0;
      desc.CpuAccessFlags = CPU_ACCESS_READ;
      desc.MiscFlags = 0;
      return Com.Fn<Com.CreateTexFn>(Device, 5)(Device, ref desc, IntPtr.Zero, out Staging) >= 0;
    }

    public void Dispose() {
      Com.Release(ref Staging);
      Com.Release(ref Duplication);
      Com.Release(ref Context);
      Com.Release(ref Device);
    }
  }

  /** Nhân bản mọi màn hình nằm trong vùng cần quay; monitor = -1 ghép nhiều màn hình về đúng toạ độ. */
  public class DxgiScreen {
    static readonly Guid IID_FACTORY1 = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    static readonly Guid IID_OUTPUT1 = new Guid("00cddea8-939b-4b83-a340-a685226666cc");
    const int DRIVER_TYPE_UNKNOWN = 0;
    const uint SDK_VERSION = 7;
    const int ROTATION_UNSPECIFIED = 0;
    const int ROTATION_IDENTITY = 1;

    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint levelCount, uint sdk, out IntPtr device, out int level, out IntPtr context);

    public Rectangle Bounds;
    readonly List<DuplicatedOutput> outputs = new List<DuplicatedOutput>();

    /** Không dùng được (không có GPU / driver, phiên RDP, màn hình xoay, không phủ hết vùng cần quay) → null + lý do, dùng GDI. */
    public static DxgiScreen TryCreate(Rectangle bounds, out string reason) {
      reason = "";
      var screen = new DxgiScreen { Bounds = bounds };
      try {
        reason = screen.OpenOutputs();
        if (reason == "" && screen.outputs.Count == 0) reason = "no_output";
        if (reason == "") return screen;
      } catch (Exception ex) {
        reason = ex.GetType().Name;
      }
      screen.Dispose();
      return null;
    }

    string OpenOutputs() {
      Guid iid = IID_FACTORY1;
      IntPtr factory;
      int hr = CreateDXGIFactory1(ref iid, out factory);
      if (hr < 0) return "factory_" + hr.ToString("x");
      long covered = 0;
      try {
        var enumAdapters = Com.Fn<Com.EnumFn>(factory, 7);
        for (uint a = 0; ; a++) {
          IntPtr adapter;
          if (enumAdapters(factory, a, out adapter) < 0) break;
          try {
            for (uint o = 0; ; o++) {
              IntPtr output;
              if (Com.Fn<Com.EnumFn>(adapter, 7)(adapter, o, out output) < 0) break;
              try {
                DxgiOutputDesc desc;
                if (Com.Fn<Com.OutputDescFn>(output, 7)(output, out desc) < 0 || desc.AttachedToDesktop == 0) continue;
                var rect = Rectangle.FromLTRB(desc.Coordinates.Left, desc.Coordinates.Top, desc.Coordinates.Right, desc.Coordinates.Bottom);
                var inter = Rectangle.Intersect(rect, Bounds);
                if (inter.Width <= 0 || inter.Height <= 0) continue;
                if (rect.Left < Bounds.Left || rect.Top < Bounds.Top) return "partial_output";
                if (desc.Rotation != ROTATION_UNSPECIFIED && desc.Rotation != ROTATION_IDENTITY) return "rotated";
                string failed = OpenOutput(adapter, output, rect);
                if (failed != "") return failed;
                covered += (long)rect.Width * rect.Height;
              } finally {
                Com.Release(ref output);
              }
            }
          } finally {
            Com.Release(ref adapter);
          }
        }
      } finally {
        Com.Release(ref factory);
      }
      return covered > 0 ? "" : "no_output";
    }

    string OpenOutput(IntPtr adapter, IntPtr output, Rectangle rect) {
      IntPtr output1 = Com.Query(output, IID_OUTPUT1);
      if (output1 == IntPtr.Zero) return "no_output1";
      IntPtr device = IntPtr.Zero, context = IntPtr.Zero, duplication = IntPtr.Zero;
      try {
        int level;
        int hr = D3D11CreateDevice(adapter, DRIVER_TYPE_UNKNOWN, IntPtr.Zero, 0, IntPtr.Zero, 0, SDK_VERSION, out device, out level, out context);
        if (hr < 0) return "device_" + hr.ToString("x");
        hr = Com.Fn<Com.DuplicateFn>(output1, 22)(output1, device, out duplication);
        if (hr < 0) {
          Com.Release(ref context);
          Com.Release(ref device);
          return "duplicate_" + hr.ToString("x");
        }
        outputs.Add(new DuplicatedOutput(rect, device, context, duplication));
        return "";
      } finally {
        Com.Release(ref output1);
      }
    }

    /** Chờ tối đa waitMs trên màn hình đầu, các màn hình sau không chờ. 1 = có đổi, 0 = không, -1 = hỏng. */
    public int Acquire(Bitmap frame, int waitMs) {
      var rect = new Rectangle(0, 0, frame.Width, frame.Height);
      var data = frame.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
      try {
        int result = 0;
        for (int i = 0; i < outputs.Count; i++) {
          int r = outputs[i].Acquire(i == 0 ? (uint)Math.Max(0, waitMs) : 0, data.Scan0, data.Stride, Bounds);
          if (r < 0) return -1;
          if (r > 0) result = 1;
        }
        return result;
      } finally {
        frame.UnlockBits(data);
      }
    }

    public void Dispose() {
      foreach (var o in outputs) o.Dispose();
      outputs.Clear();
    }
  }

  /** Nguồn khung hình của vòng quay: giữ khung mới nhất (không kèm con trỏ), báo có đổi không. */
  public class FrameSource {
    const long DXGI_RETRY_MS = 5000;
    const long DXGI_LOST_RETRY_MS = 1000;

    Bitmap frame;
    Bitmap scratch;
    DxgiScreen dxgi;
    long retryAt;
    string reported;

    public Bitmap Frame { get { return frame; } }
    public bool UsingDxgi { get { return dxgi != null; } }

    /** true = khung đổi so với lần trước. DXGI chờ tới waitMs trong lúc màn hình đứng yên. */
    public bool Capture(Rectangle bounds, int waitMs, long nowMs) {
      bool resized = frame == null || frame.Width != bounds.Width || frame.Height != bounds.Height;
      if (resized) {
        if (frame != null) frame.Dispose();
        if (scratch != null) { scratch.Dispose(); scratch = null; }
        frame = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppRgb);
      }
      if (dxgi != null && dxgi.Bounds != bounds) CloseDxgi(0);
      if (dxgi == null && nowMs >= retryAt && OpenDxgi(bounds, nowMs)) {
        CastScreen.CopyScreen(frame, bounds);
        return true;
      }
      if (dxgi != null) {
        int r = dxgi.Acquire(frame, waitMs);
        if (r >= 0) return r > 0 || resized;
        CloseDxgi(nowMs + DXGI_LOST_RETRY_MS);
        Report("gdi", "lost");
      }
      return CaptureGdi(bounds) || resized;
    }

    bool OpenDxgi(Rectangle bounds, long nowMs) {
      string reason;
      dxgi = DxgiScreen.TryCreate(bounds, out reason);
      if (dxgi == null) {
        retryAt = nowMs + DXGI_RETRY_MS;
        Report("gdi", reason);
        return false;
      }
      Report("dxgi", "");
      return true;
    }

    void CloseDxgi(long nextRetry) {
      if (dxgi != null) dxgi.Dispose();
      dxgi = null;
      retryAt = nextRetry;
    }

    bool CaptureGdi(Rectangle bounds) {
      try {
        if (scratch == null) scratch = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppRgb);
        CastScreen.CopyScreen(scratch, bounds);
        bool same = CastScreen.SameFrame(scratch, frame);
        var t = frame;
        frame = scratch;
        scratch = t;
        return !same;
      } catch {
        return false;
      }
    }

    void Report(string mode, string reason) {
      string key = mode + ":" + reason;
      if (key == reported) return;
      reported = key;
      var msg = Out.Msg("capture");
      msg["mode"] = mode;
      msg["reason"] = reason;
      Out.Send(msg);
    }

    public void Dispose() {
      CloseDxgi(0);
    }
  }

  /** Số liệu máy báo trong mỗi khung để chế độ Tự động ở FE quyết định: hình đổi bao nhiêu, máy có quá tải không. */
  public class HostStats {
    const long WINDOW_MS = 1000;
    const long THUMB_INTERVAL_MS = 100;
    const double LOAD_SMOOTHING = 0.2;

    long windowStart;
    long lastThumbMs;
    byte[] lastThumb;
    int changes;
    double maxDiff;
    double loadMs;
    long lastIdle, lastKernel, lastUser;
    Dictionary<string, object> published = new Dictionary<string, object>();

    public void OnChange(Bitmap frame, long nowMs) {
      changes++;
      if (nowMs - lastThumbMs < THUMB_INTERVAL_MS) return;
      lastThumbMs = nowMs;
      byte[] thumb = CastScreen.Thumb(frame);
      if (lastThumb != null) maxDiff = Math.Max(maxDiff, CastScreen.Diff(thumb, lastThumb));
      lastThumb = thumb;
    }

    public void AddLoad(long ms) {
      loadMs = loadMs <= 0 ? ms : loadMs + (ms - loadMs) * LOAD_SMOOTHING;
    }

    public Dictionary<string, object> Snapshot(long nowMs) {
      if (nowMs - windowStart >= WINDOW_MS) {
        var next = new Dictionary<string, object>();
        next["changes"] = changes;
        next["diff"] = Math.Round(maxDiff, 3);
        next["loadMs"] = Math.Round(loadMs, 1);
        next["cpu"] = CpuPercent();
        published = next;
        changes = 0;
        maxDiff = 0;
        windowStart = nowMs;
      }
      return published;
    }

    int CpuPercent() {
      long idle, kernel, user;
      if (!Native.GetSystemTimes(out idle, out kernel, out user)) return 0;
      long total = (kernel - lastKernel) + (user - lastUser);
      long idleDelta = idle - lastIdle;
      bool first = lastKernel == 0;
      lastIdle = idle; lastKernel = kernel; lastUser = user;
      if (first || total <= 0) return 0;
      return (int)Math.Round(100.0 * (total - idleDelta) / total);
    }
  }

  /** Theo dõi con trỏ ở luồng riêng (nhẹ, ~60 lần/giây): gửi vị trí khi đổi, gửi hình một lần cho mỗi con trỏ. */
  public static class CursorTracker {
    const int POLL_MS = 15;
    const int MAX_SHAPE_SIDE = 128;
    /** Vẽ con trỏ vào khung hình (mặc định, đường JPEG / FE cũ) thay vì gửi riêng. */
    public static volatile bool DrawInFrame = true;
    /** Tăng mỗi khi con trỏ đổi — vòng quay dùng để gửi khung khi con trỏ nằm trong hình. */
    public static volatile int Seq = 0;
    static volatile bool forceEmit = false;
    static readonly Dictionary<IntPtr, int> shapeIds = new Dictionary<IntPtr, int>();

    public static void Start() {
      var t = new Thread(Loop);
      t.IsBackground = true;
      t.Start();
    }

    public static void SetDrawInFrame(bool value) {
      DrawInFrame = value;
      forceEmit = true;
    }

    static void Loop() {
      int lastX = int.MinValue, lastY = int.MinValue, lastShape = -1;
      bool lastVisible = false;
      while (CastHost.Running) {
        try {
          Native.CURSORINFO pci;
          pci.cbSize = Marshal.SizeOf(typeof(Native.CURSORINFO));
          if (Native.GetCursorInfo(out pci)) {
            bool visible = (pci.flags & Native.CURSOR_SHOWING) != 0;
            int x = pci.ptScreenPos.x, y = pci.ptScreenPos.y;
            bool drawInFrame = DrawInFrame;
            int shape = visible && !drawInFrame ? EnsureShape(pci.hCursor) : lastShape;
            bool changed = x != lastX || y != lastY || visible != lastVisible || shape != lastShape;
            if (changed) Seq = Seq + 1;
            if ((changed || forceEmit) && !drawInFrame) {
              forceEmit = false;
              Emit(x, y, visible, shape);
            }
            lastX = x; lastY = y; lastVisible = visible; lastShape = shape;
          }
        } catch {
        }
        Thread.Sleep(POLL_MS);
      }
    }

    static void Emit(int x, int y, bool visible, int shape) {
      var b = CastHost.CurrentBounds;
      var msg = Out.Msg("cursor");
      msg["x"] = x - b.X;
      msg["y"] = y - b.Y;
      msg["visible"] = visible;
      msg["shape"] = shape;
      Out.Send(msg);
    }

    static int EnsureShape(IntPtr handle) {
      int id;
      if (shapeIds.TryGetValue(handle, out id)) return id;
      id = shapeIds.Count + 1;
      shapeIds[handle] = id;
      var msg = Out.Msg("cursor_shape");
      msg["id"] = id;
      int hotX, hotY;
      msg["png"] = RenderShape(handle, out hotX, out hotY);
      msg["hotX"] = hotX;
      msg["hotY"] = hotY;
      Out.Send(msg);
      return id;
    }

    /** Điểm nóng của con trỏ (đầu mũi tên): ptScreenPos là vị trí điểm này, không phải góc ảnh. */
    public static Point Hotspot(IntPtr handle) {
      Native.ICONINFO ii;
      if (!Native.GetIconInfo(handle, out ii)) return Point.Empty;
      if (ii.hbmMask != IntPtr.Zero) Native.DeleteObject(ii.hbmMask);
      if (ii.hbmColor != IntPtr.Zero) Native.DeleteObject(ii.hbmColor);
      return new Point(ii.xHotspot, ii.yHotspot);
    }

    static string RenderShape(IntPtr handle, out int hotX, out int hotY) {
      hotX = 0; hotY = 0;
      Native.ICONINFO ii;
      if (!Native.GetIconInfo(handle, out ii)) return "";
      try {
        hotX = ii.xHotspot;
        hotY = ii.yHotspot;
        int w, h;
        int[] pixels = ii.hbmColor != IntPtr.Zero ? ColorPixels(ii, out w, out h) : MonochromePixels(ii, out w, out h);
        if (pixels == null || w > MAX_SHAPE_SIDE || h > MAX_SHAPE_SIDE) return "";
        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
          var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
          for (int y = 0; y < h; y++) Marshal.Copy(pixels, y * w, new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), w);
          bmp.UnlockBits(data);
          using (var ms = new MemoryStream()) {
            bmp.Save(ms, ImageFormat.Png);
            return Convert.ToBase64String(ms.ToArray());
          }
        }
      } finally {
        if (ii.hbmMask != IntPtr.Zero) Native.DeleteObject(ii.hbmMask);
        if (ii.hbmColor != IntPtr.Zero) Native.DeleteObject(ii.hbmColor);
      }
    }

    static int[] ColorPixels(Native.ICONINFO ii, out int w, out int h) {
      int[] color = ReadBitmap(ii.hbmColor, out w, out h);
      if (color == null) return null;
      bool hasAlpha = false;
      for (int i = 0; i < color.Length && !hasAlpha; i++) hasAlpha = ((uint)color[i] >> 24) != 0;
      if (hasAlpha) return color;
      int mw, mh;
      int[] mask = ReadBitmap(ii.hbmMask, out mw, out mh);
      if (mask == null || mw != w || mh != h) return null;
      for (int i = 0; i < color.Length; i++) {
        color[i] = (mask[i] & 0xFFFFFF) != 0 ? 0 : (color[i] | unchecked((int)0xFF000000));
      }
      return color;
    }

    /** Con trỏ đen trắng (chữ I...): nửa trên AND, nửa dưới XOR. Điểm "đảo màu" không vẽ được bằng ảnh → đen, viền trắng để thấy trên cả nền tối. */
    static int[] MonochromePixels(Native.ICONINFO ii, out int w, out int h) {
      int fullH;
      int[] mask = ReadBitmap(ii.hbmMask, out w, out fullH);
      h = fullH / 2;
      if (mask == null) return null;
      const int BLACK = unchecked((int)0xFF000000);
      const int WHITE = unchecked((int)0xFFFFFFFF);
      var pixels = new int[w * h];
      var inverted = new bool[w * h];
      for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
          bool and = (mask[y * w + x] & 0xFFFFFF) != 0;
          bool xor = (mask[(y + h) * w + x] & 0xFFFFFF) != 0;
          if (and && xor) inverted[y * w + x] = true;
          pixels[y * w + x] = and && !xor ? 0 : (!and && xor ? WHITE : BLACK);
        }
      }
      for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
          if (!inverted[y * w + x]) continue;
          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              int nx = x + dx, ny = y + dy;
              if (nx >= 0 && ny >= 0 && nx < w && ny < h && pixels[ny * w + nx] == 0) pixels[ny * w + nx] = WHITE;
            }
          }
        }
      }
      return pixels;
    }

    static int[] ReadBitmap(IntPtr hbm, out int w, out int h) {
      w = 0; h = 0;
      Native.BITMAP bm;
      if (Native.GetObject(hbm, Marshal.SizeOf(typeof(Native.BITMAP)), out bm) == 0) return null;
      w = bm.bmWidth;
      h = bm.bmHeight;
      var info = new Native.BITMAPINFOHEADER();
      info.biSize = Marshal.SizeOf(typeof(Native.BITMAPINFOHEADER));
      info.biWidth = w;
      info.biHeight = -h;
      info.biPlanes = 1;
      info.biBitCount = 32;
      var pixels = new int[w * h];
      IntPtr dc = Native.GetDC(IntPtr.Zero);
      try {
        return Native.GetDIBits(dc, hbm, 0, (uint)h, pixels, ref info, 0) == 0 ? null : pixels;
      } finally {
        Native.ReleaseDC(IntPtr.Zero, dc);
      }
    }
  }
}
`;
