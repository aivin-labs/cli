import { spawn } from 'child_process';
import fs from 'fs';
import readline from 'readline';
import { AIVIN_BRAND, AIVIN_LOGO_PNG_BASE64 } from './brand.mjs';

/**
 * Hộp "Cho phép / Từ chối" NGAY TRÊN MÁY cho việc sàn luật tại máy đòi xác nhận (localPolicy.mjs). BE không trả lời thay được: chỉ người
 * ngồi trước máy bấm được. Windows: hộp riêng (WinForms qua PowerShell — tiêu đề, mục đích, lệnh trong khung chữ đơn cách, đếm ngược, hai
 * nút tiếng Việt; trước đây là MessageBox Yes/No thô), macOS: `osascript display dialog`, Linux: zenity / kdialog khi có màn hình; không có
 * màn hình mà daemon chạy trong terminal → hỏi trong terminal; không có cả hai → không hỏi được (việc bị từ chối).
 * Mặc định là "Từ chối" (Enter / Esc / đóng hộp / hết giờ đều là từ chối).
 */

/** `CANCELLED`: lời gọi bị huỷ (BE huỷ / hết giờ, tạm dừng, daemon dừng) trong lúc hộp đang chờ hoặc còn xếp hàng — hộp đóng, việc không chạy. */
export const ConfirmResult = Object.freeze({ ALLOW: 'allow', REJECT: 'reject', TIMEOUT: 'timeout', UNAVAILABLE: 'unavailable', CANCELLED: 'cancelled' });

const TITLE = 'Aivin — xác nhận trên máy này';
const HEADING = 'Agent Aivin xin chạy một việc trên máy này';
const ALLOW_LABEL = 'Cho phép';
const REJECT_LABEL = 'Từ chối';
const PURPOSE_PREFIX = 'Agent ghi: ';

const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');

const B = AIVIN_BRAND;

const fade = (target, to, ms) => `<DoubleAnimation Storyboard.TargetName="${target}" Storyboard.TargetProperty="Opacity" To="${to}" Duration="0:0:0.${String(ms).padStart(3, '0')}"/>`;
const press = (to) => ['ScaleX', 'ScaleY'].map((axis) =>
  `<DoubleAnimation Storyboard.TargetName="root" Storyboard.TargetProperty="(UIElement.RenderTransform).(ScaleTransform.${axis})" To="${to}" Duration="0:0:0.090"/>`).join('');

/**
 * Nút bo góc (WPF không có sẵn): lớp phủ màu `Tag` (Binding, không TemplateBinding — TemplateBinding không đổi chuỗi màu sang Brush, lớp phủ
 * không bao giờ hiện) hiện dần khi rê chuột (150 ms), nhấn thì thu nhỏ nhẹ, không viền chấm của WPF; phím tắt
 * Alt + chữ gạch dưới. `radius`: bo góc của nút.
 */
const buttonStyle = (key, radius) => `<Style x:Key="${key}" TargetType="Button">
  <Setter Property="FontSize" Value="14"/><Setter Property="FontWeight" Value="SemiBold"/><Setter Property="Cursor" Value="Hand"/>
  <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
  <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
    <Grid x:Name="root" RenderTransformOrigin="0.5,0.5" Background="Transparent">
      <Grid.RenderTransform><ScaleTransform ScaleX="1" ScaleY="1"/></Grid.RenderTransform>
      <Border x:Name="b" CornerRadius="${radius}" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
              BorderThickness="{TemplateBinding BorderThickness}"/>
      <Border x:Name="h" CornerRadius="${radius}" Background="{Binding Tag, RelativeSource={RelativeSource TemplatedParent}}" Opacity="0"/>
      <ContentPresenter Margin="{TemplateBinding Padding}" HorizontalAlignment="Center" VerticalAlignment="Center" RecognizesAccessKey="True"/>
    </Grid>
    <ControlTemplate.Triggers>
      <Trigger Property="IsMouseOver" Value="True">
        <Trigger.EnterActions><BeginStoryboard><Storyboard>${fade('h', 1, 150)}</Storyboard></BeginStoryboard></Trigger.EnterActions>
        <Trigger.ExitActions><BeginStoryboard><Storyboard>${fade('h', 0, 200)}</Storyboard></BeginStoryboard></Trigger.ExitActions>
      </Trigger>
      <Trigger Property="IsPressed" Value="True">
        <Trigger.EnterActions><BeginStoryboard><Storyboard>${press(0.97)}</Storyboard></BeginStoryboard></Trigger.EnterActions>
        <Trigger.ExitActions><BeginStoryboard><Storyboard>${press(1)}</Storyboard></BeginStoryboard></Trigger.ExitActions>
      </Trigger>
    </ControlTemplate.Triggers>
  </ControlTemplate></Setter.Value></Setter>
</Style>`;

