/**
 * Linh vật động trên ảnh 3D AIVIN (bản 29/10/2026): ảnh tách 3 lớp (assets.mjs) dựng thành bộ khung — thân đứng yên, ĐẦU xoay quanh cổ,
 * ĂNG-TEN xoay quanh chân trên đỉnh mũ (lò xo, lắc theo quán tính) — mặt là lớp vector phát sáng vẽ đè lên kính: chớp mắt ngẫu nhiên, liếc
 * theo con trỏ, nét mặt theo trạng thái. Đèn hai tai + vạch quét trong kính báo "đang làm"; quả cầu ăng-ten = chấm màu trạng thái.
 *
 * Chuyển động mỗi khung hình chạy bằng C# trong host.ps1 (rigSource.mjs), đọc thông số BOT_MOTION ở đây.
 * Khung 192×192 (đơn vị bot). Tên phần tử (x:Name) là hợp đồng với rigSource.mjs / hostSource.mjs — đổi tên phải sửa cả ba.
 */

export const BOT_FRAME = 192;

/** Mỏ neo trên khung 192 (đo từ ảnh gốc, xem assets.mjs). Đổi ảnh → đo lại. */
export const BOT_RIG = Object.freeze({
  ground: { x: 96, y: 188 },
  neck: { x: 95.4, y: 138.4 },
  antennaBase: { x: 95.4, y: 35 },
  ball: { x: 95.5, y: 18.7, r: 10.7 },
  visor: { x: 97.2, y: 88.9, w: 118, h: 73.4, r: 30 },
  earL: { x: 22, y: 94.9, w: 13, h: 36 },
  earR: { x: 170.6, y: 97.3, w: 12, h: 33 },
  /** Mặt vẽ theo đơn vị gốc rồi phóng FACE_SCALE, tâm đặt hơi dưới tâm kính. */
  face: { x: 97.2, y: 90.5, scale: 1.6, eyeDx: 15, eyeY: -3.5, mouthY: 10.5 },
  /**
   * Màn hình 3D khi đang làm (Viewport3D thật, phối cảnh): tấm chính trước ngực + hai tấm nhỏ hai bên quây quanh bot. Bot chăm chú nhìn
   * lần lượt từng màn (mắt + đầu hướng theo `look` / `head`, màn đang nhìn sáng lên), ở mỗi màn `dwell` giây (ngẫu nhiên trong khoảng).
   * Các màn QUAY MẶT VỀ BOT (người xem thấy mặt sau, nội dung lật gương): màn chính ngửa lên về phía mặt bot, hai màn bên quây cong
   * ôm quanh bot (mép ngoài lùi xa). x / y: tâm màn nhìn thấy trên khung 192; z: nhô ra trước bot (về phía người xem).
   * tilt: quay quanh trục ngang (dương = mép trên nhô về người xem); turn: quay quanh trục đứng (dương = mép phải lùi xa). kind: text | bars.
   */
  screens: [
    { x: 96, y: 153, z: 40, w: 132, h: 58, tilt: 34, turn: 0, look: [0, 3.2], head: 0, kind: 'text', dwell: [1.6, 2.6] },
    { x: 4, y: 112, z: 22, w: 64, h: 48, tilt: 12, turn: -34, look: [-2.8, 1.8], head: -6, kind: 'bars', dwell: [0.9, 1.6] },
    { x: 188, y: 112, z: 22, w: 64, h: 48, tilt: 12, turn: 34, look: [2.8, 1.8], head: 6, kind: 'text', dwell: [0.9, 1.6] },
  ],
  /** Chữ "z" khi ngủ (offline): bay từ (x, y) lên chéo phải (dx, dy), to dần rồi mờ. */
  zzz: { x: 140, y: 30, dx: 40, dy: -52, size: 46 },
  /** Huy hiệu "!" khi chờ xác nhận (góc trên trái đầu, nảy theo nhịp chú ý). */
  alert: { x: 40, y: 22, r: 26 },
  /** Bong bóng suy nghĩ ba chấm khi đang nghĩ (góc trên phải đầu, hai chấm tròn nhỏ dẫn về đầu). `dot` = cỡ chấm, `gap` = khoảng tâm. */
  think: { x: 164, y: 12, w: 86, h: 38, dot: 11, gap: 20 },
  /** Tia lấp lánh khi xong việc: bung từ (x, y) ra từ bán kính `from` tới `to` theo các góc (độ, 0 = sang phải, âm = lên trên). */
  sparks: { x: 96, y: 74, from: 30, to: 86, angles: [-165, -125, -85, -45, -10, 195] },
});

