import { BOT_BLINKS, BOT_EYES, BOT_MOTION, BOT_MOUTHS, BOT_RIG, BOT_SPINS, SCREEN_SCROLL_LOOP } from './bot.mjs';

/**
 * Bộ chuyển động của linh vật (29/10/2026) — mã C# biên dịch trong host.ps1 (Add-Type, cùng khối với AivinMascot.Native), chạy theo
 * CompositionTarget.Rendering (đúng nhịp màn hình). Trước đây vòng lặp viết bằng PowerShell: mỗi khung hình chạy script thông dịch +
 * FindName hàng chục lần; C# giữ sẵn tham chiếu, rẻ hơn nhiều và cho phép mô phỏng lò xo theo bước nhỏ.
 *
 * - Thông số theo trạng thái: BOT_MOTION (bot.mjs) — sinh thành bảng `Motion.For` dưới đây. Giá trị hiện tại trượt dần về đích, pha nhún
 *   cộng dồn → đổi trạng thái / đổi nhịp không giật.
 * - Quán tính: đầu xoay quanh cổ bằng lò xo (hơi vượt rồi về), đầu trễ nhịp so với thân khi nhún; ăng-ten là lò xo ít hãm, bị kéo theo gia
 *   tốc xoay của đầu, cú nhảy, cú kéo cửa sổ → lắc lư tự nhiên.
 * - Mắt: chớp ngẫu nhiên (thỉnh thoảng chớp đôi), tự liếc khi rảnh, theo con trỏ khi con trỏ ở gần hoặc vừa di chuyển (ở đâu trên màn hình
 *   cũng lia theo, đúng hướng — kể cả khi agent điều khiển chuột), con trỏ đứng yên xa thì thôi; đang làm thì mắt ở trên các màn (trừ khi
 *   rê chuột lên bot);
 *   mặt dịch nhẹ cùng hướng nhìn cho cảm giác khối.
 * - Đang làm: ba màn hình 3D lật bung ra quanh bot (so le), trôi nhẹ, chữ cuộn / cột nhảy; bot chăm chú nhìn lần lượt từng màn — mắt +
 *   đầu hướng theo màn, màn đang nhìn sáng lên, ở màn chính mắt quét từng dòng như đang đọc. Offline: chữ "z" bay lên.
 * - Đổi nét mặt (SetFace): mắt khép dẹt lại, đổi kiểu mắt lúc đang khép rồi mở ra nảy nhẹ; miệng theo sau một nhịp (thu lại, đổi, bật ra) —
 *   mọi kiểu mắt / miệng đều chuyển được, kể cả mắt cong không chớp được. Màu đèn ăng-ten chuyển dần sang màu trạng thái mới.
 * - Phản ứng (Play, cửa sổ chọn theo cặp trạng thái): startle (đang làm → cần bạn: giật mình, mắt bật to), relief (xong sau khi lỗi: chùng
 *   xuống thở ra rồi nhổm lên), cheer (xong việc dài: nhảy hai lần, lấp lánh hai đợt), small (xong việc ngắn: gật thay vì nhảy), ack (đã
 *   nhận câu hỏi: gật nhẹ), yawn (ngáp trước khi ngủ gật). Attend: đang gõ trong ô hỏi → nhìn về ô hỏi.
 * - Sống trong trạng thái dài: thưa thớt (ngẫu nhiên 22–42 s, không khi đang rê chuột / kéo / ngay sau một phản ứng) — đang làm lâu thì nheo
 *   mắt tập trung hoặc gật gù; chờ lâu thì nghiêng đầu nhìn về con trỏ như hỏi, mỗi lần đậm hơn một chút (có trần).
 * - Đạo cụ theo trạng thái: "!" nảy khi chờ xác nhận, bong bóng ba chấm khi nghĩ, tia lấp lánh bung ra khi xong việc.
 * - Thùng nhận tệp (Tray, cửa sổ gọi): kéo tệp tới gần → thùng bật ra trước bụng, nắp mở, mũi tên nhún; không nhận được → nắp đóng, ✕ đỏ,
 *   lắc; thả → "nuốt" (Play gulp); tệp chờ gửi → ôm thùng nhỏ có số tệp; gửi đi → thùng nhấc lên rồi biến mất.
 * - Ngủ gật (Doze, cửa sổ gọi khi rảnh lâu): mắt nhắm, đầu gục, zzz, thỉnh thoảng giật mình ngẩng lên; thức dậy thì nhổm lên + lắc ăng-ten.
 * - Cử chỉ khi vào trạng thái (`enter`): hop (nhảy + nén / giãn), shake (lắc đầu tắt dần), nod (gật), perk (nhổm lên chú ý, lặp khi chờ).
 * - Cửa sổ ẩn → bỏ qua khung hình (không tốn CPU / GPU).
 * Giữ ASCII (PowerShell 5 đọc .ps1 không BOM theo bảng mã cũ).
 */

const n = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);
const FIELDS = ['bob', 'bobHz', 'breathe', 'lean', 'headTilt', 'headY', 'antenna', 'glow', 'glowPulse', 'glowHz', 'tint', 'tintPulse', 'tintHz', 'scan', 'scale', 'opacity'];
const motionCase = ([name, m]) => `        case "${name}": return new Motion(new double[] { ${FIELDS.map((f) => n(m[f] ?? 0)).join(', ')} }, ${m.alt ? 'true' : 'false'}, ${m.look ? `true, ${n(m.look[0])}, ${n(m.look[1])}` : 'false, 0, 0'}, "${m.enter || ''}");`;

const V = BOT_RIG.visor;
const Z = BOT_RIG.zzz;
const SCREENS = BOT_RIG.screens;
const SP = BOT_RIG.sparks;
const TR = BOT_RIG.tray;

