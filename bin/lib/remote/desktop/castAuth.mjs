import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { REMOTE_CONFIG_DIR } from '../constants.mjs';
import { AIVIN_LOGO_PNG_BASE64 } from '../brand.mjs';
import { CastConsentDecision } from './castConsent.mjs';
import { lockHolder } from '../daemonLock.mjs';
import { CAST_CONSENT_WINDOW_TITLE, HUMAN_GUARD_PS, humanGuardEnv } from '../humanInput.mjs';

export const CAST_SESSION_FILE = path.join(REMOTE_CONFIG_DIR, 'desktop-cast-session.json');
export const CAST_ACTION_FILE = path.join(REMOTE_CONFIG_DIR, 'desktop-cast-action.json');
export const CAST_PERMISSIONS_FILE = path.join(REMOTE_CONFIG_DIR, 'cast-permissions.json');

const CAST_STOP_ACTION = Object.freeze({ action: 'stop_and_block' });

const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');

function loadPermissions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CAST_PERMISSIONS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function savePermissions(data) {
  try {
    fs.mkdirSync(path.dirname(CAST_PERMISSIONS_FILE), { recursive: true });
    fs.writeFileSync(CAST_PERMISSIONS_FILE, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch { }
}

/**
 * Chủ máy vừa bấm ngắt: mọi phiên sau đều phải hỏi tới khi chủ máy bấm "Cho phép" một lần, kể cả chế độ không cần người ở máy.
 * Khoá theo cả máy, không theo tên thiết bị: tên do trình duyệt tự khai và mã socket đổi sau mỗi lần nối nên chặn theo chúng lách được.
 * Tệp từ bản cũ (`blockedViewers` còn phần tử) cũng tính là đang khoá.
 */
export function isCastLocked() {
  const { locked, blockedViewers } = loadPermissions();
  return locked === true || (Array.isArray(blockedViewers) && blockedViewers.length > 0);
}

export function lockCast({ viewerDevice = '' } = {}) {
  savePermissions({ locked: true, lockedAt: new Date().toISOString(), lastViewerDevice: String(viewerDevice || '') });
}

export function unlockCast() {
  savePermissions({ locked: false });
}

/**
 * Ghi nhận thông tin phiên cast đang chạy để khay hệ thống (tray) đọc và hiển thị.
 */
export function recordCastSession({ active = true, sessionId = '', viewerId = '', viewerDevice = '' } = {}) {
  try {
    fs.mkdirSync(path.dirname(CAST_SESSION_FILE), { recursive: true });
    const payload = {
      active: !!active,
      // Daemon đang giữ phiên: khay / `aivin remote disconnect` biết tệp còn sót sau khi daemon chết (không còn ai để ngắt).
      pid: process.pid,
      session_id: sessionId,
      viewer_id: viewerId,
      viewer_device: viewerDevice,
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(CAST_SESSION_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch { }
}

/**
 * Xoá thông tin phiên cast khi đã ngắt kết nối.
 */
export function clearCastSession() {
  try {
    if (fs.existsSync(CAST_SESSION_FILE)) {
      fs.unlinkSync(CAST_SESSION_FILE);
    }
  } catch { }
}

/**
 * Kiểm tra xem khay hệ thống có gửi lệnh ngắt / chặn thiết bị cast không.
 */
export function checkCastAction() {
  let content;
  try {
    if (!fs.existsSync(CAST_ACTION_FILE)) return null;
    content = fs.readFileSync(CAST_ACTION_FILE, 'utf8');
    fs.unlinkSync(CAST_ACTION_FILE);
  } catch {
    return null;
  }
  // Có tệp nghĩa là chủ máy đã bấm ngắt: không đọc được nội dung thì vẫn phải ngắt, không được bỏ qua.
  try {
    const action = JSON.parse(content);
    return action && typeof action === 'object' ? action : CAST_STOP_ACTION;
  } catch {
    return CAST_STOP_ACTION;
  }
}

/**
 * Gửi yêu cầu ngắt từ dòng lệnh, cùng đường với nút ở khay. Trả về `false` nếu không có phiên nào đang chạy — kể cả khi tệp phiên còn sót lại
 * sau khi daemon chết (dọn luôn, không báo "đã ngắt" cho một phiên không tồn tại).
 */
export function requestCastStop({ daemonAlive = () => lockHolder() !== null } = {}) {
  if (!fs.existsSync(CAST_SESSION_FILE)) return false;
  if (!daemonAlive()) {
    clearCastSession();
    return false;
  }
  fs.mkdirSync(path.dirname(CAST_ACTION_FILE), { recursive: true });
  fs.writeFileSync(CAST_ACTION_FILE, JSON.stringify(CAST_STOP_ACTION), 'utf8');
  return true;
}

export const CONSENT_XAML = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
  Width="500" SizeToContent="Height" WindowStyle="None" AllowsTransparency="True" Background="Transparent" ResizeMode="NoResize"
  Topmost="True" ShowInTaskbar="True" WindowStartupLocation="CenterScreen" FontFamily="Segoe UI" UseLayoutRounding="True">
 <Window.Resources>
  <Style x:Key="Btn" TargetType="Button">
   <Setter Property="FontSize" Value="14"/><Setter Property="FontWeight" Value="SemiBold"/><Setter Property="Cursor" Value="Hand"/>
   <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
   <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
    <Grid x:Name="root" RenderTransformOrigin="0.5,0.5" Background="Transparent">
      <Border x:Name="b" CornerRadius="10" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}"/>
      <ContentPresenter Margin="{TemplateBinding Padding}" HorizontalAlignment="Center" VerticalAlignment="Center" RecognizesAccessKey="True"/>
    </Grid>
   </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style x:Key="IconBtn" TargetType="Button">
   <Setter Property="FontSize" Value="12"/><Setter Property="Cursor" Value="Hand"/><Setter Property="FocusVisualStyle" Value="{x:Null}"/>
   <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
    <Border CornerRadius="8" Background="{TemplateBinding Background}">
      <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
    </Border>
   </ControlTemplate></Setter.Value></Setter>
  </Style>
 </Window.Resources>
 <Border Margin="20" CornerRadius="18" Background="White" BorderBrush="#E5E6EB" BorderThickness="1">
  <Border.Effect><DropShadowEffect BlurRadius="30" ShadowDepth="8" Direction="270" Opacity="0.18" Color="#0B1B3F"/></Border.Effect>
  <StackPanel Margin="26,20,22,24">
   <DockPanel x:Name="Head" Background="Transparent" LastChildFill="False">
    <Image x:Name="Logo" Width="26" Height="26" RenderOptions.BitmapScalingMode="HighQuality" VerticalAlignment="Center"/>
    <TextBlock Text="Aivin" FontSize="15" FontWeight="SemiBold" Foreground="#111827" Margin="9,0,0,0" VerticalAlignment="Center"/>
    <TextBlock Text="•  Yêu cầu chia sẻ màn hình" FontSize="13" Foreground="#6B7280" Margin="8,1,0,0" VerticalAlignment="Center"/>
    <Button x:Name="Close" DockPanel.Dock="Right" Style="{StaticResource IconBtn}" Content="✕" Width="32" Height="32"
            Background="Transparent" Foreground="#6B7280" ToolTip="Từ chối" IsTabStop="False"/>
   </DockPanel>
   <TextBlock Text="Cho phép xem và điều khiển màn hình máy tính?" Margin="0,20,0,0" FontSize="18" FontWeight="SemiBold" Foreground="#111827" TextWrapping="Wrap"/>
   <Border x:Name="Warn" Margin="0,12,0,0" HorizontalAlignment="Left" CornerRadius="10" Background="#FEF3C7" Padding="12,6">
    <TextBlock Text="⚠  Thiết bị này trước đó đã bị ngắt kết nối" Foreground="#92400E" FontSize="12.5" FontWeight="SemiBold" TextWrapping="Wrap"/>
   </Border>
   <Border Margin="0,14,0,0" CornerRadius="10" Background="#F4F6FA" BorderBrush="#E8ECF3" BorderThickness="1" Padding="14,12">
    <StackPanel>
      <TextBlock x:Name="DeviceText" FontSize="14" FontWeight="SemiBold" Foreground="#111827" TextWrapping="Wrap"/>
      <TextBlock Text="Thiết bị này đang gửi yêu cầu xem màn hình và thao tác chuột, bàn phím trên máy tính của bạn." Margin="0,6,0,0" FontSize="12.5" Foreground="#4B5563" TextWrapping="Wrap"/>
    </StackPanel>
   </Border>
   <DockPanel Margin="0,22,0,0" LastChildFill="True">
    <Button x:Name="Allow" DockPanel.Dock="Right" Style="{StaticResource Btn}" Height="40" MinWidth="116" Padding="20,0" Margin="10,0,0,0"
            Background="#4E46E5" Foreground="White" BorderThickness="0" Content="_Cho phép"/>
    <Button x:Name="Reject" DockPanel.Dock="Right" Style="{StaticResource Btn}" Height="40" MinWidth="116" Padding="20,0"
            Background="White" Foreground="#111827" BorderBrush="#C9CDD4" BorderThickness="1" Content="_Từ chối" IsCancel="True" IsDefault="True"/>
    <TextBlock x:Name="Countdown" VerticalAlignment="Center" Margin="0,0,12,0" FontSize="12" Foreground="#6B7280" TextWrapping="Wrap"/>
   </DockPanel>
  </StackPanel>
 </Border>
</Window>`;

const CONSENT_SCRIPT = [
  'Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase',
  'function D($n) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Environment]::GetEnvironmentVariable($n))) }',
  // Đồng ý cho xem màn hình chỉ từ phím / chuột thật trên máy — không nhận cả thao tác từ phiên điều khiển từ xa khác (humanInput.mjs).
  ...HUMAN_GUARD_PS,
  "$w = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader ([xml](D 'AIVIN_CAST_XAML'))))",
  "$w.Title = D 'AIVIN_CAST_TITLE'",
  "$w.FindName('DeviceText').Text = D 'AIVIN_CAST_DEVICE'",
  "if ($env:AIVIN_CAST_WARN -ne '1') { $w.FindName('Warn').Visibility = 'Collapsed' }",
  "$ms = New-Object IO.MemoryStream(, [Convert]::FromBase64String($env:AIVIN_CAST_LOGO)); $img = New-Object Windows.Media.Imaging.BitmapImage",
  "$img.BeginInit(); $img.StreamSource = $ms; $img.CacheOption = 'OnLoad'; $img.EndInit(); $w.FindName('Logo').Source = $img",
  "$script:result = 'No'; $script:closing = $false",
  '$tm = New-Object Windows.Threading.DispatcherTimer; $tm.Interval = [TimeSpan]::FromSeconds(1)',
  "function Finish($r) { if ($script:closing) { return }; $script:closing = $true; $script:result = $r; $tm.Stop(); $w.Close() }",
  "$w.FindName('Allow').Add_Click({ if (Test-Human) { Finish 'Yes' } else { $script:hintLeft = 3; $cd.Text = $script:hint } })",
  "$w.FindName('Reject').Add_Click({ Finish 'No' }); $w.FindName('Close').Add_Click({ Finish 'No' })",
  "$w.FindName('Head').Add_MouseLeftButtonDown({ $w.DragMove() })",
  "$script:left = [int]$env:AIVIN_CAST_SECONDS; $fmt = D 'AIVIN_CAST_COUNTDOWN'; $cd = $w.FindName('Countdown'); $cd.Text = $fmt -f $script:left",
  "$tm.Add_Tick({ $script:left--; if ($script:hintLeft -gt 0) { $script:hintLeft--; $cd.Text = $script:hint } else { $cd.Text = $fmt -f $script:left }; if ($script:left -le 0) { Finish 'Timeout' } })",
  "$w.Add_ContentRendered({ Install-Guard $w; $w.Activate(); [void]$w.FindName('Reject').Focus(); $tm.Start() })",
  '[void]$w.ShowDialog(); $tm.Stop(); $script:result',
].join('\n');

/**
 * Hỏi người ở máy trên chính màn hình Windows. Mặc định là từ chối: Enter, Esc, đóng hộp, hết giờ đều không cho xem.
 * `repeatedAfterBlock`: hiện thêm dòng cảnh báo thiết bị từng bị ngắt. Trả về một giá trị của `CastConsentDecision`.
 */
export function askCastConsent({ viewerDevice = 'Thiết bị từ xa', timeoutSec = 45, repeatedAfterBlock = false, signal } = {}) {
  if (process.platform !== 'win32') return Promise.resolve(CastConsentDecision.UNAVAILABLE);
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let timer = null;

    const done = (answer) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(answer);
    };

    const env = {
      ...process.env,
      AIVIN_CAST_XAML: b64(CONSENT_XAML),
      AIVIN_CAST_LOGO: AIVIN_LOGO_PNG_BASE64,
      AIVIN_CAST_TITLE: b64(CAST_CONSENT_WINDOW_TITLE),
      AIVIN_CAST_DEVICE: b64(`Thiết bị yêu cầu: ${viewerDevice}`),
      AIVIN_CAST_COUNTDOWN: b64('Tự từ chối sau {0} giây'),
      AIVIN_CAST_SECONDS: String(timeoutSec),
      AIVIN_CAST_WARN: repeatedAfterBlock ? '1' : '0',
      ...humanGuardEnv(null),
    };

    let child = null;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CONSENT_SCRIPT], {
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: false,
      });
    } catch {
      return done(CastConsentDecision.UNAVAILABLE);
    }

    const kill = () => { try { child.kill(); } catch { } };
    signal?.addEventListener('abort', () => { kill(); done(CastConsentDecision.CANCELLED); }, { once: true });
    timer = setTimeout(() => { kill(); done(CastConsentDecision.TIMEOUT); }, (timeoutSec + 5) * 1000);

    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.on('error', () => done(CastConsentDecision.UNAVAILABLE));
    child.on('close', (code) => {
      if (code === 0 && /\bYes\b/.test(out)) return done(CastConsentDecision.ALLOW);
      if (/\bTimeout\b/.test(out)) return done(CastConsentDecision.TIMEOUT);
      if (/\bNo\b/.test(out)) return done(CastConsentDecision.REJECTED);
      return done(CastConsentDecision.UNAVAILABLE);
    });
  });
}