/** Nét mặt theo trạng thái. */
export const BOT_FACES = Object.freeze({
  idle: { eyes: 'open', mouth: 'smile' },
  working: { eyes: 'focus', mouth: 'smile' },
  thinking: { eyes: 'up', mouth: 'hmm' },
  waiting: { eyes: 'wide', mouth: 'open' },
  paused: { eyes: 'closed', mouth: 'flat' },
  offline: { eyes: 'closed', mouth: 'flat' },
  done: { eyes: 'happy', mouth: 'grin' },
  error: { eyes: 'sad', mouth: 'wobble' },
  hello: { eyes: 'happy', mouth: 'grin' },
  // Nói chuyện với chủ máy (askHostSource.mjs): đang nghe / đang nói (miệng `talk` nhép theo nhịp).
  listening: { eyes: 'wide', mouth: 'smile' },
  speaking: { eyes: 'happy', mouth: 'talk' },
  // Chơi với bot (hostSource.mjs): bị lắc mạnh khi kéo → chóng mặt (mắt xoắn ốc quay); được vuốt (rê chuột qua lại) → lim dim sung sướng.
  dizzy: { eyes: 'dizzy', mouth: 'wobble' },
  purr: { eyes: 'happy', mouth: 'smile' },
  // Phản ứng (hostSource.mjs): xong sau khi lỗi → nhắm mắt thở phào; rảnh lâu sắp ngủ gật → ngáp.
  relief: { eyes: 'closed', mouth: 'smile' },
  yawn: { eyes: 'closed', mouth: 'open' },
});

export const BOT_EYES = Object.freeze(['open', 'focus', 'up', 'wide', 'happy', 'closed', 'sad', 'dizzy']);
export const BOT_MOUTHS = Object.freeze(['smile', 'flat', 'hmm', 'open', 'grin', 'wobble', 'talk']);

/**
 * Thông số chuyển động theo trạng thái (đơn vị bot / độ / Hz). Giá trị hiện tại luôn trượt dần về đích nên đổi trạng thái không giật.
 * - bob / bobHz: nhún lên xuống; breathe: co giãn thở (tỉ lệ); lean: nghiêng cả thân; headTilt / headY: tư thế đầu; antenna: góc nghỉ ăng-ten.
 * - glow / glowPulse / glowHz: đèn tai (nền + nhịp; `alt` = hai tai so le như đang xử lý); tint / tintPulse / tintHz: quả cầu ăng-ten.
 * - scan: vạch quét trong kính; look: hướng mắt cố định khi không theo con trỏ (null = tự liếc); scale: phóng cả bot; opacity: mờ khi nghỉ.
 * - doze: không phải trạng thái daemon gửi — cửa sổ tự cho bot ngủ gật khi rảnh lâu (rig.Doze), thức dậy khi có việc / rê chuột.
 * - enter: cử chỉ một lần khi vào trạng thái — hop (nhảy), shake (lắc đầu), nod (gật), perk (ngẩng lên chú ý).
 */
export const BOT_MOTION = Object.freeze({
  idle: { bob: 1.5, bobHz: 0.36, breathe: 0.008, lean: 0, headTilt: 0, headY: 0, antenna: 0, glow: 0.12, glowPulse: 0.1, glowHz: 0.36, tint: 0.62, tintPulse: 0, tintHz: 0, scan: 0, scale: 1, opacity: 1 },
  working: { bob: 0.7, bobHz: 0.8, breathe: 0.004, lean: 1.2, headTilt: 1.5, headY: 1.6, antenna: 0, glow: 0.42, glowPulse: 0.38, glowHz: 1.6, alt: true, tint: 0.7, tintPulse: 0.25, tintHz: 1.3, scan: 0.55, scale: 1, opacity: 1, enter: 'nod' },
  thinking: { bob: 1.1, bobHz: 0.42, breathe: 0.006, lean: -1, headTilt: 7, headY: 0, antenna: -4, glow: 0.3, glowPulse: 0.25, glowHz: 0.7, tint: 0.66, tintPulse: 0.22, tintHz: 0.7, scan: 0.18, look: [1.8, -1.7], scale: 1, opacity: 1 },
  waiting: { bob: 0.6, bobHz: 0.5, breathe: 0.004, lean: -2, headTilt: -4, headY: -0.6, antenna: 0, glow: 0.5, glowPulse: 0.3, glowHz: 1, tint: 0.72, tintPulse: 0.26, tintHz: 1.6, scan: 0, look: [0, 0.6], scale: 1.03, opacity: 1, enter: 'perk' },
  done: { bob: 1.3, bobHz: 0.55, breathe: 0.012, lean: -1.5, headTilt: -5, headY: 0, antenna: 0, glow: 0.3, glowPulse: 0.2, glowHz: 0.55, tint: 0.7, tintPulse: 0, tintHz: 0, scan: 0, scale: 1.02, opacity: 1, enter: 'hop' },
  error: { bob: 0.4, bobHz: 0.3, breathe: 0.004, lean: 1.5, headTilt: 4, headY: 1.4, antenna: 6, glow: 0, glowPulse: 0, glowHz: 0, tint: 0.74, tintPulse: 0, tintHz: 0, scan: 0, look: [0, 1.4], scale: 1, opacity: 1, enter: 'shake' },
  paused: { bob: 0.6, bobHz: 0.22, breathe: 0.014, lean: 0, headTilt: 6, headY: 2.2, antenna: 12, glow: 0, glowPulse: 0, glowHz: 0, tint: 0.5, tintPulse: 0, tintHz: 0, scan: 0, scale: 1, opacity: 0.72 },
  doze: { bob: 0.9, bobHz: 0.2, breathe: 0.016, lean: 0, headTilt: 8, headY: 3, antenna: 14, glow: 0, glowPulse: 0, glowHz: 0, tint: 0.5, tintPulse: 0, tintHz: 0, scan: 0, scale: 1, opacity: 1 },
  offline: { bob: 0.4, bobHz: 0.18, breathe: 0.01, lean: 0, headTilt: 7, headY: 2.8, antenna: 16, glow: 0, glowPulse: 0, glowHz: 0, tint: 0.45, tintPulse: 0, tintHz: 0, scan: 0, scale: 1, opacity: 0.55 },
});