export const RIG_CS = String.raw`
  public sealed class Motion {
    public readonly double Bob, BobHz, Breathe, Lean, HeadTilt, HeadY, Antenna, Glow, GlowPulse, GlowHz, Tint, TintPulse, TintHz, Scan, Scale, Opacity, LookX, LookY;
    public readonly bool Alt, HasLook; public readonly string Enter;
    public Motion(double[] v, bool alt, bool hasLook, double lookX, double lookY, string enter) {
      Bob = v[0]; BobHz = v[1]; Breathe = v[2]; Lean = v[3]; HeadTilt = v[4]; HeadY = v[5]; Antenna = v[6]; Glow = v[7]; GlowPulse = v[8]; GlowHz = v[9];
      Tint = v[10]; TintPulse = v[11]; TintHz = v[12]; Scan = v[13]; Scale = v[14]; Opacity = v[15];
      Alt = alt; HasLook = hasLook; LookX = lookX; LookY = lookY; Enter = enter;
    }
    public static Motion For(string s) {
      switch (s) {
${Object.entries(BOT_MOTION).map(motionCase).join('\n')}
        default: return For("idle");
      }
    }
  }

  /** One floating 3D screen (bot.mjs screens): its transforms, rest pose, where the bot looks to read it, how long it stays on it. */
  public sealed class Screen {
    public System.Windows.UIElement El; public System.Windows.Media.Media3D.AxisAngleRotation3D Tilt, Turn; public System.Windows.Media.Media3D.TranslateTransform3D Float; public TranslateTransform Scroll;
    public readonly List<ScaleTransform> Bars = new List<ScaleTransform>();
    public double RestTilt, RestTurn, LookX, LookY, Head, DwellMin, DwellMax, Lit;
    public readonly Spring Pop = new Spring(0);
  }

  /** Damped spring, integrated in small sub-steps so stiff springs stay stable on a slow frame. */
  public sealed class Spring {
    public double X, V;
    public Spring(double x) { X = x; }
    public double Step(double target, double k, double c, double dt) {
      int n = (int)Math.Ceiling(dt / 0.008); double h = dt / n;
      for (int i = 0; i < n; i++) { V += (k * (target - X) - c * V) * h; X += V * h; }
      return X;
    }
  }

  public sealed class Rig {
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }

    const double TAU = Math.PI * 2;
    const double VISOR_SCAN = ${n(V.h + 14)};
    const double SCREEN_LOOP = ${n(SCREEN_SCROLL_LOOP)};
    // Body lean pivots on the feet: past ~50 deg a bottom corner of the body (61 units off the pivot) drops below the window edge and
    // is clipped. Drags pile velocity onto the lean spring, so shaking hard used to swing it far beyond that.
    const double LEAN_MAX = 16;
    readonly System.Windows.FrameworkElement w;
    readonly System.Windows.UIElement bot, shadow, earL, earR, visorFx, face;
    readonly System.Windows.Shapes.Shape tint, halo;
    readonly ScaleTransform botScale, shadowScale, faceScale, mouthOpen, talk;
    readonly RotateTransform botLean, headRot, antRot;
    readonly TranslateTransform botMove, headMove, faceLook, eyeLook, scanY;
    readonly System.Windows.UIElement zzz, screensView, alert, think, sparks;
    readonly ScaleTransform alertScale, thinkScale;
    readonly RotateTransform alertRot;
    readonly TranslateTransform alertMove;
    readonly ScaleTransform propsScale;
    readonly RotateTransform propsLean, propsHeadRot;
    readonly TranslateTransform propsMove, propsHeadMove;
    readonly List<TranslateTransform> thinkDots = new List<TranslateTransform>();
    readonly List<System.Windows.UIElement> thinkDotEls = new List<System.Windows.UIElement>();
    readonly List<System.Windows.UIElement> sparkEls = new List<System.Windows.UIElement>();
    readonly List<TransformGroup> sparkXf = new List<TransformGroup>();
    static readonly double[] SPARK_ANGLES = { ${SP.angles.map(n).join(', ')} };
    double sparkAt = -10, nextJerk; bool dozing;
    readonly List<Screen> screens = new List<Screen>();
    int focus; double nextFocus, workAt = -10, headFocus;
    readonly List<System.Windows.Controls.TextBlock> zs = new List<System.Windows.Controls.TextBlock>();
    readonly List<ScaleTransform> blinks = new List<ScaleTransform>();
    readonly double faceBase;
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly Random rnd = new Random();
    TimeSpan lastRender = TimeSpan.MinValue; double last, now;
    Motion m = Motion.For("idle"); string state = "idle";

    public bool Hover, Pressed, Dragging;
    // Smoothed state values (ease toward the state's targets).
    double amp = 1.5, breathe, headTilt, headY, glow, glowPulse, tintV = .62, tintPulse, scan, scale = 1, opacity = 1, antRest, sleep;
    double phase, glowPhase, tintPhase, scanPhase;
    readonly Spring headA = new Spring(0), antA = new Spring(0), lean = new Spring(0), pop = new Spring(1), alertPop = new Spring(0), thinkPop = new Spring(0), press = new Spring(0), hover = new Spring(0);
    readonly Spring lookX = new Spring(0), lookY = new Spring(0), near = new Spring(0);
    int curX = int.MinValue, curY = int.MinValue; double curMovedAt = -10;
    double prevHead, prevHeadVel, headAcc;
    double nextBlink = 1.2, blinkAt = -10; bool doubleBlink;
    double nextGlance = 2, glanceX, glanceY;
    double hopAt = -10, shakeAt = -10, nodAt = -10, perkAt = -10, flashAt = -10;
    bool hopKick, landKick;
    // Play (Play()): dizzy = head circles + spiral eyes spin; giggle = quick little bounces; purr = leaning in, slow antenna wag (kept alive
    // while petting goes on).
    double dizzyAt = -10, giggleAt = -10, purrUntil = -10, purrK;
    readonly List<RotateTransform> spins = new List<RotateTransform>();
    const double DIZZY_S = 2.6, GIGGLE_S = 1.1;
    // Reactions (Play) + life in a long state: when each started; the next spontaneous gesture; how insistent the waiting "ask" has got.
    double stateAt, sighAt = -10, hop2At = -10, yawnAt = -10, squintAt = -10, askAt = -10, reactAt = -10, nextLife;
    int askLevel; double askSide = 1;
    // Attend (typing in the ask box): look at the box until this time; where the box is (eye offset units, like the cursor look).
    double attendUntil = -10, attendX, attendY;
    // Face morph (SetFace): the shown eye / mouth kind, the one waiting to swap in, squash springs (1 = full size), when the mouth starts.
    readonly Dictionary<string, System.Windows.UIElement[]> eyeEls = new Dictionary<string, System.Windows.UIElement[]>();
    readonly Dictionary<string, System.Windows.UIElement> mouthEls = new Dictionary<string, System.Windows.UIElement>();
    readonly ScaleTransform eyeMorphL, eyeMorphR, mouthMorph;
    string eyesNow, eyesNext, mouthNow, mouthNext; double mouthAt;
    readonly Spring eyeSq = new Spring(1), mouthSq = new Spring(1);
    const double MOUTH_LAG = 0.05;
    // Antenna light color: eases from the old state's color to the new one.
    readonly SolidColorBrush tintBrush = new SolidColorBrush();
    Color colorFrom, colorTo; double colorAt = -10; bool hasColor;
    const double COLOR_S = 0.45;
    // Tray (Tray()): files dragged near the bot / dropped and waiting. Mode, files waiting, when the mode / a drop / a hand-over began.
    readonly System.Windows.UIElement tray, trayArrow, trayBase, trayNo, trayDeny, trayBadge;
    readonly ScaleTransform trayScale, trayBodyScale, trayBadgeScale;
    readonly RotateTransform trayFlapL, trayFlapR, trayBodyLean;
    readonly TranslateTransform trayMove, trayArrowMove, trayBodyMove;
    readonly System.Windows.Controls.TextBlock trayCount;
    readonly Spring trayPop = new Spring(0), trayLid = new Spring(0), badgePop = new Spring(0);
    string trayMode = "off"; int trayN; double trayAt = -10, gulpAt = -10, giveAt = -10, denyK;
    const double LID_OPEN = ${n(TR.lidOpen)};

    T Get<T>(string name) where T : class {
      var o = w.FindName(name) as T;
      if (o == null) throw new InvalidOperationException("mascot rig: missing element " + name);
      return o;
    }

    /** root = the window (or any element whose name scope holds the bot, for offscreen previews driven by Tick). */
    public Rig(System.Windows.FrameworkElement root) {
      w = root;
      bot = Get<System.Windows.UIElement>("Bot"); shadow = Get<System.Windows.UIElement>("Shadow");
      earL = Get<System.Windows.UIElement>("EarGlowL"); earR = Get<System.Windows.UIElement>("EarGlowR");
      visorFx = Get<System.Windows.UIElement>("VisorFx"); face = Get<System.Windows.UIElement>("Face");
      tint = Get<System.Windows.Shapes.Shape>("AntennaTint"); halo = Get<System.Windows.Shapes.Shape>("AntennaHalo");
      botScale = Get<ScaleTransform>("BotScale"); shadowScale = Get<ScaleTransform>("ShadowScale"); faceScale = Get<ScaleTransform>("FaceScale");
      mouthOpen = Get<ScaleTransform>("MouthOpenScale"); talk = Get<ScaleTransform>("MouthTalkScale");
      botLean = Get<RotateTransform>("BotLean"); headRot = Get<RotateTransform>("HeadRot"); antRot = Get<RotateTransform>("AntennaRot");
      botMove = Get<TranslateTransform>("BotMove"); headMove = Get<TranslateTransform>("HeadMove"); faceLook = Get<TranslateTransform>("FaceLook");
      eyeLook = Get<TranslateTransform>("EyeLook"); scanY = Get<TranslateTransform>("ScanY");
${SCREENS.map((sc, i) => `      screens.Add(MakeScreen(${i}, ${n(sc.tilt)}, ${n(sc.turn)}, ${n(sc.look[0])}, ${n(sc.look[1])}, ${n(sc.head)}, ${n(sc.dwell[0])}, ${n(sc.dwell[1])}));`).join('\n')}
      zzz = Get<System.Windows.UIElement>("Zzz"); screensView = Get<System.Windows.UIElement>("Screens");
      alert = Get<System.Windows.UIElement>("Alert"); alertScale = Get<ScaleTransform>("AlertScale"); alertRot = Get<RotateTransform>("AlertRot"); alertMove = Get<TranslateTransform>("AlertMove");
      think = Get<System.Windows.UIElement>("Think"); thinkScale = Get<ScaleTransform>("ThinkScale");
      for (int i = 0; i < 3; i++) { var d = Get<System.Windows.UIElement>("ThinkDot" + i); var tt = new TranslateTransform(); d.RenderTransform = tt; thinkDots.Add(tt); thinkDotEls.Add(d); }
      sparks = Get<System.Windows.UIElement>("Sparks");
      propsScale = Get<ScaleTransform>("PropsScale"); propsLean = Get<RotateTransform>("PropsLean"); propsMove = Get<TranslateTransform>("PropsMove");
      propsHeadRot = Get<RotateTransform>("PropsHeadRot"); propsHeadMove = Get<TranslateTransform>("PropsHeadMove");
      for (int i = 0; i < SPARK_ANGLES.Length; i++) {
        var sp = Get<System.Windows.UIElement>("Spark" + i); var g = new TransformGroup();
        g.Children.Add(new ScaleTransform()); g.Children.Add(new RotateTransform()); g.Children.Add(new TranslateTransform());
        sp.RenderTransform = g; sparkEls.Add(sp); sparkXf.Add(g);
      }
      for (int i = 0; i < 3; i++) { var z = Get<System.Windows.Controls.TextBlock>("Zzz" + i); z.RenderTransform = new ScaleTransform(); zs.Add(z); }
      foreach (var name in new[] { ${BOT_BLINKS.map((b) => `"${b}"`).join(', ')} }) { var b = w.FindName(name) as ScaleTransform; if (b != null) blinks.Add(b); }
      foreach (var name in new[] { ${BOT_SPINS.map((b) => `"${b}"`).join(', ')} }) { var r = w.FindName(name) as RotateTransform; if (r != null) spins.Add(r); }
      faceBase = faceScale.ScaleX;
      foreach (var name in new[] { ${BOT_EYES.map((e) => `"${e}"`).join(', ')} }) eyeEls[name] = new[] { Get<System.Windows.UIElement>("Eyes_" + name + "_L"), Get<System.Windows.UIElement>("Eyes_" + name + "_R") };
      foreach (var name in new[] { ${BOT_MOUTHS.map((e) => `"${e}"`).join(', ')} }) mouthEls[name] = Get<System.Windows.UIElement>("Mouth_" + name);
      eyeMorphL = Get<ScaleTransform>("EyeMorphL"); eyeMorphR = Get<ScaleTransform>("EyeMorphR"); mouthMorph = Get<ScaleTransform>("MouthMorph");
      tint.Fill = tintBrush; halo.Fill = tintBrush;
      tray = Get<System.Windows.UIElement>("Tray"); trayArrow = Get<System.Windows.UIElement>("TrayArrow"); trayBase = Get<System.Windows.UIElement>("TrayBase"); trayNo = Get<System.Windows.UIElement>("TrayNo");
      trayDeny = Get<System.Windows.UIElement>("TrayDeny"); trayBadge = Get<System.Windows.UIElement>("TrayBadge");
      trayScale = Get<ScaleTransform>("TrayScale"); trayBodyScale = Get<ScaleTransform>("TrayBodyScale"); trayBadgeScale = Get<ScaleTransform>("TrayBadgeScale");
      trayFlapL = Get<RotateTransform>("TrayFlapL"); trayFlapR = Get<RotateTransform>("TrayFlapR"); trayBodyLean = Get<RotateTransform>("TrayBodyLean");
      trayMove = Get<TranslateTransform>("TrayMove"); trayArrowMove = Get<TranslateTransform>("TrayArrowMove"); trayBodyMove = Get<TranslateTransform>("TrayBodyMove");
      trayCount = Get<System.Windows.Controls.TextBlock>("TrayCount");
    }

    /**
     * The tray in the bot's arms. "open" = files dragged near the bot: held up a bit bigger, lid flaps swing open, upload arrow bounces;
     * "deny" = it cannot take them: lid shut, red cross, the box and the head shake; "hold" = dropped files wait for the next question:
     * smaller, lid shut, count badge; "off" = put away (coming from "hold": handed over - lifts up while it shrinks). count = files
     * waiting (the badge; it pops when the count goes up).
     */
    public void Tray(string mode, int count) {
      double t = Now;
      if (mode != trayMode) {
        if (mode == "open") { trayAt = t; perkAt = t; antA.V -= 120; }
        else if (mode == "deny") { trayAt = t; shakeAt = t; }
        else if (mode == "off" && trayMode == "hold") giveAt = t;
        trayMode = mode;
      }
      if (count > trayN) badgePop.V += 9;
      trayN = Math.Max(0, count); trayCount.Text = trayN > 99 ? "99+" : trayN.ToString();
    }

    /**
     * Change the face (BOT_FACES eyes + mouth kind). The first face shows at once; later ones morph (see Frame) - calling again before a
     * morph finished just retargets it, so a quick hover in / out never stacks up.
     */
    public void SetFace(string eyes, string mouth) {
      if (!eyeEls.ContainsKey(eyes) || !mouthEls.ContainsKey(mouth)) return;
      if (eyesNow == null) { eyesNow = eyes; ShowEyes(eyes); }
      else if (eyesNext != null || eyes != eyesNow) eyesNext = eyes;
      if (mouthNow == null) { mouthNow = mouth; ShowMouth(mouth); }
      else if (mouthNext != null || mouth != mouthNow) { if (mouthNext == null) mouthAt = Now + MOUTH_LAG; mouthNext = mouth; }
    }
    void ShowEyes(string name) {
      foreach (var kv in eyeEls) { var v = kv.Key == name ? Visibility.Visible : Visibility.Collapsed; foreach (var e in kv.Value) e.Visibility = v; }
    }
    void ShowMouth(string name) {
      foreach (var kv in mouthEls) kv.Value.Visibility = kv.Key == name ? Visibility.Visible : Visibility.Collapsed;
    }

    Screen MakeScreen(int i, double tilt, double turn, double lookX, double lookY, double head, double dwellMin, double dwellMax) {
      var sc = new Screen { El = Get<System.Windows.UIElement>("Scr" + i), Tilt = Get<System.Windows.Media.Media3D.AxisAngleRotation3D>("Scr" + i + "Tilt"), Turn = Get<System.Windows.Media.Media3D.AxisAngleRotation3D>("Scr" + i + "Turn"),
        Float = Get<System.Windows.Media.Media3D.TranslateTransform3D>("Scr" + i + "Float"), Scroll = w.FindName("Scr" + i + "Scroll") as TranslateTransform,
        RestTilt = tilt, RestTurn = turn, LookX = lookX, LookY = lookY, Head = head, DwellMin = dwellMin, DwellMax = dwellMax };
      for (int k = 0; k < 3; k++) { var b = w.FindName("Scr" + i + "Bar" + k) as ScaleTransform; if (b != null) sc.Bars.Add(b); }
      return sc;
    }

    public void Start() { CompositionTarget.Rendering += OnRender; }
    public void Stop() { CompositionTarget.Rendering -= OnRender; clock.Stop(); }
    /** Time of the current frame: gestures started by SetState line up with the frame clock (live or Tick). */
    double Now { get { return now; } }

    /** Pop in when the window first appears (overshooting scale) with a little antenna flick. */
    public void Intro() { pop.X = 0.35; pop.V = 0; antA.V = 160; nextBlink = Now + 0.9; }

    /** Doze off (the window calls this after a long idle) or wake up: wake = perk up, antenna flick, a blink. */
    public void Doze(bool on) {
      if (on == dozing) return;
      dozing = on; m = Motion.For(on ? "doze" : state);
      if (on) nextJerk = Now + 6 + rnd.NextDouble() * 5;
      else { perkAt = Now; antA.V += 150; blinkAt = Now; }
    }
    public bool Dozing { get { return dozing; } }

    public void SetState(string s, string color) {
      double t = Now;
      if (s != state) {
        state = s; m = Motion.For(s); dozing = false;
        stateAt = t; nextLife = t + 14 + rnd.NextDouble() * 10; askLevel = 0;
        if (s == "done") sparkAt = t;
        if (s == "working") { workAt = t; focus = 0; nextFocus = t + 2.4; }
        switch (m.Enter) {
          case "hop": hopAt = t; hopKick = landKick = false; flashAt = t; break;
          case "shake": shakeAt = t; break;
          case "nod": nodAt = t; break;
          case "perk": perkAt = t; flashAt = t; break;
        }
        if (rnd.NextDouble() < 0.7) blinkAt = t; // a state change usually comes with a blink
      }
      if (!string.IsNullOrEmpty(color)) {
        var c = (Color)ColorConverter.ConvertFromString(color);
        if (!hasColor) { hasColor = true; colorFrom = colorTo = c; tintBrush.Color = c; }
        else if (c != colorTo) { colorFrom = tintBrush.Color; colorTo = c; colorAt = Now; }
      }
    }

    /**
     * One-shot reactions that do not change the state: "dizzy" (shaken while dragged), "giggle" (clicked fast), "purr" (petted; call again
     * while petting continues), "wave" (welcome back: hop + perk + flash).
     */
    public void Play(string g) {
      double t = Now;
      switch (g) {
        case "dizzy": dizzyAt = t; antA.V += 220; break;
        case "giggle": giggleAt = t; antA.V -= 140; blinkAt = t; break;
        case "purr": purrUntil = t + 0.9; break;
        case "wave": hopAt = t; hopKick = landKick = false; perkAt = t + 0.6; flashAt = t; break;
        // Busy -> needs you: a start (eyes pop wide, antenna jolts, a quick rise) before the waiting look.
        case "startle": perkAt = t; flashAt = t; antA.V -= 260; eyeSq.V += 6; pop.V += 2.5; break;
        // Done after an error: no hop - sag with a slow breath out, then perk up.
        case "relief": hopAt = -10; sighAt = t; perkAt = t + 0.75; antA.V += 70; break;
        // Done after long work: a second hop + sparkle burst right after the first.
        case "cheer": hop2At = t + 0.62; break;
        // Done after a quick task: a nod instead of the hop.
        case "small": hopAt = -10; nodAt = t; break;
        case "ack": nodAt = t; antA.V -= 80; break;
        case "yawn": yawnAt = t; break;
        // Files dropped into the tray: it gulps them (squash, lid snaps shut), a nod and a little sparkle.
        case "gulp": gulpAt = t; nodAt = t + 0.12; sparkAt = t; antA.V += 110; break;
      }
      reactAt = t;
    }
    public bool Dizzy { get { return Now - dizzyAt < DIZZY_S; } }
    /** Typing in the ask box: look at it (dx, dy = box offset from the bot, DIPs) for a moment; called again on each keystroke. */
    public void Attend(double dx, double dy) {
      attendUntil = Now + 1.4; attendX = Clamp(dx / 110, -1, 1) * 2.6; attendY = Clamp(dy / 110, -1, 1) * 2.0;
    }

    /** The window was dragged by (dx, dy) DIPs: the body lags behind and the antenna swings. */
    public void Nudge(double dx, double dy) {
      dx = Math.Max(-40, Math.Min(40, dx));
      lean.V -= dx * 4.0; antA.V -= dx * 14.0 + dy * 3.0;
    }

    static double Ease(double current, double target, double rate, double dt) { return current + (target - current) * (1 - Math.Exp(-rate * dt)); }
    static double Clamp(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }
    static double Bump(double u, double len) { return (u < 0 || u > len) ? 0 : Math.Sin(Math.PI * u / len); }
    static Color Mix(Color a, Color b, double k) {
      return Color.FromArgb((byte)(a.A + (b.A - a.A) * k), (byte)(a.R + (b.R - a.R) * k), (byte)(a.G + (b.G - a.G) * k), (byte)(a.B + (b.B - a.B) * k));
    }

    void OnRender(object sender, EventArgs e) {
      var re = e as RenderingEventArgs;
      if (re != null) { if (re.RenderingTime == lastRender) return; lastRender = re.RenderingTime; }
      if (!w.IsVisible) return;
      double t = clock.Elapsed.TotalSeconds; double dt = Clamp(t - last, 0.001, 0.05); last = t; now = t;
      try { Frame(t, dt); } catch { }
    }

    /** Drive one frame with an explicit clock (offscreen previews / tests). */
    public void Tick(double t, double dt) { now = t; Frame(t, dt); }

    void Frame(double t, double dt) {
      // 1) Ease state values; phases accumulate so a frequency change never jumps.
      amp = Ease(amp, m.Bob, 4, dt); breathe = Ease(breathe, m.Breathe, 4, dt);
      headTilt = Ease(headTilt, m.HeadTilt, 5, dt); headY = Ease(headY, m.HeadY, 5, dt); antRest = Ease(antRest, m.Antenna, 3, dt);
      glow = Ease(glow, m.Glow, 5, dt); glowPulse = Ease(glowPulse, m.GlowPulse, 5, dt);
      tintV = Ease(tintV, m.Tint, 6, dt); tintPulse = Ease(tintPulse, m.TintPulse, 6, dt);
      scan = Ease(scan, m.Scan, 4, dt); scale = Ease(scale, m.Scale, 6, dt); opacity = Ease(opacity, m.Opacity, 3, dt);
      phase += TAU * m.BobHz * dt; glowPhase += TAU * Math.Max(0.1, m.GlowHz) * dt; tintPhase += TAU * Math.Max(0.1, m.TintHz) * dt; scanPhase += 0.62 * dt;

      // 2) Body: bob + breathing, plus one-shot gestures.
      double bob = Math.Sin(phase) * amp, bobVel = Math.Cos(phase) * amp * TAU * m.BobHz;
      double sq = Math.Sin(phase) * breathe; double y = bob;
      double hu = t - hopAt;
      if (hu >= 0 && hu < 0.58) {
        if (hu < 0.09) sq -= 0.075 * Math.Sin(hu / 0.09 * Math.PI / 2);
        else if (hu < 0.43) { double k = (hu - 0.09) / 0.34; y -= 5.0 * Math.Sin(k * Math.PI); sq += 0.05 * (1 - k); if (!hopKick) { hopKick = true; antA.V -= 120; } }
        else { double k = (hu - 0.43) / 0.15; sq -= 0.065 * Math.Sin(k * Math.PI); if (!landKick) { landKick = true; antA.V += 190; headA.V -= 30; } }
      }
      if (state == "waiting" && t - perkAt > 2.6) perkAt = t;
      double perk = Bump(t - perkAt, 0.42);
      y -= perk * 2.6; sq += perk * 0.03;
      if (hop2At > 0 && t >= hop2At) { hop2At = -10; hopAt = t; hopKick = landKick = false; sparkAt = t; flashAt = t; }
      // Relief: sink + squash slowly (a breath out); yawn: stretch up.
      double sigh = Bump(t - sighAt, 0.8), yawn = Bump(t - yawnAt, 1.8);
      y += sigh * 2.4; sq -= sigh * 0.035; sq += yawn * 0.035;
      // Play: dizzy / giggle fade out over their length; purr eases in and out while petting goes on.
      double dizU = t - dizzyAt, dz = (dizU >= 0 && dizU < DIZZY_S) ? 1 - dizU / DIZZY_S : 0;
      double gigU = t - giggleAt, gig = (gigU >= 0 && gigU < GIGGLE_S) ? 1 - gigU / GIGGLE_S : 0;
      purrK = Ease(purrK, t < purrUntil ? 1 : 0, 4, dt);
      y -= Math.Abs(Math.Sin(gigU * 26)) * 2.4 * gig; sq += Math.Sin(gigU * 26) * 0.02 * gig + Math.Sin(t * 2.2) * 0.012 * purrK;
      press.Step(Pressed ? 1 : 0, 420, 32, dt); hover.Step(Hover ? 1 : 0, 140, 22, dt); pop.Step(1, 170, 11, dt);
      double sy = 1 + sq - press.X * 0.07, sx = 1 - sq * 0.6 + press.X * 0.05;
      double s = pop.X * scale * (1 + hover.X * 0.035);
      botScale.ScaleX = s * sx; botScale.ScaleY = s * sy;
      botMove.Y = y; botMove.X = 0;
      lean.Step(m.Lean, 60, 10, dt);
      if (Math.Abs(lean.X) > LEAN_MAX) { lean.X = Math.Sign(lean.X) * LEAN_MAX; lean.V = -lean.V * 0.3; }
      botLean.Angle = lean.X;
      bot.Opacity = opacity;
      double up = Math.Max(0, -y);
      shadowScale.ScaleX = Clamp(s * (1 - up * 0.035), 0.6, 1.2); shadowScale.ScaleY = shadowScale.ScaleX;
      shadow.Opacity = Clamp(1 - up * 0.06, 0.4, 1) * opacity;

      // 3) Eyes: cursor when near (anywhere on screen), else the state's gaze or idle glances; saccade-fast spring.
      double cx = 0, cy = 0, nearT = 0;
      if (!Dragging && PresentationSource.FromVisual(face) != null) {
        POINT p; if (GetCursorPos(out p)) {
          var src = PresentationSource.FromVisual(w); double dpi = src != null && src.CompositionTarget != null ? src.CompositionTarget.TransformToDevice.M11 : 1;
          var fc = face.PointToScreen(new System.Windows.Point(0, 0));
          double dx = (p.X - fc.X) / dpi, dy = (p.Y - fc.Y) / dpi, d = Math.Sqrt(dx * dx + dy * dy);
          // The cursor just moved (the owner, or the agent driving the mouse): the eyes dart after it wherever it is on screen, for a
          // moment after it stops; a still cursor is only watched when near. Working: a little less (the screens still pull the eyes).
          if (p.X != curX || p.Y != curY) { curX = p.X; curY = p.Y; curMovedAt = t; }
          double moving = Clamp(1 - (t - curMovedAt - 1.5), 0, 1);
          // Working: the eyes stay on the screens (darting between them) - only the pointer on the bot itself draws them away.
          nearT = Hover ? 1 : (state == "working" ? 0 : Math.Max(Clamp((460 - d) / 160, 0, 1), moving));
          // Keep the real direction (per-axis clamping pinned every diagonal to the corner); full swing from 140 DIPs out.
          double g = Math.Min(1, d / 140) / Math.Max(d, 0.001);
          cx = dx * g * 2.6; cy = dy * g * 2.0;
        }
      }
      near.Step(nearT, 60, 15, dt);
      // Dozing: now and then a startled jerk (head snaps up, antenna flicks) before nodding off again.
      if (dozing && t >= nextJerk) { perkAt = t; antA.V -= 130; nextJerk = t + 7 + rnd.NextDouble() * 6; }
      bool asleep = state == "paused" || state == "offline" || dozing;
      double gx, gy;
      // Working: eyes on the focused screen. Main screen = reading (sweep along a line, snap back); side screens = a short steady look.
      if (state == "working") {
        if (t >= nextFocus) {
          // Next screen: one of the other two (all three get looked at, never the same one twice in a row).
          focus = (focus + 1 + rnd.Next(2)) % screens.Count; var f = screens[focus];
          nextFocus = t + f.DwellMin + rnd.NextDouble() * (f.DwellMax - f.DwellMin); if (rnd.NextDouble() < 0.4) blinkAt = t;
        }
        var fs = screens[focus];
        if (focus == 0) { double ru = (t * 0.55) % 1.0; gx = fs.LookX + (ru < 0.82 ? -2.2 + 4.4 * (ru / 0.82) : 2.2 - 4.4 * ((ru - 0.82) / 0.18)); }
        else gx = fs.LookX + Math.Sin(t * 3.1) * 0.35;
        gy = fs.LookY;
      }
      else if (m.HasLook) { gx = m.LookX + Math.Sin(t * 0.9) * 0.3; gy = m.LookY; }
      else {
        if (t >= nextGlance) {
          if (rnd.NextDouble() < 0.5) { glanceX = 0; glanceY = 0; } else { glanceX = (rnd.NextDouble() * 2 - 1) * 2.2; glanceY = (rnd.NextDouble() * 2 - 1) * 1.3; }
          nextGlance = t + 1.4 + rnd.NextDouble() * 3.4; if (rnd.NextDouble() < 0.3) blinkAt = t;
        }
        gx = glanceX; gy = glanceY;
      }
      if (asleep) { gx = 0; gy = 0; }
      double nw = asleep ? 0 : near.X;
      // Dizzy: eyes roll round and round instead of following the cursor.
      if (dz > 0) { gx = Math.Cos(dizU * 8) * 2.4 * dz; gy = Math.Sin(dizU * 8) * 1.6 * dz; nw = 0; }
      // Waiting "ask": look at the cursor wherever it is; typing in the ask box: look at the box.
      double ask = Bump(t - askAt, 1.8);
      if (!asleep) nw = Math.Max(nw, ask);
      if (t < attendUntil && !asleep && dz <= 0) { gx = attendX; gy = attendY; nw = 0; }
      lookX.Step(gx + (cx - gx) * nw, 320, 34, dt); lookY.Step(gy + (cy - gy) * nw, 320, 34, dt);
      eyeLook.X = lookX.X; eyeLook.Y = lookY.X;
      faceLook.X = lookX.X * 0.55; faceLook.Y = lookY.X * 0.45;

      // 4) Head: spring toward the state's tilt + a curious lean toward a nearby cursor; lags the body's bob; nod / shake gestures.
      double curious = asleep ? 0 : Clamp(cx / 2.6, -1, 1) * 3.0 * near.X;
      headFocus = Ease(headFocus, state == "working" ? screens[focus].Head : 0, 5, dt);
      headA.Step(headTilt + curious + headFocus + purrK * 7 + askSide * (5 + 2 * askLevel) * ask - yawn * 7, 95, 12, dt);
      double su = t - shakeAt, shake = (su >= 0 && su < 0.8) ? 7 * Math.Exp(-su * 4.2) * Math.Sin(su * 27) : 0;
      double angle = headA.X + shake + Math.Sin(dizU * 7) * 9 * dz + Math.Sin(gigU * 30) * 3 * gig;
      headRot.Angle = angle;
      double squint = Bump(t - squintAt, 0.9);
      headMove.Y = headY - bobVel * 0.13 + Bump(t - nodAt, 0.5) * 2.2 - perk * 0.8 + squint * 0.8;
      double headVel = (angle - prevHead) / dt; headAcc += ((headVel - prevHeadVel) / dt - headAcc) * 0.5; prevHead = angle; prevHeadVel = headVel;
      double faceS = faceBase * (1 + perk * 0.05 + Bump(t - flashAt, 0.35) * 0.04);
      faceScale.ScaleX = faceS; faceScale.ScaleY = faceS;
      // Props (zzz / "!" / thought bubble / sparkles) ride on the head: same head + body transforms, so they follow drags, leans and bobs.
      propsHeadRot.Angle = angle; propsHeadMove.X = headMove.X; propsHeadMove.Y = headMove.Y;
      propsScale.ScaleX = botScale.ScaleX; propsScale.ScaleY = botScale.ScaleY; propsLean.Angle = botLean.Angle;
      propsMove.X = botMove.X; propsMove.Y = botMove.Y;

      // 5) Antenna: loose spring, pushed by the head's angular acceleration and gestures (see hop / Nudge); a slow idle sway.
      antA.V -= Clamp(headAcc, -4000, 4000) * 0.55 * dt;
      antA.Step(antRest + Math.Sin(phase * 0.5 + 1.3) * 1.2 + Math.Sin(t * 3) * 8 * purrK, 150, 5.5, dt);
      antA.X = Clamp(antA.X, -28, 28); antRot.Angle = antA.X;

      // 6) Lights: ear glow (alternating while working), antenna tint pulse, flash on done / attention, visor scan.
      double flash = (t - flashAt >= 0 && t - flashAt < 1.2) ? Math.Exp(-(t - flashAt) * 3.2) * 0.8 : 0;
      double gl = glow + glowPulse * Math.Sin(glowPhase) + flash, gr = glow + glowPulse * Math.Sin(glowPhase + (m.Alt ? Math.PI : 0)) + flash;
      earL.Opacity = Clamp(gl, 0, 1); earR.Opacity = Clamp(gr, 0, 1);
      double tv = Clamp(tintV + tintPulse * Math.Sin(tintPhase), 0, 1);
      double cu = (t - colorAt) / COLOR_S;
      if (cu >= 0 && cu < 1) { double k = cu * cu * (3 - 2 * cu); tintBrush.Color = Mix(colorFrom, colorTo, k); }
      else if (hasColor && tintBrush.Color != colorTo) tintBrush.Color = colorTo;
      tint.Opacity = tv; halo.Opacity = Clamp(0.12 + (tv - 0.45) * 0.9 + flash * 0.5, 0, 0.8);
      visorFx.Opacity = scan; scanY.Y = (scanPhase % 1.0) * VISOR_SCAN;

      // 7) Screens (working): flip up from edge-on one after another with a little overshoot, drift, the focused one lights up;
      //    text scrolls / bars bounce. Collapsed when folded away (no 3D work). Zzz (offline): letters drift up and fade.
      bool working = state == "working", shown = working;
      for (int i = 0; i < screens.Count; i++) {
        var sc = screens[i];
        sc.Pop.Step(working && t - workAt > i * 0.14 ? 1 : 0, 160, 13, dt);
        double sp = sc.Pop.X;
        if (sp > 0.02) shown = true;
        sc.Lit = Ease(sc.Lit, working && i == focus ? 1 : 0, 6, dt);
        sc.El.Opacity = Clamp(sp, 0, 1) * (0.68 + 0.32 * sc.Lit);
        sc.Tilt.Angle = sc.RestTilt + (1 - sp) * (90 - sc.RestTilt);
        sc.Turn.Angle = sc.RestTurn + Math.Sin(t * 0.6 + i * 2.1) * 5;
        sc.Float.OffsetY = Math.Sin(t * 1.3 + i * 1.7) * 1.2;
        if (sc.Scroll != null) sc.Scroll.Y = -((t * (4 + 5 * sc.Lit) + i * 7) % SCREEN_LOOP);
        for (int k = 0; k < sc.Bars.Count; k++) sc.Bars[k].ScaleY = 0.3 + 0.7 * Math.Abs(Math.Sin(t * (1.3 + k * 0.5) + k * 1.9));
      }
      var sv = shown ? Visibility.Visible : Visibility.Collapsed; if (screensView.Visibility != sv) screensView.Visibility = sv;
      sleep = Ease(sleep, state == "offline" || dozing ? 1 : 0, 2.5, dt); zzz.Opacity = sleep;
      if (sleep > 0.01) {
        for (int i = 0; i < zs.Count; i++) {
          double u = (t / 2.8 + i / 3.0) % 1.0; var z = zs[i];
          System.Windows.Controls.Canvas.SetLeft(z, ${n(Z.x)} + u * ${n(Z.dx)} + Math.Sin(u * TAU) * 3);
          System.Windows.Controls.Canvas.SetTop(z, ${n(Z.y)} + u * ${n(Z.dy)});
          var zsc = (ScaleTransform)z.RenderTransform; zsc.ScaleX = zsc.ScaleY = 0.45 + u * 0.7;
          z.Opacity = u < 0.18 ? u / 0.18 : (u > 0.65 ? (1 - u) / 0.35 : 1);
        }
      }

      // 8) Props. "!" (waiting): pops in, hops + wiggles on each attention perk. Thought bubble (thinking): dots hop one after another.
      //    Sparkles (done): a one-shot burst out from the head, growing then shrinking, spinning.
      alertPop.Step(state == "waiting" ? 1 : 0, 260, 13, dt);
      double ap = Clamp(alertPop.X, 0, 1.4);
      alert.Opacity = Clamp(alertPop.X, 0, 1);
      if (ap > 0.001) {
        alertScale.ScaleX = ap; alertScale.ScaleY = ap;
        double pk = Bump(t - perkAt, 0.42);
        alertMove.Y = -pk * 7 + Math.Sin(t * 2.2) * 0.8; alertRot.Angle = Math.Sin((t - perkAt) * 22) * 12 * pk;
      }
      thinkPop.Step(state == "thinking" ? 1 : 0, 200, 15, dt);
      double tp = Clamp(thinkPop.X, 0, 1.3);
      think.Opacity = Clamp(thinkPop.X, 0, 1);
      if (tp > 0.001) {
        thinkScale.ScaleX = tp; thinkScale.ScaleY = tp;
        for (int i = 0; i < thinkDots.Count; i++) {
          double du = (t * 1.5 - i * 0.2) % 1.0, hop = Bump(du, 0.34);
          thinkDots[i].Y = -hop * 3.6; thinkDotEls[i].Opacity = 0.4 + 0.6 * hop;
        }
      }
      double su2 = t - sparkAt;
      if (su2 >= 0 && su2 < 1.1) {
        if (sparks.Visibility != Visibility.Visible) sparks.Visibility = Visibility.Visible;
        double k = su2 / 1.1, e = 1 - Math.Pow(1 - k, 3), d = ${n(SP.from)} + (${n(SP.to)} - ${n(SP.from)}) * e;
        for (int i = 0; i < sparkEls.Count; i++) {
          double a = SPARK_ANGLES[i] * Math.PI / 180, sz = Bump(su2, 1.1) * (i % 2 == 0 ? 1.7 : 1.15);
          var g = sparkXf[i];
          var sc = (ScaleTransform)g.Children[0]; sc.ScaleX = sz; sc.ScaleY = sz;
          ((RotateTransform)g.Children[1]).Angle = k * 140 * (i % 2 == 0 ? 1 : -1);
          var tr = (TranslateTransform)g.Children[2]; tr.X = ${n(SP.x)} + Math.Cos(a) * d; tr.Y = ${n(SP.y)} + Math.Sin(a) * d;
        }
      } else if (sparks.Visibility == Visibility.Visible) sparks.Visibility = Visibility.Collapsed;

      // 9) Blink (random interval, sometimes double) and small mouth life.
      if (t >= nextBlink) { blinkAt = t; doubleBlink = rnd.NextDouble() < 0.2; nextBlink = t + 2.3 + rnd.NextDouble() * 3.8; }
      double bu = t - blinkAt; if (doubleBlink && bu > 0.22) bu -= 0.22;
      double blink = 1;
      if (bu >= 0 && bu < 0.17) blink = bu < 0.06 ? 1 - 0.9 * (bu / 0.06) : (bu < 0.08 ? 0.1 : 0.1 + 0.9 * Math.Sin((bu - 0.08) / 0.09 * Math.PI / 2));
      foreach (var b in blinks) b.ScaleY = blink;
      if (dz > 0) foreach (var r in spins) r.Angle = (dizU * 540) % 360;

      // 10) Face morph: eyes squash shut fast (~80 ms, no overshoot), swap kind while shut, spring open with a small overshoot (and a
      //     touch wider while squashed); the mouth a beat later shrinks, swaps, pops back a little bouncier.
      bool eyeSwap = eyesNext != null;
      eyeSq.Step(eyeSwap ? 0 : 1, eyeSwap ? 1400 : 380, eyeSwap ? 75 : 20, dt);
      if (eyeSwap && eyeSq.X < 0.2) { eyesNow = eyesNext; eyesNext = null; ShowEyes(eyesNow); }
      double es = Clamp(eyeSq.X, 0.08, 1.25) * (1 - 0.38 * squint);
      eyeMorphL.ScaleY = es; eyeMorphR.ScaleY = es;
      eyeMorphL.ScaleX = eyeMorphR.ScaleX = 1 + (1 - Math.Min(es, 1)) * 0.15;
      bool mouthSwap = mouthNext != null && t >= mouthAt;
      mouthSq.Step(mouthSwap ? 0 : 1, mouthSwap ? 1400 : 300, mouthSwap ? 75 : 15, dt);
      if (mouthSwap && mouthSq.X < 0.3) { mouthNow = mouthNext; mouthNext = null; ShowMouth(mouthNow); }
      double ms = Clamp(mouthSq.X, 0.15, 1.3) * (1 + 0.6 * Bump(t - yawnAt - 0.15, 1.5));
      mouthMorph.ScaleX = ms; mouthMorph.ScaleY = ms;

      // 11) Life in a long state: a rare gesture of its own - never while the pointer is on the bot, dragging, dozing or right after a
      //     reaction. Working a while: a focused squint or an "I see" nod. Waiting a while: tilt the head at the cursor as if asking, a bit
      //     more each time (capped) with a perk from the second time on.
      if (t >= nextLife) {
        nextLife = t + 22 + rnd.NextDouble() * 20;
        double inState = t - stateAt;
        if (!Hover && !Dragging && !dozing && t - reactAt > 6) {
          if (state == "working" && inState > 15) { if (rnd.NextDouble() < 0.5) squintAt = t; else nodAt = t; }
          else if (state == "waiting" && inState > 12) {
            askAt = t; askSide = rnd.NextDouble() < 0.5 ? -1 : 1; askLevel = Math.Min(askLevel + 1, 3);
            if (askLevel >= 2) perkAt = t + 0.3;
          }
        }
      }
      mouthOpen.ScaleY = 1 + Math.Sin(t * 3.4) * 0.1; mouthOpen.ScaleX = 1 - Math.Sin(t * 3.4) * 0.05;
      talk.ScaleY = 0.45 + 0.55 * Math.Abs(Math.Sin(t * 12));

      // 12) Tray: pops up in front of the body (rides its bob / lean / squash), held up while files hover near; the lid flutters open, the
      //     arrow bounces; a drop gulps (squash + lid snaps shut); a refusal shakes the box; handed over = lifts up as it shrinks away.
      bool open = trayMode == "open";
      trayPop.Step(open ? 1.06 : trayMode == "deny" ? 1 : trayMode == "hold" ? 0.9 : 0, 230, 17, dt);
      double tpv = Math.Max(0, trayPop.X);
      var tvis = tpv > 0.01 ? Visibility.Visible : Visibility.Collapsed; if (tray.Visibility != tvis) tray.Visibility = tvis;
      if (tpv > 0.01) {
        trayBodyScale.ScaleX = botScale.ScaleX; trayBodyScale.ScaleY = botScale.ScaleY; trayBodyLean.Angle = botLean.Angle;
        trayBodyMove.X = botMove.X; trayBodyMove.Y = botMove.Y;
        double gulp = Bump(t - gulpAt, 0.32);
        trayScale.ScaleX = tpv * (1 + gulp * 0.14); trayScale.ScaleY = tpv * (1 - gulp * 0.2);
        double du = t - trayAt, jolt = trayMode == "deny" && du < 0.7 ? Math.Exp(-du * 5) * Math.Sin(du * 42) * 6 : 0;
        double give = trayMode == "off" ? Clamp((t - giveAt) / 0.4, 0, 1) : 0;
        trayMove.X = jolt; trayMove.Y = (open ? -3 + Math.Sin(t * 4.2) * 1.6 : 0) - give * 34;
        tray.Opacity = Clamp(tpv, 0, 1);
        trayLid.Step(open ? 1 : 0, open ? 140 : 520, open ? 9 : 34, dt);
        double lid = trayLid.X * LID_OPEN + (open ? Math.Sin(t * 9) * 7 * trayLid.X : 0);
        trayFlapL.Angle = -lid; trayFlapR.Angle = lid;
        denyK = Ease(denyK, trayMode == "deny" ? 1 : 0, 12, dt);
        trayDeny.Opacity = denyK * 0.16; trayNo.Opacity = denyK; trayArrow.Opacity = trayBase.Opacity = 1 - denyK;
        trayArrowMove.Y = open ? -Math.Abs(Math.Sin(t * 5.5)) * 8 : 0;
        badgePop.Step(trayN > 0 ? 1 : 0, 320, 13, dt);
        double bp = Clamp(badgePop.X, 0, 1.5);
        trayBadge.Opacity = Clamp(bp, 0, 1); trayBadgeScale.ScaleX = bp; trayBadgeScale.ScaleY = bp;
      }
    }
  }
`;

/** Tham chiếu biên dịch cho khối C# (WPF) — PowerShell 5 cần đường dẫn đầy đủ của assembly. */
export const RIG_REFERENCES_PS = '([Windows.UIElement].Assembly.Location), ([Windows.Window].Assembly.Location), ([Windows.DependencyObject].Assembly.Location), ([System.Xaml.XamlSchemaContext].Assembly.Location)';