/** Thẻ hiện ra: mờ → rõ + phóng nhẹ 0,96 → 1 (180 ms, chậm dần); đóng: ngược lại 120 ms rồi mới đóng cửa sổ. */
const cardMotion = (key, opacity, scale, ms, ease) => `<Storyboard x:Key="${key}">
  <DoubleAnimation Storyboard.TargetProperty="Opacity" To="${opacity}" Duration="0:0:0.${ms}"/>
  ${['ScaleX', 'ScaleY'].map((axis) => `<DoubleAnimation Storyboard.TargetProperty="(UIElement.RenderTransform).(ScaleTransform.${axis})" To="${scale}" Duration="0:0:0.${ms}"><DoubleAnimation.EasingFunction><CubicEase EasingMode="${ease}"/></DoubleAnimation.EasingFunction></DoubleAnimation>`).join('\n  ')}
</Storyboard>`;

/**
 * Thẻ xác nhận theo nhận diện Aivin (logo + dải màu của logo, bo góc như hộp xác nhận trên web): không viền hệ thống, kéo được ở phần đầu,
 * chip cảnh báo, khối lệnh chữ đơn cách, đếm ngược, "Từ chối" là nút mặc định (Enter / Esc / nút ×).
 */
const WINDOWS_XAML = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
  Width="520" SizeToContent="Height" WindowStyle="None" AllowsTransparency="True" Background="Transparent" ResizeMode="NoResize"
  Topmost="True" ShowInTaskbar="True" WindowStartupLocation="CenterScreen" FontFamily="Segoe UI" UseLayoutRounding="True">
 <Window.Resources>
  ${buttonStyle('Btn', 10)}
  ${buttonStyle('IconBtn', 8)}
  ${cardMotion('In', 1, 1, 180, 'EaseOut')}
  ${cardMotion('Out', 0, 0.97, 120, 'EaseIn')}
 </Window.Resources>
 <Border x:Name="Card" Margin="20" CornerRadius="18" Background="White" BorderBrush="#E5E6EB" BorderThickness="1" Opacity="0" RenderTransformOrigin="0.5,0.5">
  <Border.RenderTransform><ScaleTransform ScaleX="0.96" ScaleY="0.96"/></Border.RenderTransform>
  <Border.Effect><DropShadowEffect BlurRadius="30" ShadowDepth="8" Direction="270" Opacity="0.18" Color="#0B1B3F"/></Border.Effect>
  <StackPanel Margin="26,20,22,24">
   <DockPanel x:Name="Head" Background="Transparent" LastChildFill="False">
    <Image x:Name="Logo" Width="26" Height="26" RenderOptions.BitmapScalingMode="HighQuality" VerticalAlignment="Center"/>
    <TextBlock Text="Aivin" FontSize="15" FontWeight="SemiBold" Foreground="${B.ink}" Margin="9,0,0,0" VerticalAlignment="Center"/>
    <TextBlock x:Name="Sub" FontSize="13" Foreground="${B.muted}" Margin="8,1,0,0" VerticalAlignment="Center"/>
    <Button x:Name="Close" DockPanel.Dock="Right" Style="{StaticResource IconBtn}" Content="✕" Width="32" Height="32" FontSize="12" FontWeight="Normal"
            Background="Transparent" BorderThickness="0" Tag="#F2F3F5" Foreground="${B.muted}" ToolTip="Từ chối" IsTabStop="False"/>
   </DockPanel>
   <TextBlock x:Name="Heading" Margin="0,20,0,0" FontSize="20" FontWeight="SemiBold" Foreground="${B.ink}" TextWrapping="Wrap"/>
   <Border Margin="0,12,0,0" HorizontalAlignment="Left" CornerRadius="12" Background="${B.warnBg}" Padding="11,5">
    <TextBlock x:Name="Reason" Foreground="${B.warn}" FontSize="13" FontWeight="SemiBold" TextWrapping="Wrap"/>
   </Border>
   <TextBlock x:Name="Purpose" Margin="0,14,0,0" FontSize="14" Foreground="${B.body}" TextWrapping="Wrap" LineHeight="20"/>
   <TextBlock x:Name="DetailLabel" Margin="0,16,0,6" FontSize="12" Foreground="${B.muted}"/>
   <Border CornerRadius="10" Background="#F4F6FA" BorderBrush="#E8ECF3" BorderThickness="1" Padding="14,11">
    <ScrollViewer MaxHeight="150" VerticalScrollBarVisibility="Auto">
     <TextBlock x:Name="Detail" FontFamily="Cascadia Mono, Consolas" FontSize="13" Foreground="${B.ink}" TextWrapping="Wrap"/>
    </ScrollViewer>
   </Border>
   <DockPanel Margin="0,24,0,0" LastChildFill="False">
    <TextBlock x:Name="Countdown" VerticalAlignment="Center" FontSize="12" Foreground="${B.muted}"/>
    <Button x:Name="Allow" DockPanel.Dock="Right" Style="{StaticResource Btn}" Height="40" MinWidth="116" Padding="20,0" Margin="10,0,0,0"
            Background="${B.brand}" Foreground="White" BorderThickness="0" Tag="#26000000"/>
    <Button x:Name="Reject" DockPanel.Dock="Right" Style="{StaticResource Btn}" Height="40" MinWidth="116" Padding="20,0"
            Background="White" Foreground="${B.ink}" BorderBrush="#C9CDD4" BorderThickness="1" Tag="#0F000000" IsCancel="True" IsDefault="True"/>
   </DockPanel>
  </StackPanel>
 </Border>