const GLOW = '#73E4F9';
const glowStroke = (w = 4.2) => `Stroke="${GLOW}" StrokeThickness="${w}" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"`;

/** Mắt viên thuốc + đốm sáng, vẽ quanh (0,0); `blink` gắn ScaleTransform để chớp. */
const pill = (w, h, blink) => `<Rectangle Canvas.Left="${-w / 2}" Canvas.Top="${-h / 2}" Width="${w}" Height="${h}" RadiusX="${w / 2}" RadiusY="${w / 2}" Fill="${GLOW}" RenderTransformOrigin="0.5,0.5">${blink ? `<Rectangle.RenderTransform><ScaleTransform x:Name="${blink}"/></Rectangle.RenderTransform>` : ''}</Rectangle>
  <Ellipse Canvas.Left="${-w / 2 + 1.6}" Canvas.Top="${-h / 2 + 2}" Width="${w * 0.36}" Height="${w * 0.4}" Fill="White" Opacity="0.85" IsHitTestVisible="False"/>`;

/** Mắt xoắn ốc (chóng mặt): các nửa vòng tròn nối nhau to dần quanh (0,0); rig quay `spin` (BOT_SPINS). */
const spiral = (spin) => `<Path Data="M0,0 A1.6,1.6 0 0 1 3.2,0 A3.2,3.2 0 0 1 -3.2,0 A4.8,4.8 0 0 1 6.4,0 A6.4,6.4 0 0 1 -6.4,0" ${glowStroke(2.4)} Fill="{x:Null}"><Path.RenderTransform><RotateTransform x:Name="${spin}"/></Path.RenderTransform></Path>`;
/** Tên các RotateTransform của mắt xoắn ốc (rigSource.mjs quay khi chóng mặt). */
export const BOT_SPINS = Object.freeze(['SpinL', 'SpinR']);

/** Kiểu mắt: [trái, phải?] — thiếu phải thì dùng như trái. Mắt viên thuốc nào có tên Blink* thì chớp được. */
const EYE_SHAPES = {
  open: [pill(10, 14, 'BlinkL'), pill(10, 14, 'BlinkR')],
  focus: [pill(10, 8, 'BlinkFL'), pill(10, 8, 'BlinkFR')],
  up: [`<Canvas Canvas.Left="2" Canvas.Top="-3.5">${pill(9, 12)}</Canvas>`],
  wide: [pill(12.5, 16, 'BlinkWL'), pill(12.5, 16, 'BlinkWR')],
  happy: [`<Path Data="M-8,3 Q0,-8 8,3" ${glowStroke()} Fill="{x:Null}"/>`],
  closed: [`<Path Data="M-7,0 Q0,5 7,0" ${glowStroke()} Fill="{x:Null}"/>`],
  sad: [`<Path Data="M-7,3 Q-1,-5 7,-1" ${glowStroke()} Fill="{x:Null}"/>`, `<Path Data="M-7,-1 Q1,-5 7,3" ${glowStroke()} Fill="{x:Null}"/>`],
  dizzy: [spiral('SpinL'), spiral('SpinR')],
};
/** Tên các ScaleTransform chớp mắt (rigSource.mjs đặt ScaleY). */
export const BOT_BLINKS = Object.freeze(['BlinkL', 'BlinkR', 'BlinkFL', 'BlinkFR', 'BlinkWL', 'BlinkWR']);

const eyeSide = (side) => BOT_EYES.map((n) => {
  const [left, right] = EYE_SHAPES[n];
  return `<Canvas x:Name="Eyes_${n}_${side}" Visibility="Collapsed">${side === 'R' && right ? right : left}</Canvas>`;
}).join('\n      ');

