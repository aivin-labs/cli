/**
 * Nói chuyện realtime với linh vật, phía cửa sổ (29/10/2026) — mã C# biên dịch trong host.ps1 (cùng khối Add-Type với AivinMascot.Input,
 * hostSource.mjs ghép vào), chạy luồng nền riêng, không qua PowerShell:
 * - Mic: mỗi ~100 ms một dòng `{"t":"voice_audio","audio":"<base64>"}` (PCM16 mono, tần số BE báo) ra stdout (qua Output — chung khoá với
 *   Send của PowerShell nên dòng không lẫn nhau). Ưu tiên bộ khử tiếng vọng của Windows (Voice Capture DSP, `Aec`: tự mở micro + nghe lại loa
 *   mặc định, trừ tiếng bot khỏi mic) → nói chen bằng giọng được. Máy không mở được DSP thì waveIn, và lúc bot đang phát (+ 350 ms đuôi) bỏ
 *   đoạn mic — không thì loa lọt vào mic, model tự nghe chính nó và tự ngắt lời; muốn ngắt lời bot thì bấm mic.
 * - Loa: waveOut theo tần số BE báo; dòng `voice_play` / `voice_flush` trên stdin được Input chặn lại đưa thẳng vào đây (không chờ nhịp 80 ms
 *   của UI), `voice_flush` = bỏ hết phần chưa phát (người dùng nói chen / bấm ngắt lời).
 * - Mic im quá 2 s (rút ra, Bluetooth rớt, đổi mic mặc định) → mở lại trên mic mặc định hiện tại; hỏng 3 lần liền → `voice_mic_lost`.
 * - Loa: đầu mỗi câu trả lời đợi đủ ~150 ms tiếng (hoặc 300 ms) rồi mới phát — mạng chập chờn không làm mất / giật mấy chữ đầu.
 * Bộ đệm + WAVEHDR nằm ở bộ nhớ không quản lý, luồng nền hỏi cờ WHDR_DONE (không dùng callback của winmm). Giữ toàn ASCII.
 */