</Window>`;

/** Dựng thẻ WPF từ biến môi trường base64 (không phải thoát dấu nháy), in Yes / No / Timeout ra stdout. */
const WINDOWS_SCRIPT = [
  'Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase',
  'function D($n) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Environment]::GetEnvironmentVariable($n))) }',
  "$w = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader ([xml](D 'AIVIN_C_XAML'))))",
  "$w.Title = D 'AIVIN_C_TITLE'",
  "foreach ($n in 'Sub', 'Heading', 'Reason', 'Purpose', 'DetailLabel', 'Detail') { $w.FindName($n).Text = D ('AIVIN_C_' + $n.ToUpper()) }",
  "if (-not $w.FindName('Purpose').Text) { $w.FindName('Purpose').Visibility = 'Collapsed' }",
  "$w.FindName('Allow').Content = D 'AIVIN_C_ALLOW'; $w.FindName('Reject').Content = D 'AIVIN_C_REJECT'",
  "$ms = New-Object IO.MemoryStream(, [Convert]::FromBase64String($env:AIVIN_C_LOGO)); $img = New-Object Windows.Media.Imaging.BitmapImage",
  "$img.BeginInit(); $img.StreamSource = $ms; $img.CacheOption = 'OnLoad'; $img.EndInit(); $w.FindName('Logo').Source = $img",
  "$script:result = 'No'; $script:closing = $false; $card = $w.FindName('Card')",
  '$tm = New-Object Windows.Threading.DispatcherTimer; $tm.Interval = [TimeSpan]::FromSeconds(1)',
  // Đóng có hiệu ứng: chạy storyboard "Out" rồi mới đóng cửa sổ; bấm liên tiếp chỉ tính lần đầu.
  "function Finish($r) { if ($script:closing) { return }; $script:closing = $true; $script:result = $r; $tm.Stop(); $sb = $w.FindResource('Out').Clone(); $sb.Add_Completed({ $w.Close() }); $sb.Begin($card) }",
  "$w.FindName('Allow').Add_Click({ Finish 'Yes' })",
  "$w.FindName('Reject').Add_Click({ Finish 'No' }); $w.FindName('Close').Add_Click({ Finish 'No' })",
  "$w.FindName('Head').Add_MouseLeftButtonDown({ $w.DragMove() })",
  "$script:left = [int]$env:AIVIN_C_SECONDS; $fmt = D 'AIVIN_C_COUNTDOWN'; $cd = $w.FindName('Countdown'); $cd.Text = $fmt -f $script:left",
  "$tm.Add_Tick({ $script:left--; $cd.Text = $fmt -f $script:left; if ($script:left -le 0) { Finish 'Timeout' } })",
  "$w.Add_ContentRendered({ $w.FindResource('In').Begin($card); $w.Activate(); [void]$w.FindName('Reject').Focus(); $tm.Start() })",
  '[void]$w.ShowDialog(); $tm.Stop(); $script:result',
].join('\n');

/** Nội dung chữ thường (macOS / Linux / terminal): lý do, mục đích agent ghi, lệnh. */
function plainText({ reason, purpose, detail }) {
  return [HEADING, '', `⚠ ${reason}`, ...(purpose ? [`${PURPOSE_PREFIX}${purpose}`] : []), '', detail].join('\n');
}

const hasExe = (candidates) => candidates.some((p) => fs.existsSync(p));

/** Lệnh hiện hộp xác nhận theo hệ điều hành + cách đọc kết quả — `null` khi máy không hiện được hộp. */
export function confirmCommand({ request, timeoutSec, platform = process.platform, env = process.env, exists = hasExe }) {
  if (platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
      env: {
        AIVIN_C_XAML: b64(WINDOWS_XAML), AIVIN_C_LOGO: AIVIN_LOGO_PNG_BASE64, AIVIN_C_TITLE: b64(TITLE),
        AIVIN_C_SUB: b64('Xác nhận trên máy này'), AIVIN_C_HEADING: b64('Cho phép agent làm việc này trên máy?'),
        AIVIN_C_REASON: b64(`⚠  ${request.reason}`), AIVIN_C_PURPOSE: b64(request.purpose ? `${PURPOSE_PREFIX}${request.purpose}` : ''),
        AIVIN_C_DETAILLABEL: b64('SẼ THỰC HIỆN'), AIVIN_C_DETAIL: b64(request.detail),
        AIVIN_C_ALLOW: b64(`_${ALLOW_LABEL}`), AIVIN_C_REJECT: b64(`_${REJECT_LABEL}`),
        AIVIN_C_COUNTDOWN: b64('Tự từ chối sau {0} giây'), AIVIN_C_SECONDS: String(timeoutSec),
      },
      parse: (out, code) => (code !== 0 ? ConfirmResult.UNAVAILABLE : /\bYes\b/.test(out) ? ConfirmResult.ALLOW
        : /\bTimeout\b/.test(out) ? ConfirmResult.TIMEOUT : ConfirmResult.REJECT),
    };
  }
  const text = plainText(request);
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: ['-e', 'on run argv',
        '-e', `display dialog (item 1 of argv) with title (item 2 of argv) buttons {"${REJECT_LABEL}", "${ALLOW_LABEL}"} default button "${REJECT_LABEL}" cancel button "${REJECT_LABEL}" with icon caution giving up after ((item 3 of argv) as integer)`,
        '-e', 'end run', text, TITLE, String(timeoutSec)],
      parse: (out, code) => (/gave up:true/.test(out) ? ConfirmResult.TIMEOUT : code === 0 && out.includes(ALLOW_LABEL) ? ConfirmResult.ALLOW : ConfirmResult.REJECT),
    };
  }
  if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
    if (exists(['/usr/bin/zenity', '/bin/zenity'])) {
      return {
        cmd: 'zenity',
        args: ['--question', '--title', TITLE, '--text', text, '--no-markup', '--ok-label', ALLOW_LABEL, '--cancel-label', REJECT_LABEL, '--default-cancel', '--timeout', String(timeoutSec)],
        parse: (_out, code) => (code === 0 ? ConfirmResult.ALLOW : code === 5 ? ConfirmResult.TIMEOUT : ConfirmResult.REJECT),
      };
    }
    if (exists(['/usr/bin/kdialog', '/bin/kdialog'])) {
      return {
        cmd: 'kdialog',
        args: ['--title', TITLE, '--yesno', text, '--yes-label', ALLOW_LABEL, '--no-label', REJECT_LABEL],
        parse: (_out, code) => (code === 0 ? ConfirmResult.ALLOW : ConfirmResult.REJECT),
      };
    }
  }
  return null;
}

function runDialog(command, timeoutSec, spawnImpl, signal) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let child;
    let timer;
    const kill = () => { try { child?.kill(); } catch { /* đã thoát */ } };
    const onAbort = () => { kill(); done(ConfirmResult.CANCELLED); };
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    try {
      child = spawnImpl(command.cmd, command.args, { env: { ...process.env, ...(command.env || {}) }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: false });
    } catch {
      return done(ConfirmResult.UNAVAILABLE);
    }
    // Cộng 10 s cho hộp tự hết giờ (đếm ngược / macOS / zenity; PowerShell nạp WinForms mất vài giây) trước khi tự giết.
    timer = setTimeout(() => { kill(); done(ConfirmResult.TIMEOUT); }, (timeoutSec + 10) * 1000);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d) => { out += d; });
    child.on('error', () => done(ConfirmResult.UNAVAILABLE));
    child.on('close', (code) => done(command.parse(out, code)));
  });
}

function askInTerminal(request, timeoutSec, signal) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      rl.close();
      resolve(r);
    };
    const onAbort = () => done(ConfirmResult.CANCELLED);
    const timer = setTimeout(() => done(ConfirmResult.TIMEOUT), timeoutSec * 1000);
    signal?.addEventListener('abort', onAbort, { once: true });
    rl.question(`\n${plainText(request)}\n   Gõ "c" rồi Enter để ${ALLOW_LABEL.toLowerCase()} (Enter = ${REJECT_LABEL.toLowerCase()}, tự từ chối sau ${timeoutSec} s): `, (answer) => {
      done(/^\s*(c|co|có|y|yes)\s*$/i.test(answer) ? ConfirmResult.ALLOW : ConfirmResult.REJECT);
    });
  });
}

/**
 * Bộ hỏi xác nhận: mỗi lúc một hộp (lời gọi song song xếp hàng). `ask({ reason, purpose?, detail, timeoutSec, signal?, onStart? })` →
 * `ConfirmResult`. `reason`: vì sao cần hỏi (do máy tự xét), `purpose`: mục đích agent ghi (từ BE — chỉ để tham khảo), `detail`: lệnh /
 * đối tượng thật. `signal` huỷ → hộp đang mở đóng lại / hộp còn xếp hàng không hiện, trả `CANCELLED`. `onStart(queuedMs)`: gọi đúng lúc
 * hộp này tới lượt hiện (đã xếp hàng bấy nhiêu ms) — để xin BE lùi hạn thêm phần đã chờ. `tty`: daemon đang chạy trong terminal tương tác
 * (dự phòng khi không hiện được hộp).
 */
export function createLocalConfirmer({ platform = process.platform, spawnImpl = spawn, tty = !!(process.stdin.isTTY && process.stdout.isTTY), env = process.env } = {}) {
  let queue = Promise.resolve();
  const askOnce = async ({ timeoutSec, signal, onStart, queuedAt, ...request }) => {
    if (signal?.aborted) return ConfirmResult.CANCELLED;
    onStart?.(Date.now() - queuedAt);
    const command = confirmCommand({ request, timeoutSec, platform, env });
    if (command) {
      const result = await runDialog(command, timeoutSec, spawnImpl, signal);
      if (result !== ConfirmResult.UNAVAILABLE) return result;
    }
    if (signal?.aborted) return ConfirmResult.CANCELLED;
    return tty ? askInTerminal(request, timeoutSec, signal) : ConfirmResult.UNAVAILABLE;
  };
  return {
    ask(req) {
      const queuedAt = Date.now();
      const p = queue.then(() => askOnce({ ...req, queuedAt }));
      queue = p.catch(() => undefined);
      return p;
    },
  };
}