const MOUTH_SHAPES = {
  smile: `<Path Data="M-6.5,-1.5 C-4.5,3.2 4.5,3.2 6.5,-1.5" ${glowStroke(4.4)} Fill="{x:Null}"/>`,
  flat: `<Path Data="M-4.5,0.5 C-1.5,1.6 1.5,1.6 4.5,0.5" ${glowStroke(4)} Fill="{x:Null}"/>`,
  hmm: `<Path Data="M-4,1.2 C-1,-0.6 2.5,-0.4 5.5,0.8" ${glowStroke(4)} Fill="{x:Null}"/>`,
  open: `<Ellipse Canvas.Left="-4" Canvas.Top="-3.4" Width="8" Height="7.4" Fill="${GLOW}" RenderTransformOrigin="0.5,0.5"><Ellipse.RenderTransform><ScaleTransform x:Name="MouthOpenScale"/></Ellipse.RenderTransform></Ellipse>`,
  grin: `<Path Data="M-8,-2.5 C-4,-3.6 4,-3.6 8,-2.5 C7.4,4.6 3.8,7.6 0,7.6 C-3.8,7.6 -7.4,4.6 -8,-2.5 Z" Fill="${GLOW}" Stroke="${GLOW}" StrokeThickness="2.2" StrokeLineJoin="Round"/>`,
  wobble: `<Path Data="M-6.5,2 C-4.5,-0.8 -2,-0.8 0,1.4 C2,3.6 4.5,3.6 6.5,0.8" ${glowStroke(3.6)} Fill="{x:Null}"/>`,
  talk: `<Ellipse Canvas.Left="-5" Canvas.Top="-4" Width="10" Height="8" Fill="${GLOW}" RenderTransformOrigin="0.5,0.5"><Ellipse.RenderTransform><ScaleTransform x:Name="MouthTalkScale"/></Ellipse.RenderTransform></Ellipse>`,
};

const R = BOT_RIG;
const V = R.visor;
const F = R.face;
const S = BOT_FRAME;
const img = (name) => `<Image x:Name="${name}" Width="${S}" Height="${S}" RenderOptions.BitmapScalingMode="HighQuality" IsHitTestVisible="False"/>`;

/** Đèn tai: quầng mờ phủ lên đĩa xanh của ảnh, độ sáng do rig điều khiển. */
const ear = (name, e) => `<Ellipse x:Name="${name}" Canvas.Left="${e.x - e.w / 2}" Canvas.Top="${e.y - e.h / 2}" Width="${e.w}" Height="${e.h}" Opacity="0" IsHitTestVisible="False">
    <Ellipse.Fill><RadialGradientBrush><GradientStop Color="#F2FDFF" Offset="0"/><GradientStop Color="#B38CEBFF" Offset="0.45"/><GradientStop Color="#0038C8FF" Offset="1"/></RadialGradientBrush></Ellipse.Fill>
    <Ellipse.Effect><BlurEffect Radius="3"/></Ellipse.Effect>
   </Ellipse>`;

/** Vạch quét trong kính (đang làm): dải sáng mảnh trượt từ trên xuống, cắt theo hình kính. */
const VISOR_FX = `<Canvas x:Name="VisorFx" Opacity="0" IsHitTestVisible="False">
    <Canvas.Clip><RectangleGeometry Rect="${V.x - V.w / 2 + 3},${V.y - V.h / 2 + 3},${V.w - 6},${V.h - 6}" RadiusX="${V.r}" RadiusY="${V.r}"/></Canvas.Clip>
    <Rectangle Canvas.Left="${V.x - V.w / 2}" Canvas.Top="${V.y - V.h / 2 - 14}" Width="${V.w}" Height="14">
     <Rectangle.Fill><LinearGradientBrush StartPoint="0,0" EndPoint="0,1"><GradientStop Color="#0073E4F9" Offset="0"/><GradientStop Color="#5573E4F9" Offset="0.82"/><GradientStop Color="#CCB8F4FF" Offset="0.94"/><GradientStop Color="#0073E4F9" Offset="1"/></LinearGradientBrush></Rectangle.Fill>
     <Rectangle.RenderTransform><TranslateTransform x:Name="ScanY"/></Rectangle.RenderTransform>
    </Rectangle>
   </Canvas>`;