export const VOICE_CS = String.raw`
  public static class Output {
    static readonly object Gate = new object();
    static StreamWriter w;
    public static void Line(string s) {
      lock (Gate) {
        try {
          if (w == null) { w = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)); w.AutoFlush = true; }
          w.WriteLine(s);
        } catch { }
      }
    }
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("59eff8b9-938c-4a26-82f2-95cb84cdc837")]
  public interface IMediaBuffer {
    [PreserveSig] int SetLength(int length);
    [PreserveSig] int GetMaxLength(out int max);
    [PreserveSig] int GetBufferAndLength(IntPtr ppBuffer, IntPtr pcbLength);
  }
  [StructLayout(LayoutKind.Sequential)] public struct DmoMediaType {
    public Guid Major, Sub; public int FixedSize, Temporal; public uint SampleSize; public Guid FormatType; public IntPtr Unk; public uint FormatSize; public IntPtr Format;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PropertyKey { public Guid Fmtid; public uint Pid; }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("d8ad0f58-5494-4102-97c5-ec798e59bcf4")]
  public interface IMediaObject {
    [PreserveSig] int GetStreamCount(out uint inputs, out uint outputs);
    [PreserveSig] int GetInputStreamInfo(uint index, out uint flags);
    [PreserveSig] int GetOutputStreamInfo(uint index, out uint flags);
    [PreserveSig] int GetInputType(uint index, uint type, IntPtr mt);
    [PreserveSig] int GetOutputType(uint index, uint type, IntPtr mt);
    [PreserveSig] int SetInputType(uint index, IntPtr mt, uint flags);
    [PreserveSig] int SetOutputType(uint index, ref DmoMediaType mt, uint flags);
    [PreserveSig] int GetInputCurrentType(uint index, IntPtr mt);
    [PreserveSig] int GetOutputCurrentType(uint index, IntPtr mt);
    [PreserveSig] int GetInputSizeInfo(uint index, out uint size, out uint lookahead, out uint align);
    [PreserveSig] int GetOutputSizeInfo(uint index, out uint size, out uint align);
    [PreserveSig] int GetInputMaxLatency(uint index, out long latency);
    [PreserveSig] int SetInputMaxLatency(uint index, long latency);
    [PreserveSig] int Flush();
    [PreserveSig] int Discontinuity(uint index);
    [PreserveSig] int AllocateStreamingResources();
    [PreserveSig] int FreeStreamingResources();
    [PreserveSig] int GetInputStatus(uint index, out uint flags);
    [PreserveSig] int ProcessInput(uint index, IMediaBuffer buffer, uint flags, long time, long length);
    [PreserveSig] int ProcessOutput(uint flags, uint count, IntPtr buffers, out uint status);
    [PreserveSig] int Lock(int locked);
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99")]
  public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, IntPtr value);
    [PreserveSig] int SetValue(ref PropertyKey key, IntPtr value);
    [PreserveSig] int Commit();
  }
  [ComVisible(true)] public sealed class MediaBuffer : IMediaBuffer {
    public readonly IntPtr Data; public readonly int Max; public int Length;
    public MediaBuffer(int max) { Max = max; Data = Marshal.AllocHGlobal(max); }
    public int SetLength(int length) { if (length < 0 || length > Max) return unchecked((int)0x80070057); Length = length; return 0; }
    public int GetMaxLength(out int max) { max = Max; return 0; }
    public int GetBufferAndLength(IntPtr ppBuffer, IntPtr pcbLength) {
      if (ppBuffer != IntPtr.Zero) Marshal.WriteIntPtr(ppBuffer, Data);
      if (pcbLength != IntPtr.Zero) Marshal.WriteInt32(pcbLength, Length);
      return 0;
    }
  }
  /** Windows' own echo canceller (Voice Capture DSP, the one Teams / Skype use) in source mode: it opens the default mic and listens back to
      the default speaker itself, and hands out mic audio with the speaker's sound taken out. Runs on its own thread; Start waits for it. */
  public sealed class Aec {
    static readonly Guid Clsid = new Guid("745057C7-F353-4F2D-A7EE-58434477730E");
    static readonly Guid SystemModeKey = new Guid("6f52c567-0360-4bd2-9617-ccbf1421c939");
    static readonly Guid AudioType = new Guid("73647561-0000-0010-8000-00AA00389B71"), PcmType = new Guid("00000001-0000-0010-8000-00AA00389B71");
    static readonly Guid WaveFormatType = new Guid("05589f81-c356-11ce-bf01-00aa0055595a");
    const uint INCOMPLETE = 0x01000000;
    public readonly int Rate;
    readonly Action<byte[]> sink;
    /** The DSP stopped working mid-way (device unplugged, driver error): the caller switches to plain capture. */
    public Action Failed;
    readonly ManualResetEvent started = new ManualResetEvent(false);
    volatile bool running = true, ok;
    public string Error;

    Aec(int rate, Action<byte[]> sink) { Rate = rate; this.sink = sink; }

    /** null = the DSP is not usable on this computer (caller falls back to plain capture). rate: 8000 / 11025 / 16000 / 22050. */
    public static Aec Start(int rate, Action<byte[]> sink, out string error) {
      var a = new Aec(rate, sink);
      var t = new Thread(a.Run); t.IsBackground = true; t.SetApartmentState(ApartmentState.MTA); t.Start();
      bool done = a.started.WaitOne(2000);
      error = done ? a.Error : "timed out";
      if (!done || !a.ok) { a.running = false; return null; }
      return a;
    }
    public void Stop() { running = false; }

    void Run() {
      IMediaObject dmo = null; IntPtr fmt = IntPtr.Zero, pv = IntPtr.Zero, outs = IntPtr.Zero, pbuf = IntPtr.Zero;
      try {
        dmo = (IMediaObject)Activator.CreateInstance(Type.GetTypeFromCLSID(Clsid));
        // MFPKEY_WMAAECMA_SYSTEM_MODE = SINGLE_CHANNEL_AEC (0): mic + loopback of the default devices, echo cancelled.
        var key = new PropertyKey { Fmtid = SystemModeKey, Pid = 2 };
        pv = Marshal.AllocHGlobal(24); for (int i = 0; i < 24; i++) Marshal.WriteByte(pv, i, 0);
        Marshal.WriteInt16(pv, 0, 3); Marshal.WriteInt32(pv, 8, 0);
        int hr = ((IPropertyStore)dmo).SetValue(ref key, pv);
        if (hr != 0) throw new Exception("system mode " + hr.ToString("x"));
        fmt = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(fmt, 0, 1); Marshal.WriteInt16(fmt, 2, 1); Marshal.WriteInt32(fmt, 4, Rate); Marshal.WriteInt32(fmt, 8, Rate * 2);
        Marshal.WriteInt16(fmt, 12, 2); Marshal.WriteInt16(fmt, 14, 16); Marshal.WriteInt16(fmt, 16, 0);
        var mt = new DmoMediaType { Major = AudioType, Sub = PcmType, FixedSize = 1, Temporal = 0, SampleSize = 2, FormatType = WaveFormatType, FormatSize = 18, Format = fmt };
        hr = dmo.SetOutputType(0, ref mt, 0);
        if (hr != 0) throw new Exception("output type " + hr.ToString("x"));
        hr = dmo.AllocateStreamingResources();
        if (hr != 0) throw new Exception("allocate " + hr.ToString("x"));
        var buf = new MediaBuffer(Rate * 2);
        // DMO_OUTPUT_DATA_BUFFER { IMediaBuffer* pBuffer; DWORD dwStatus; REFERENCE_TIME rtTimestamp, rtTimelength } built by hand.
        outs = Marshal.AllocHGlobal(32); for (int i = 0; i < 32; i++) Marshal.WriteByte(outs, i, 0);
        pbuf = Marshal.GetComInterfaceForObject(buf, typeof(IMediaBuffer)); Marshal.WriteIntPtr(outs, 0, pbuf);
        int statusAt = IntPtr.Size;
        // It only counts as working once real mic audio comes out (some audio devices make it fail after a second of empty reads).
        uint status;
        while (running) {
          bool got = false;
          do {
            buf.Length = 0; Marshal.WriteInt32(outs, statusAt, 0);
            hr = dmo.ProcessOutput(0, 1, outs, out status);
            if (hr < 0) { Error = "read " + hr.ToString("x"); if (ok && running && Failed != null) Failed(); running = false; break; }
            if (buf.Length > 0) {
              if (!ok) { ok = true; started.Set(); }
              var b = new byte[buf.Length]; Marshal.Copy(buf.Data, b, 0, buf.Length); sink(b); got = true;
            }
          } while (running && ((uint)Marshal.ReadInt32(outs, statusAt) & INCOMPLETE) != 0);
          if (!got) Thread.Sleep(10);
        }
      } catch (Exception e) { Error = e.Message; }
      finally {
        started.Set();
        try { if (dmo != null) { dmo.FreeStreamingResources(); Marshal.ReleaseComObject(dmo); } } catch { }
        if (fmt != IntPtr.Zero) Marshal.FreeHGlobal(fmt);
        if (pv != IntPtr.Zero) Marshal.FreeHGlobal(pv);
        if (outs != IntPtr.Zero) Marshal.FreeHGlobal(outs);
        if (pbuf != IntPtr.Zero) Marshal.Release(pbuf);
      }
    }
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCo { }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  }
  [StructLayout(LayoutKind.Sequential)] struct AudioClientProperties { public uint Size; public int Offload; public int Category; public int Options; }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("726778CD-F60A-4eda-82DE-E47610CD78AA")]
  interface IAudioClient2 {
    [PreserveSig] int Initialize(int shareMode, uint flags, long duration, long period, IntPtr format, IntPtr session);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint frames);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long def, out long min);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr h);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
    [PreserveSig] int IsOffloadCapable(int category, out int capable);
    [PreserveSig] int SetClientProperties(ref AudioClientProperties p);
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317")]
  interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong pos, out ulong qpc);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
  }
  /** Windows 11 voice processing: a mic stream opened as "Communications" gets the system's own echo canceller (and noise suppression)
      when the device / Voice Clarity provides one - the same path Teams uses on Windows 11. Shared mode converts to PCM16 mono for us. */
  public sealed class CommsMic {
    static readonly Guid AudioClient2Id = new Guid("726778CD-F60A-4eda-82DE-E47610CD78AA");
    static readonly Guid CaptureClientId = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    static readonly Guid AecControlId = new Guid("f4ae25b5-aaa3-437d-b6b3-dbbe2d0e9549");
    public readonly int Rate;
    public bool EchoCancelled;
    public string Error;
    readonly Action<byte[]> sink;
    readonly ManualResetEvent started = new ManualResetEvent(false);
    volatile bool running = true; bool ok;
    public Action Failed;

    CommsMic(int rate, Action<byte[]> sink) { Rate = rate; this.sink = sink; }

    /** null = could not open; requireAec: also null when the system has no echo canceller for this mic. */
    public static CommsMic Start(int rate, Action<byte[]> sink, bool requireAec, out string error) {
      var m = new CommsMic(rate, sink);
      var t = new Thread(m.Run); t.IsBackground = true; t.SetApartmentState(ApartmentState.MTA); t.Start();
      bool done = m.started.WaitOne(3000);
      error = done ? m.Error : "timed out";
      if (!done || !m.ok || (requireAec && !m.EchoCancelled)) { m.running = false; if (done && m.ok && error == null) error = "no echo canceller"; return null; }
      return m;
    }
    public void Stop() { running = false; }

    void Run() {
      IAudioClient2 client = null; IntPtr fmt = IntPtr.Zero;
      try {
        var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCo();
        IMMDevice dev;
        // eCapture (1), eCommunications (2): the mic Windows uses for calls.
        int hr = en.GetDefaultAudioEndpoint(1, 2, out dev);
        if (hr != 0) throw new Exception("no mic " + hr.ToString("x"));
        object o; var iid = AudioClient2Id;
        hr = dev.Activate(ref iid, 0x17, IntPtr.Zero, out o);
        if (hr != 0) throw new Exception("activate " + hr.ToString("x"));
        client = (IAudioClient2)o;
        var props = new AudioClientProperties { Size = 16, Offload = 0, Category = 3, Options = 0 };
        hr = client.SetClientProperties(ref props);
        if (hr != 0) throw new Exception("comms category " + hr.ToString("x"));
        fmt = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(fmt, 0, 1); Marshal.WriteInt16(fmt, 2, 1); Marshal.WriteInt32(fmt, 4, Rate); Marshal.WriteInt32(fmt, 8, Rate * 2);
        Marshal.WriteInt16(fmt, 12, 2); Marshal.WriteInt16(fmt, 14, 16); Marshal.WriteInt16(fmt, 16, 0);
        // Shared, AUTOCONVERTPCM | SRC_DEFAULT_QUALITY, 100 ms buffer.
        hr = client.Initialize(0, 0x88000000, 1000000, 0, fmt, IntPtr.Zero);
        if (hr != 0) throw new Exception("initialize " + hr.ToString("x"));
        object aec; var aid = AecControlId;
        EchoCancelled = client.GetService(ref aid, out aec) == 0 && aec != null;
        object cc; var cid = CaptureClientId;
        hr = client.GetService(ref cid, out cc);
        if (hr != 0) throw new Exception("capture client " + hr.ToString("x"));
        var cap = (IAudioCaptureClient)cc;
        hr = client.Start();
        if (hr != 0) throw new Exception("start " + hr.ToString("x"));
        ok = true; started.Set();
        while (running) {
          uint frames;
          hr = cap.GetNextPacketSize(out frames);
          if (hr < 0) { Error = "read " + hr.ToString("x"); if (running && Failed != null) Failed(); break; }
          if (frames == 0) { Thread.Sleep(10); continue; }
          IntPtr data; uint flags; ulong pos, qpc;
          hr = cap.GetBuffer(out data, out frames, out flags, out pos, out qpc);
          if (hr < 0) { Error = "buffer " + hr.ToString("x"); if (running && Failed != null) Failed(); break; }
          var b = new byte[frames * 2];
          if ((flags & 2) == 0) Marshal.Copy(data, b, 0, b.Length);
          cap.ReleaseBuffer(frames);
          if (b.Length > 0) sink(b);
        }
        client.Stop();
      } catch (Exception e) { Error = e.Message; }
      finally {
        started.Set();
        if (fmt != IntPtr.Zero) Marshal.FreeHGlobal(fmt);
        try { if (client != null) Marshal.ReleaseComObject(client); } catch { }
      }
    }
  }
  public static class Voice {
    [StructLayout(LayoutKind.Sequential)] struct WaveFormat { public ushort Tag, Channels; public uint Rate, BytesPerSec; public ushort Align, Bits, Extra; }
    [StructLayout(LayoutKind.Sequential)] struct WaveHdr { public IntPtr Data; public uint Length, Recorded; public IntPtr User; public uint Flags, Loops; public IntPtr Next, Reserved; }
    [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr h, uint dev, ref WaveFormat f, IntPtr cb, IntPtr inst, uint flags);
    [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveInStart(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveInReset(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveInClose(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveOutOpen(out IntPtr h, uint dev, ref WaveFormat f, IntPtr cb, IntPtr inst, uint flags);
    [DllImport("winmm.dll")] static extern int waveOutPrepareHeader(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveOutUnprepareHeader(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveOutWrite(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveOutReset(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveOutClose(IntPtr h);
    const uint WAVE_MAPPER = 0xFFFFFFFF, DONE = 1, PREPARED = 2;
    const int IN_BUFFERS = 4, OUT_BUFFERS = 12, OUT_CAPACITY = 64 * 1024, TAIL_MS = 350;
    static readonly int HdrSize = Marshal.SizeOf(typeof(WaveHdr));
    static readonly int FlagsAt = (int)Marshal.OffsetOf(typeof(WaveHdr), "Flags");
    static readonly int LengthAt = (int)Marshal.OffsetOf(typeof(WaveHdr), "Length");
    static readonly int RecordedAt = (int)Marshal.OffsetOf(typeof(WaveHdr), "Recorded");
    static readonly object Gate = new object();
    static readonly ConcurrentQueue<byte[]> playQueue = new ConcurrentQueue<byte[]>();
    static readonly AutoResetEvent playSignal = new AutoResetEvent(false);
    static IntPtr hIn = IntPtr.Zero, hOut = IntPtr.Zero;
    static IntPtr[] inHdrs = new IntPtr[0], outHdrs = new IntPtr[0];
    static bool[] outUsed = new bool[0];
    static int outRate = 24000;
    static volatile bool live;
    static long playingUntil;
    static Aec aec;
    static CommsMic comms;
    static int inRate = 16000;
    /** Mic audio from the echo canceller, gathered into ~100 ms pieces at the rate the server wants. */
    static readonly MemoryStream pendingMic = new MemoryStream();
    /** Bot audio waiting to be played (bytes) and when the first piece of a new reply arrived: start a reply only with ~150 ms in hand (or
        after 300 ms), so a slow network does not chop the first words. */
    static long queuedBytes, firstQueuedAt;
    const int PREBUFFER_MS = 150, PREBUFFER_WAIT_MS = 300, MIC_STALL_MS = 2000, MIC_REOPENS = 3;
    static volatile int session, flushes;

    static WaveFormat Format(int rate) {
      return new WaveFormat { Tag = 1, Channels = 1, Rate = (uint)rate, BytesPerSec = (uint)(rate * 2), Align = 2, Bits = 16, Extra = 0 };
    }
    static IntPtr NewHdr(int capacity) {
      IntPtr data = Marshal.AllocHGlobal(capacity), hdr = Marshal.AllocHGlobal(HdrSize);
      Marshal.StructureToPtr(new WaveHdr { Data = data, Length = (uint)capacity }, hdr, false);
      return hdr;
    }
    static void FreeHdr(IntPtr hdr) {
      if (hdr == IntPtr.Zero) return;
      Marshal.FreeHGlobal(Marshal.ReadIntPtr(hdr)); Marshal.FreeHGlobal(hdr);
    }
    static uint Flags(IntPtr hdr) { return (uint)Marshal.ReadInt32(hdr, FlagsAt); }
    static long Now() { return Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency; }
    public static bool Live { get { return live; } }
    /** The mic goes through the echo canceller (talking over the bot works). */
    public static bool EchoCancelled { get { return live && (aec != null || comms != null); } }
    /** Loudness 0..1 of the mic (last ~100 ms) and of what the speaker plays now: the ask box's level bars. */
    static double micLevel, outLevel;
    static long outLevelAt;
    public static double MicLevel { get { return live ? micLevel : 0; } }
    public static double OutLevel { get { return Playing && Now() - Interlocked.Read(ref outLevelAt) < 400 ? outLevel : 0; } }
    static double Loudness(byte[] pcm, int offset, int count) {
      int n = count / 2; if (n == 0) return 0;
      double sum = 0;
      for (int i = 0; i < n; i++) { double v = BitConverter.ToInt16(pcm, offset + i * 2) / 32768.0; sum += v * v; }
      return Math.Min(1, Math.Sqrt(sum / n) * 6);
    }
    /** Why the echo canceller could not start (debug log). */
    public static string AecError;
    /** The echo canceller already failed in this window: do not make the user wait for it again. */
    static bool aecBroken;
    /** Bot's voice is (still) coming out of the speaker. */
    public static bool Playing { get { return live && Now() < Interlocked.Read(ref playingUntil); } }

    /**
     * Open the default mic + speaker and start streaming. echoCancel: try Windows' echo canceller first (falls back to plain capture).
     * false = no usable mic (nothing left open).
     */
    public static bool Begin(int rate, int outputRate, bool echoCancel) {
      End();
      if (rate < 8000 || rate > 48000) rate = 16000;
      if (outputRate < 8000 || outputRate > 48000) outputRate = 24000;
      // Echo-free mic, best first: Windows 11 voice processing on a "Communications" stream (quick, any rate), then the older Voice
      // Capture DSP (8 / 11.025 / 16 / 22.05 kHz: the server's rate when it is one of those, else 16 kHz resampled), else plain capture.
      Aec started = null; CommsMic commsStarted = null; AecError = null;
      int me = session + 1;
      if (echoCancel) {
        string err;
        commsStarted = CommsMic.Start(rate, (pcm) => OnAecAudio(me, pcm, rate), true, out err);
        if (commsStarted == null) AecError = "comms: " + err;
      }
      if (echoCancel && commsStarted == null && !aecBroken) {
        int dspRate = rate == 8000 || rate == 11025 || rate == 16000 || rate == 22050 ? rate : 16000;
        string err;
        started = Aec.Start(dspRate, (pcm) => OnAecAudio(me, pcm, dspRate), out err);
        AecError += "; dsp: " + err;
        if (started == null) aecBroken = true;
      }
      lock (Gate) {
        inRate = rate;
        if (started == null && commsStarted == null && !OpenWaveIn(rate)) return false;
        var fout = Format(outputRate); outRate = outputRate;
        if (waveOutOpen(out hOut, WAVE_MAPPER, ref fout, IntPtr.Zero, IntPtr.Zero, 0) != 0) hOut = IntPtr.Zero;
        outHdrs = new IntPtr[OUT_BUFFERS]; outUsed = new bool[OUT_BUFFERS];
        for (int i = 0; i < OUT_BUFFERS; i++) outHdrs[i] = NewHdr(OUT_CAPACITY);
        aec = started; comms = commsStarted;
        lock (pendingMic) pendingMic.SetLength(0);
        live = true; Interlocked.Exchange(ref playingUntil, 0);
        session = me;
        if (aec != null) aec.Failed = () => OnAecFailed(me);
        else if (comms != null) comms.Failed = () => OnAecFailed(me);
        else StartCapture(me);
        var play = new Thread(() => PlayLoop(me)); play.IsBackground = true; play.Start();
        return true;
      }
    }

    static bool OpenWaveIn(int rate) {
      var fin = Format(rate);
      if (waveInOpen(out hIn, WAVE_MAPPER, ref fin, IntPtr.Zero, IntPtr.Zero, 0) != 0) { hIn = IntPtr.Zero; return false; }
      int chunk = rate / 10 * 2;
      inHdrs = new IntPtr[IN_BUFFERS];
      for (int i = 0; i < IN_BUFFERS; i++) {
        inHdrs[i] = NewHdr(chunk);
        waveInPrepareHeader(hIn, inHdrs[i], HdrSize); waveInAddBuffer(hIn, inHdrs[i], HdrSize);
      }
      if (waveInStart(hIn) == 0) return true;
      CloseWaveIn();
      return false;
    }
    /** Only the mic: the speaker may still be playing. */
    static void CloseWaveIn() {
      if (hIn == IntPtr.Zero) return;
      waveInReset(hIn);
      foreach (var h in inHdrs) { waveInUnprepareHeader(hIn, h, HdrSize); FreeHdr(h); }
      waveInClose(hIn); hIn = IntPtr.Zero; inHdrs = new IntPtr[0];
    }
    static void StartCapture(int me) { var cap = new Thread(() => CaptureLoop(me)); cap.IsBackground = true; cap.Start(); }

    /** The echo canceller died mid-conversation: keep talking on plain capture (with the mic dropped while the bot talks). */
    static void OnAecFailed(int me) {
      lock (Gate) {
        if (!live || session != me || (aec == null && comms == null)) return;
        AecError = aec != null ? aec.Error : comms.Error;
        if (aec != null) aecBroken = true;
        aec = null; comms = null;
        if (OpenWaveIn(inRate)) StartCapture(me);
        else Output.Line("{\"t\":\"voice_mic_lost\"}");
      }
    }

    static void OnAecAudio(int me, byte[] pcm, int srcRate) {
      if (!live || session != me || (aec == null && comms == null)) return;
      byte[] piece = null;
      lock (pendingMic) {
        byte[] at = srcRate == inRate ? pcm : Resample(pcm, srcRate, inRate);
        pendingMic.Write(at, 0, at.Length);
        if (pendingMic.Length >= inRate / 10 * 2) { piece = pendingMic.ToArray(); pendingMic.SetLength(0); }
      }
      if (piece != null) SendMic(piece);
    }

    /** Linear resampling of PCM16 mono (the DSP's 16 kHz -> a provider that wants 24 kHz). */
    public static byte[] Resample(byte[] pcm, int from, int to) {
      int n = pcm.Length / 2; if (n == 0 || from == to) return pcm;
      int m = (int)((long)n * to / from);
      var outp = new byte[m * 2];
      for (int i = 0; i < m; i++) {
        double pos = (double)i * from / to; int j = (int)pos; double f = pos - j;
        short a = BitConverter.ToInt16(pcm, Math.Min(j, n - 1) * 2), b = BitConverter.ToInt16(pcm, Math.Min(j + 1, n - 1) * 2);
        short v = (short)Math.Round(a + (b - a) * f);
        outp[i * 2] = (byte)(v & 0xff); outp[i * 2 + 1] = (byte)((v >> 8) & 0xff);
      }
      return outp;
    }

    static void SendMic(byte[] pcm) {
      micLevel = Loudness(pcm, 0, pcm.Length);
      Output.Line("{\"t\":\"voice_audio\",\"audio\":\"" + Convert.ToBase64String(pcm) + "\"}");
    }

    public static void End() {
      lock (Gate) {
        live = false; session++;
        if (aec != null) { aec.Stop(); aec = null; }
        if (comms != null) { comms.Stop(); comms = null; }
        byte[] drop; while (playQueue.TryDequeue(out drop)) { }
        Interlocked.Exchange(ref queuedBytes, 0);
        playSignal.Set();
        CloseDevices();
        Interlocked.Exchange(ref playingUntil, 0);
      }
    }

    static void CloseDevices() {
      if (hIn != IntPtr.Zero) {
        waveInReset(hIn);
        foreach (var h in inHdrs) { waveInUnprepareHeader(hIn, h, HdrSize); FreeHdr(h); }
        waveInClose(hIn); hIn = IntPtr.Zero;
      }
      if (hOut != IntPtr.Zero) {
        waveOutReset(hOut);
        foreach (var h in outHdrs) { if ((Flags(h) & PREPARED) != 0) waveOutUnprepareHeader(hOut, h, HdrSize); FreeHdr(h); }
        waveOutClose(hOut); hOut = IntPtr.Zero;
      } else foreach (var h in outHdrs) FreeHdr(h);
      inHdrs = new IntPtr[0]; outHdrs = new IntPtr[0]; outUsed = new bool[0];
    }

    /**
     * Plain capture. A mic that stops giving audio for 2 s (unplugged, Bluetooth gone, default device switched) is reopened on the current
     * default mic; after 3 failed reopens the window is told (voice_mic_lost) and the conversation ends.
     */
    static void CaptureLoop(int me) {
      long lastAudio = Now(); int reopens = 0;
      while (live && session == me) {
        bool any = false;
        lock (Gate) {
          if (session != me || hIn == IntPtr.Zero) return;
          if (Now() - lastAudio > MIC_STALL_MS) {
            CloseWaveIn();
            if (reopens++ >= MIC_REOPENS || !OpenWaveIn(inRate)) { Output.Line("{\"t\":\"voice_mic_lost\"}"); return; }
            lastAudio = Now();
            continue;
          }
          foreach (var h in inHdrs) {
            if ((Flags(h) & DONE) == 0) continue;
            any = true;
            int n = Marshal.ReadInt32(h, RecordedAt);
            if (n > 0) { lastAudio = Now(); reopens = 0; }
            // Gated while the bot talks (no echo canceller): the bars show the mic as quiet then.
            if (n > 0 && Playing) micLevel = 0;
            // No echo canceller here: drop the mic while the bot talks, or it hears itself and interrupts itself.
            if (n > 0 && !Playing) {
              var buf = new byte[n]; Marshal.Copy(Marshal.ReadIntPtr(h), buf, 0, n);
              SendMic(buf);
            }
            waveInAddBuffer(hIn, h, HdrSize);
          }
        }
        if (!any) Thread.Sleep(15);
      }
    }

    static void PlayLoop(int me) {
      byte[] pending = null; int offset = 0, seenFlush = flushes;
      while (live && session == me) {
        if (seenFlush != flushes) { seenFlush = flushes; pending = null; }
        if (pending == null) {
          bool idle = Now() >= Interlocked.Read(ref playingUntil) - TAIL_MS;
          if (idle && !playQueue.IsEmpty && Interlocked.Read(ref queuedBytes) < (long)outRate * 2 * PREBUFFER_MS / 1000
              && Now() - Interlocked.Read(ref firstQueuedAt) < PREBUFFER_WAIT_MS) { Thread.Sleep(10); continue; }
          if (!playQueue.TryDequeue(out pending)) { playSignal.WaitOne(50); continue; }
          Interlocked.Add(ref queuedBytes, -pending.Length);
          offset = 0;
        }
        bool wrote = false;
        lock (Gate) {
          if (session != me) return;
          if (hOut == IntPtr.Zero || seenFlush != flushes) { pending = null; continue; }
          for (int i = 0; i < outHdrs.Length && pending != null; i++) {
            var h = outHdrs[i];
            if (outUsed[i] && (Flags(h) & DONE) == 0) continue;
            if ((Flags(h) & PREPARED) != 0) waveOutUnprepareHeader(hOut, h, HdrSize);
            int n = Math.Min(OUT_CAPACITY, pending.Length - offset);
            Marshal.Copy(pending, offset, Marshal.ReadIntPtr(h), n);
            outLevel = Loudness(pending, offset, Math.Min(n, outRate / 5 * 2)); Interlocked.Exchange(ref outLevelAt, Now());
            Marshal.WriteInt32(h, LengthAt, n); Marshal.WriteInt32(h, FlagsAt, 0);
            waveOutPrepareHeader(hOut, h, HdrSize); waveOutWrite(hOut, h, HdrSize); outUsed[i] = true;
            long ms = n * 1000L / (outRate * 2);
            long until = Math.Max(Now(), Interlocked.Read(ref playingUntil) - TAIL_MS) + ms + TAIL_MS;
            Interlocked.Exchange(ref playingUntil, until);
            offset += n; wrote = true;
            if (offset >= pending.Length) pending = null;
          }
        }
        if (!wrote) Thread.Sleep(10);
      }
    }

    /** Drop what the bot has not said yet (the user talks over it / clicks to interrupt). */
    public static void Flush() {
      lock (Gate) {
        flushes++;
        byte[] drop; while (playQueue.TryDequeue(out drop)) { }
        Interlocked.Exchange(ref queuedBytes, 0);
        if (hOut != IntPtr.Zero) waveOutReset(hOut);
        Interlocked.Exchange(ref playingUntil, 0);
      }
    }

    /** stdin line for the voice (handled here, off the UI thread) -> true; anything else -> false. */
    public static bool Take(string line) {
      if (line == null || !line.StartsWith("{\"t\":\"voice_")) return false;
      if (line.StartsWith("{\"t\":\"voice_flush\"")) { Flush(); return true; }
      if (!line.StartsWith("{\"t\":\"voice_play\"")) return false;
      const string key = "\"audio\":\"";
      int a = line.IndexOf(key, StringComparison.Ordinal);
      if (a < 0 || !live) return true;
      a += key.Length;
      int b = line.IndexOf('"', a);
      if (b <= a) return true;
      try {
        var pcm = Convert.FromBase64String(line.Substring(a, b - a));
        if (playQueue.IsEmpty && Now() >= Interlocked.Read(ref playingUntil) - TAIL_MS) Interlocked.Exchange(ref firstQueuedAt, Now());
        Interlocked.Add(ref queuedBytes, pcm.Length);
        playQueue.Enqueue(pcm); playSignal.Set();
      } catch { }
      return true;
    }
  }
`;
