import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { REMOTE_CONFIG_DIR } from '../constants.mjs';
import { AIVIN_LOGO_PNG_BASE64 } from '../brand.mjs';

export const CAST_SESSION_FILE = path.join(REMOTE_CONFIG_DIR, 'desktop-cast-session.json');
export const CAST_ACTION_FILE = path.join(REMOTE_CONFIG_DIR, 'desktop-cast-action.json');
export const CAST_PERMISSIONS_FILE = path.join(REMOTE_CONFIG_DIR, 'cast-permissions.json');

const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');

function loadPermissions() {
  try {
    if (!fs.existsSync(CAST_PERMISSIONS_FILE)) return { blockedViewers: [] };
    const content = fs.readFileSync(CAST_PERMISSIONS_FILE, 'utf8');
    const parsed = JSON.parse(content);
    return parsed && Array.isArray(parsed.blockedViewers) ? parsed : { blockedViewers: [] };
  } catch {
    return { blockedViewers: [] };
  }
}

function savePermissions(data) {
  try {
    fs.mkdirSync(path.dirname(CAST_PERMISSIONS_FILE), { recursive: true });
    fs.writeFileSync(CAST_PERMISSIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch { }
}

/**
 * Kiểm tra xem người xem / thiết bị này có đang bị chặn hoặc cần xác nhận lại quyền cast không.
 */
export function isViewerBlocked({ viewerId, viewerDevice } = {}) {
  const { blockedViewers = [] } = loadPermissions();
  return blockedViewers.some((v) => {
    if (v.viewerId && viewerId && v.viewerId === viewerId) return true;
    if (v.viewerDevice && viewerDevice && v.viewerDevice === viewerDevice) return true;
    return false;
  });
}

/**
 * Thêm thiết bị vào danh sách chặn / thu hồi quyền cast.
 */
export function blockViewer({ viewerId, viewerDevice } = {}) {
  const data = loadPermissions();
  const list = data.blockedViewers || [];
  const filtered = list.filter((v) => {
    if (viewerId && v.viewerId === viewerId) return false;
    if (viewerDevice && v.viewerDevice === viewerDevice) return false;
    return true;
  });
  filtered.push({
    viewerId: viewerId || '',
    viewerDevice: viewerDevice || '',
    blockedAt: new Date().toISOString(),
  });
  data.blockedViewers = filtered;
  savePermissions(data);
}

/**
 * Bỏ chặn / cấp quyền cho thiết bị sau khi người dùng đã bấm đồng ý trên modal.
 */
export function unblockViewer({ viewerId, viewerDevice } = {}) {
  const data = loadPermissions();
  if (!data.blockedViewers) return;
  data.blockedViewers = data.blockedViewers.filter((v) => {
    if (viewerId && v.viewerId === viewerId) return false;
    if (viewerDevice && v.viewerDevice === viewerDevice) return false;
    return true;
  });
  savePermissions(data);
}

/**
 * Ghi nhận thông tin phiên cast đang chạy để khay hệ thống (tray) đọc và hiển thị.
 */
export function recordCastSession({ active = true, sessionId = '', viewerId = '', viewerDevice = '' } = {}) {
  try {
    fs.mkdirSync(path.dirname(CAST_SESSION_FILE), { recursive: true });
    const payload = {
      active: !!active,
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
  try {
    if (!fs.existsSync(CAST_ACTION_FILE)) return null;
    const content = fs.readFileSync(CAST_ACTION_FILE, 'utf8');
    fs.unlinkSync(CAST_ACTION_FILE);
    return JSON.parse(content);
  } catch {
    return null;
  }
}

const CONSENT_XAML = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
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
   <Border Margin="0,12,0,0" HorizontalAlignment="Left" CornerRadius="10" Background="#FEF3C7" Padding="12,6">
    <TextBlock Text="⚠  Thiết bị trước đó đã bị ngắt kết nối hoặc chưa được cấp quyền" Foreground="#92400E" FontSize="12.5" FontWeight="SemiBold" TextWrapping="Wrap"/>
   </Border>
   <Border Margin="0,14,0,0" CornerRadius="10" Background="#F4F6FA" BorderBrush="#E8ECF3" BorderThickness="1" Padding="14,12">
    <StackPanel>
      <TextBlock x:Name="DeviceText" FontSize="14" FontWeight="SemiBold" Foreground="#111827" TextWrapping="Wrap"/>
      <TextBlock Text="Thiết bị này đang gửi yêu cầu xem màn hình và thao tác chuột, bàn phím trên máy tính của bạn." Margin="0,6,0,0" FontSize="12.5" Foreground="#4B5563" TextWrapping="Wrap"/>
    </StackPanel>
   </Border>
   <DockPanel Margin="0,22,0,0" LastChildFill="False">
    <TextBlock x:Name="Countdown" VerticalAlignment="Center" FontSize="12" Foreground="#6B7280"/>
    <Button x:Name="Allow" DockPanel.Dock="Right" Style="{StaticResource Btn}" Height="40" MinWidth="116" Padding="20,0" Margin="10,0,0,0"
            Background="#4E46E5" Foreground="White" BorderThickness="0" Content="_Cho phép"/>
    <Button x:Name="Reject" DockPanel.Dock="Right" Style="{StaticResource Btn}" Height="40" MinWidth="116" Padding="20,0"
            Background="White" Foreground="#111827" BorderBrush="#C9CDD4" BorderThickness="1" Content="_Từ chối" IsCancel="True" IsDefault="True"/>
   </DockPanel>
  </StackPanel>
 </Border>
</Window>`;

const CONSENT_SCRIPT = [
  'Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase',
  'function D($n) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Environment]::GetEnvironmentVariable($n))) }',
  "$w = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader ([xml](D 'AIVIN_CAST_XAML'))))",
  "$w.Title = D 'AIVIN_CAST_TITLE'",
  "$w.FindName('DeviceText').Text = D 'AIVIN_CAST_DEVICE'",
  "$ms = New-Object IO.MemoryStream(, [Convert]::FromBase64String($env:AIVIN_CAST_LOGO)); $img = New-Object Windows.Media.Imaging.BitmapImage",
  "$img.BeginInit(); $img.StreamSource = $ms; $img.CacheOption = 'OnLoad'; $img.EndInit(); $w.FindName('Logo').Source = $img",
  "$script:result = 'No'; $script:closing = $false",
  '$tm = New-Object Windows.Threading.DispatcherTimer; $tm.Interval = [TimeSpan]::FromSeconds(1)',
  "function Finish($r) { if ($script:closing) { return }; $script:closing = $true; $script:result = $r; $tm.Stop(); $w.Close() }",
  "$w.FindName('Allow').Add_Click({ Finish 'Yes' })",
  "$w.FindName('Reject').Add_Click({ Finish 'No' }); $w.FindName('Close').Add_Click({ Finish 'No' })",
  "$w.FindName('Head').Add_MouseLeftButtonDown({ $w.DragMove() })",
  "$script:left = [int]$env:AIVIN_CAST_SECONDS; $fmt = D 'AIVIN_CAST_COUNTDOWN'; $cd = $w.FindName('Countdown'); $cd.Text = $fmt -f $script:left",
  "$tm.Add_Tick({ $script:left--; $cd.Text = $fmt -f $script:left; if ($script:left -le 0) { Finish 'Timeout' } })",
  "$w.Add_ContentRendered({ $w.Activate(); [void]$w.FindName('Reject').Focus(); $tm.Start() })",
  '[void]$w.ShowDialog(); $tm.Stop(); $script:result',
].join('\n');

/**
 * Mở modal hộp thoại xác thực trên màn hình Windows hỏi người dùng có cho phép cast không.
 * Trả về true nếu người dùng chọn Cho phép, false nếu Từ chối hoặc hết giờ.
 */
export function askCastConsent({ viewerDevice = 'Thiết bị từ xa', timeoutSec = 30 } = {}) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let timer = null;

    const done = (allowed) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(allowed);
    };

    const env = {
      ...process.env,
      AIVIN_CAST_XAML: b64(CONSENT_XAML),
      AIVIN_CAST_LOGO: AIVIN_LOGO_PNG_BASE64,
      AIVIN_CAST_TITLE: b64('Aivin — Xác nhận chia sẻ màn hình'),
      AIVIN_CAST_DEVICE: b64(`Thiết bị yêu cầu: ${viewerDevice}`),
      AIVIN_CAST_COUNTDOWN: b64('Tự từ chối sau {0} giây'),
      AIVIN_CAST_SECONDS: String(timeoutSec),
    };

    let child = null;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CONSENT_SCRIPT], {
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: false,
      });
    } catch {
      return done(false);
    }

    timer = setTimeout(() => {
      try { child.kill(); } catch { }
      done(false);
    }, (timeoutSec + 5) * 1000);

    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.on('error', () => done(false));
    child.on('close', (code) => {
      const allowed = code === 0 && /\bYes\b/.test(out);
      done(allowed);
    });
  });
}