/** Quả cầu ăng-ten: ảnh kim loại + lớp màu trạng thái trong suốt + đốm bóng giữ khối 3D + quầng sáng. */
const B = R.ball;
const ANTENNA_XAML = `<Canvas x:Name="Antenna" IsHitTestVisible="False">
    <Canvas.RenderTransform><RotateTransform x:Name="AntennaRot" CenterX="${R.antennaBase.x}" CenterY="${R.antennaBase.y}"/></Canvas.RenderTransform>
    <Ellipse x:Name="AntennaHalo" Canvas.Left="${B.x - B.r * 1.9}" Canvas.Top="${B.y - B.r * 1.9}" Width="${B.r * 3.8}" Height="${B.r * 3.8}" Opacity="0.35">
     <Ellipse.Effect><BlurEffect Radius="7"/></Ellipse.Effect>
    </Ellipse>
    ${img('AntennaImg')}
    <Ellipse x:Name="AntennaTint" Canvas.Left="${B.x - B.r}" Canvas.Top="${B.y - B.r}" Width="${B.r * 2}" Height="${B.r * 2}" Opacity="0.62"/>
    <Ellipse Canvas.Left="${B.x - B.r}" Canvas.Top="${B.y - B.r}" Width="${B.r * 2}" Height="${B.r * 2}">
     <Ellipse.Fill><RadialGradientBrush GradientOrigin="0.34,0.28" Center="0.4,0.36" RadiusX="0.7" RadiusY="0.7"><GradientStop Color="#E6FFFFFF" Offset="0"/><GradientStop Color="#33FFFFFF" Offset="0.32"/><GradientStop Color="#00FFFFFF" Offset="0.62"/><GradientStop Color="#40000820" Offset="1"/></RadialGradientBrush></Ellipse.Fill>
    </Ellipse>
   </Canvas>`;

/**
 * Màn hình 3D (đang làm): MỘT Viewport3D phủ cả sân khấu, camera đặt ở chỗ người xem → các màn chung một phối cảnh. Mỗi màn là tấm kính
 * xanh phát sáng (Viewport2DVisual3D, nội dung WPF thường, lật gương vì ta nhìn từ mặt sau); rig xoay `Scr{i}Tilt` / `Scr{i}Turn` (bung ra:
 * lật từ nằm ngang lên), dời `Scr{i}Float`, chỉnh độ mờ `Scr{i}`, cuộn `Scr{i}Scroll`, nhún `Scr{i}Bar{k}`.
 */
const SCREEN_FOV = 64;
const SCREEN_VIEW = { left: -40, top: -40, size: 272 };
const SCREEN_CAM = (SCREEN_VIEW.size / 2) / Math.tan((SCREEN_FOV / 2) * Math.PI / 180);
const SCREEN_LINE = { step: 6, h: 2.6, widths: [0.84, 0.56, 0.72, 0.4] };
const screenFace = (sc, i) => {
  const pad = 6, iw = sc.w - pad * 2, ih = sc.h - pad * 2;
  const body = sc.kind === 'bars'
    ? [0, 1, 2].map((k) => {
      const bw = iw / 4.2, left = pad + k * (bw * 1.6);
      return `<Rectangle Canvas.Left="${left.toFixed(1)}" Canvas.Top="${pad}" Width="${bw.toFixed(1)}" Height="${ih}" RadiusX="1.5" RadiusY="1.5" Fill="#F2FFFFFF" RenderTransformOrigin="0.5,1"><Rectangle.RenderTransform><ScaleTransform x:Name="Scr${i}Bar${k}"/></Rectangle.RenderTransform></Rectangle>`;
    }).join('')
    : `<Canvas><Canvas.RenderTransform><TranslateTransform x:Name="Scr${i}Scroll"/></Canvas.RenderTransform>${Array.from({ length: Math.ceil(ih / SCREEN_LINE.step) + SCREEN_LINE.widths.length + 1 }, (_, k) =>
      `<Rectangle Canvas.Left="${pad}" Canvas.Top="${pad + k * SCREEN_LINE.step}" Width="${(iw * SCREEN_LINE.widths[k % SCREEN_LINE.widths.length]).toFixed(1)}" Height="${SCREEN_LINE.h}" RadiusX="1.3" RadiusY="1.3" Fill="#F2FFFFFF"/>`).join('')}</Canvas>`;
  return `<Grid x:Name="Scr${i}" Width="${sc.w}" Height="${sc.h}" Opacity="0">
       <Border CornerRadius="5" BorderThickness="1.4" BorderBrush="#F0E0FAFF">
        <Border.Background><LinearGradientBrush StartPoint="0,0" EndPoint="0,1"><GradientStop Color="#9938BDF8" Offset="0"/><GradientStop Color="#800EA5E9" Offset="1"/></LinearGradientBrush></Border.Background>
       </Border>
       <Canvas><Canvas.Clip><RectangleGeometry Rect="${pad - 1},${pad - 1},${iw + 2},${ih + 2}"/></Canvas.Clip>${body}</Canvas>
      </Grid>`;
};
/** Đặt màn: (x, y) là chỗ tâm màn hiện ra trên khung 192 → lùi về toạ độ 3D theo độ sâu z để chiếu đúng vào đó. */
const screenXaml = (sc, i) => {
  const a = sc.w / 2, b = sc.h / 2, k = (SCREEN_CAM - sc.z) / SCREEN_CAM, c = SCREEN_VIEW.left + SCREEN_VIEW.size / 2;
  return `<Viewport2DVisual3D>
     <Viewport2DVisual3D.Transform><Transform3DGroup>
      <RotateTransform3D><RotateTransform3D.Rotation><AxisAngleRotation3D x:Name="Scr${i}Tilt" Axis="1,0,0" Angle="${sc.tilt}"/></RotateTransform3D.Rotation></RotateTransform3D>
      <RotateTransform3D><RotateTransform3D.Rotation><AxisAngleRotation3D x:Name="Scr${i}Turn" Axis="0,1,0" Angle="${sc.turn}"/></RotateTransform3D.Rotation></RotateTransform3D>
      <TranslateTransform3D x:Name="Scr${i}Float"/>
      <TranslateTransform3D OffsetX="${((sc.x - c) * k).toFixed(2)}" OffsetY="${((c - sc.y) * k).toFixed(2)}" OffsetZ="${sc.z}"/>
     </Transform3DGroup></Viewport2DVisual3D.Transform>
     <Viewport2DVisual3D.Geometry><MeshGeometry3D Positions="${-a},${-b},0 ${a},${-b},0 ${a},${b},0 ${-a},${b},0" TriangleIndices="0 1 2 0 2 3" TextureCoordinates="1,1 0,1 0,0 1,0"/></Viewport2DVisual3D.Geometry>
     <Viewport2DVisual3D.Material><DiffuseMaterial Viewport2DVisual3D.IsVisualHostMaterial="True" Brush="White"/></Viewport2DVisual3D.Material>
     <Viewport2DVisual3D.Visual>
      ${screenFace(sc, i)}
     </Viewport2DVisual3D.Visual>
    </Viewport2DVisual3D>`;
};
const SCREENS_XAML = `<Viewport3D x:Name="Screens" Canvas.Left="${SCREEN_VIEW.left}" Canvas.Top="${SCREEN_VIEW.top}" Width="${SCREEN_VIEW.size}" Height="${SCREEN_VIEW.size}" ClipToBounds="False" IsHitTestVisible="False" Visibility="Collapsed">
   <Viewport3D.Effect><DropShadowEffect BlurRadius="8" ShadowDepth="0" Opacity="0.85" Color="#38BDF8"/></Viewport3D.Effect>
   <Viewport3D.Camera><PerspectiveCamera Position="0,0,${SCREEN_CAM.toFixed(2)}" LookDirection="0,0,-1" UpDirection="0,1,0" FieldOfView="${SCREEN_FOV}"/></Viewport3D.Camera>
   <ModelVisual3D><ModelVisual3D.Content><AmbientLight Color="White"/></ModelVisual3D.Content></ModelVisual3D>
   ${R.screens.map(screenXaml).join('\n   ')}
  </Viewport3D>`;
/** Bước cuộn của dòng chữ trên màn (rig lặp lại sau mỗi chu kỳ độ rộng dòng). */
export const SCREEN_SCROLL_LOOP = SCREEN_LINE.step * SCREEN_LINE.widths.length;

/** Chữ "z" khi ngủ — rig đặt vị trí / cỡ / độ mờ từng chữ; viền sáng trắng để đọc được trên nền tối lẫn sáng. */
const ZZZ_XAML = `<Canvas x:Name="Zzz" Opacity="0" IsHitTestVisible="False">
   <Canvas.Effect><DropShadowEffect BlurRadius="4" ShadowDepth="0" Opacity="0.9" Color="White"/></Canvas.Effect>
   ${[0, 1, 2].map((i) => `<TextBlock x:Name="Zzz${i}" Text="z" FontSize="${R.zzz.size}" FontWeight="Black" Foreground="#6E80A8" RenderTransformOrigin="0.5,0.5"/>`).join('\n   ')}
  </Canvas>`;

/** "!" chờ xác nhận: huy hiệu cam viền trắng, dấu chấm than vẽ bằng hình (nét gọn ở cỡ nhỏ hơn chữ). */
const AL = R.alert;
const ALERT_XAML = `<Canvas x:Name="Alert" Opacity="0" IsHitTestVisible="False">
   <Canvas.RenderTransform><TransformGroup><ScaleTransform x:Name="AlertScale" CenterX="${AL.x}" CenterY="${AL.y + AL.r}"/><RotateTransform x:Name="AlertRot" CenterX="${AL.x}" CenterY="${AL.y + AL.r}"/><TranslateTransform x:Name="AlertMove"/></TransformGroup></Canvas.RenderTransform>
   <Ellipse Canvas.Left="${AL.x - AL.r}" Canvas.Top="${AL.y - AL.r}" Width="${AL.r * 2}" Height="${AL.r * 2}" Fill="#FF7D00" Stroke="White" StrokeThickness="2.5">
    <Ellipse.Effect><DropShadowEffect BlurRadius="8" ShadowDepth="0" Opacity="0.7" Color="#FF7D00"/></Ellipse.Effect>
   </Ellipse>
   <Rectangle Canvas.Left="${AL.x - AL.r * 0.155}" Canvas.Top="${AL.y - AL.r * 0.58}" Width="${AL.r * 0.31}" Height="${AL.r * 0.72}" RadiusX="${AL.r * 0.155}" RadiusY="${AL.r * 0.155}" Fill="White"/>
   <Ellipse Canvas.Left="${AL.x - AL.r * 0.17}" Canvas.Top="${AL.y + AL.r * 0.26}" Width="${AL.r * 0.34}" Height="${AL.r * 0.34}" Fill="White"/>
  </Canvas>`;

/** Bong bóng suy nghĩ: viên thuốc trắng + ba chấm nhảy lần lượt (rig) + hai chấm tròn nhỏ dẫn về đầu. */
const TK = R.think;
const thinkCircle = (cx, cy, r) => `<Ellipse Canvas.Left="${cx - r}" Canvas.Top="${cy - r}" Width="${r * 2}" Height="${r * 2}" Fill="White" Stroke="#D5DBE6" StrokeThickness="1.2"/>`;
const THINK_XAML = `<Canvas x:Name="Think" Opacity="0" IsHitTestVisible="False">
   <Canvas.RenderTransform><ScaleTransform x:Name="ThinkScale" CenterX="${TK.x - TK.w / 2}" CenterY="${TK.y + TK.h / 2}"/></Canvas.RenderTransform>
   <Canvas.Effect><DropShadowEffect BlurRadius="6" ShadowDepth="1" Direction="270" Opacity="0.18" Color="#0B1B3F"/></Canvas.Effect>
   ${thinkCircle(TK.x - TK.w / 2 - 16, TK.y + TK.h / 2 + 20, 4)}
   ${thinkCircle(TK.x - TK.w / 2 - 5, TK.y + TK.h / 2 + 9, 6.2)}
   <Border Canvas.Left="${TK.x - TK.w / 2}" Canvas.Top="${TK.y - TK.h / 2}" Width="${TK.w}" Height="${TK.h}" CornerRadius="${TK.h / 2}" Background="White" BorderBrush="#D5DBE6" BorderThickness="1.2"/>
   ${[0, 1, 2].map((i) => `<Ellipse x:Name="ThinkDot${i}" Canvas.Left="${TK.x - TK.gap - TK.dot / 2 + i * TK.gap}" Canvas.Top="${TK.y - TK.dot / 2}" Width="${TK.dot}" Height="${TK.dot}" Fill="#3491FA"/>`).join('\n   ')}
  </Canvas>`;

/** Tia lấp lánh (xong việc): sao bốn cánh vàng / xanh xen kẽ; rig đặt vị trí / cỡ / góc xoay. */
const SPARK_STAR = 'M0,-7 Q1.3,-1.3 7,0 Q1.3,1.3 0,7 Q-1.3,1.3 -7,0 Q-1.3,-1.3 0,-7 Z';
const SPARKS_XAML = `<Canvas x:Name="Sparks" Visibility="Collapsed" IsHitTestVisible="False">
   <Canvas.Effect><DropShadowEffect BlurRadius="5" ShadowDepth="0" Opacity="0.9" Color="#FFF3C4"/></Canvas.Effect>
   ${R.sparks.angles.map((_, i) => `<Path x:Name="Spark${i}" Data="${SPARK_STAR}" Fill="${i % 2 ? GLOW : '#FFC53D'}"/>`).join('\n   ')}
  </Canvas>`;

/**
 * Toàn bộ linh vật (Canvas 192×192). Bóng dưới đất đứng yên (co / nhạt khi bot nhún lên); `Bot` nhún + nghiêng + co giãn quanh đáy;
 * `Head` xoay quanh cổ, chứa ăng-ten (sau mũ), đèn tai, vạch quét và mặt (`FaceLook` = mặt dịch theo hướng nhìn cho cảm giác khối).
 */
export const BOT_XAML = `<Canvas x:Name="Stage" Width="${S}" Height="${S}">
  <Ellipse x:Name="Shadow" Canvas.Left="${R.ground.x - 50}" Canvas.Top="${R.ground.y - 6}" Width="100" Height="10" IsHitTestVisible="False" RenderTransformOrigin="0.5,0.5">
   <Ellipse.Fill><RadialGradientBrush><GradientStop Color="#330B1B3F" Offset="0"/><GradientStop Color="#000B1B3F" Offset="1"/></RadialGradientBrush></Ellipse.Fill>
   <Ellipse.RenderTransform><ScaleTransform x:Name="ShadowScale"/></Ellipse.RenderTransform>
  </Ellipse>
  <Canvas x:Name="Bot" Width="${S}" Height="${S}">
   <Canvas.RenderTransform><TransformGroup>
    <ScaleTransform x:Name="BotScale" CenterX="${R.ground.x}" CenterY="${R.ground.y}"/>
    <RotateTransform x:Name="BotLean" CenterX="${R.ground.x}" CenterY="${R.ground.y}"/>
    <TranslateTransform x:Name="BotMove"/>
   </TransformGroup></Canvas.RenderTransform>
   ${img('BodyImg')}
   <Canvas x:Name="Head">
    <Canvas.RenderTransform><TransformGroup>
     <RotateTransform x:Name="HeadRot" CenterX="${R.neck.x}" CenterY="${R.neck.y}"/>
     <TranslateTransform x:Name="HeadMove"/>
    </TransformGroup></Canvas.RenderTransform>
    ${ANTENNA_XAML}
    ${img('HeadImg')}
    ${ear('EarGlowL', R.earL)}
    ${ear('EarGlowR', R.earR)}
    ${VISOR_FX}
    <!-- Mặt: vẽ quanh (0,0) theo đơn vị gốc, phóng ${F.scale} rồi đặt vào kính; EyeLook (con trỏ / liếc) dời riêng hai mắt -->
    <Canvas x:Name="Face" IsHitTestVisible="False">
     <Canvas.RenderTransform><TransformGroup>
      <ScaleTransform x:Name="FaceScale" ScaleX="${F.scale}" ScaleY="${F.scale}"/>
      <TranslateTransform x:Name="FaceLook"/>
      <TranslateTransform X="${F.x}" Y="${F.y}"/>
     </TransformGroup></Canvas.RenderTransform>
     <Canvas.Effect><DropShadowEffect BlurRadius="7" ShadowDepth="0" Opacity="0.8" Color="${GLOW}"/></Canvas.Effect>
     <Canvas><Canvas.RenderTransform><TranslateTransform x:Name="EyeLook"/></Canvas.RenderTransform>
      <Canvas x:Name="EyeL" Canvas.Left="${-F.eyeDx}" Canvas.Top="${F.eyeY}"><Canvas.RenderTransform><ScaleTransform x:Name="EyeMorphL"/></Canvas.RenderTransform>
      ${eyeSide('L')}
      </Canvas>
      <Canvas x:Name="EyeR" Canvas.Left="${F.eyeDx}" Canvas.Top="${F.eyeY}"><Canvas.RenderTransform><ScaleTransform x:Name="EyeMorphR"/></Canvas.RenderTransform>
      ${eyeSide('R')}
      </Canvas>
     </Canvas>
     <Canvas x:Name="Mouth" Canvas.Top="${F.mouthY}"><Canvas.RenderTransform><ScaleTransform x:Name="MouthMorph"/></Canvas.RenderTransform>
      ${BOT_MOUTHS.map((n) => `<Canvas x:Name="Mouth_${n}" Visibility="Collapsed">${MOUTH_SHAPES[n]}</Canvas>`).join('\n      ')}
     </Canvas>
    </Canvas>
   </Canvas>
  </Canvas>
  ${SCREENS_XAML}
  <!-- Đạo cụ gắn với đầu (zzz, "!", ba chấm, lấp lánh): rig chép biến đổi của Head + Bot vào đây mỗi khung hình → kéo / nghiêng / nhún
       thì đạo cụ đi theo đầu đúng góc. Không nằm trong Bot để khỏi mờ theo bot khi tạm dừng / mất kết nối. -->
  <Canvas x:Name="Props" IsHitTestVisible="False">
   <Canvas.RenderTransform><TransformGroup>
    <RotateTransform x:Name="PropsHeadRot" CenterX="${R.neck.x}" CenterY="${R.neck.y}"/>
    <TranslateTransform x:Name="PropsHeadMove"/>
    <ScaleTransform x:Name="PropsScale" CenterX="${R.ground.x}" CenterY="${R.ground.y}"/>
    <RotateTransform x:Name="PropsLean" CenterX="${R.ground.x}" CenterY="${R.ground.y}"/>
    <TranslateTransform x:Name="PropsMove"/>
   </TransformGroup></Canvas.RenderTransform>
   ${ZZZ_XAML}
   ${ALERT_XAML}
   ${THINK_XAML}
   ${SPARKS_XAML}
  </Canvas>
 </Canvas>`;

/** Ảnh từng lớp: tên phần tử Image → tên tệp trong thư mục cửa sổ (index.mjs ghi từ assets.mjs). */
export const BOT_LAYER_FILES = Object.freeze({ BodyImg: 'bot-body.png', HeadImg: 'bot-head.png', AntennaImg: 'bot-antenna.png' });
