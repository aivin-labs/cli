import { spawn } from 'child_process';
import { DeviceErrorCode, ToolGroup } from './constants.mjs';
import { DeviceToolError } from './sandbox.mjs';
import { findOnPath } from '../localBrowser.mjs';

/**
 * Clipboard của máy (29/10/2026): "lấy cái tôi vừa copy", "dán kết quả vào clipboard cho tôi". Windows: chữ, ảnh (PNG), danh sách tệp đã
 * copy trong Explorer; macOS (pbpaste / pbcopy) và Linux (wl-paste / xclip / xsel): chữ.
 *
 * Không đọc nội dung app đánh dấu riêng tư — trình quản lý mật khẩu (KeePass, 1Password, Bitwarden…) đặt định dạng
 * `ExcludeClipboardContentFromMonitorProcessing` / `CanIncludeInClipboardHistory = 0` khi copy mật khẩu, chính lịch sử clipboard của Windows
 * cũng bỏ qua — ở đây cũng vậy (trả `private: true`, không có nội dung).
 */

const MAX_TEXT = 200_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

const PS_READ = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$d = [Windows.Forms.Clipboard]::GetDataObject()
$out = @{ formats = @() }
if ($d) { $out.formats = @($d.GetFormats()) }
$private = $false
if ($d -and $d.GetDataPresent('ExcludeClipboardContentFromMonitorProcessing')) { $private = $true }
if ($d -and $d.GetDataPresent('CanIncludeInClipboardHistory')) {
  $s = $d.GetData('CanIncludeInClipboardHistory')
  if ($s -is [IO.MemoryStream] -and $s.Length -ge 4) { $b = $s.ToArray(); if ([BitConverter]::ToInt32($b, 0) -eq 0) { $private = $true } }
}
if ($private) { $out.private = $true }
elseif ([Windows.Forms.Clipboard]::ContainsText()) { $out.text = [Windows.Forms.Clipboard]::GetText() }
elseif ([Windows.Forms.Clipboard]::ContainsFileDropList()) { $out.files = @([Windows.Forms.Clipboard]::GetFileDropList()) }
elseif ([Windows.Forms.Clipboard]::ContainsImage()) {
  $img = [Windows.Forms.Clipboard]::GetImage(); $ms = New-Object IO.MemoryStream
  $img.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
  $out.image = @{ mime = 'image/png'; base64 = [Convert]::ToBase64String($ms.ToArray()); width = $img.Width; height = $img.Height }
}
[Console]::Out.Write(($out | ConvertTo-Json -Compress -Depth 4))
`;

const PS_WRITE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$t = [Console]::In.ReadToEnd()
if ($t.Length -eq 0) { [Windows.Forms.Clipboard]::Clear() } else { [Windows.Forms.Clipboard]::SetText($t) }
[Console]::Out.Write('{"ok":true}')
`;

function run(cmd, args, { input, signal, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(cmd, args, { windowsHide: true });
    const out = [];
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new DeviceToolError(DeviceErrorCode.CALL_TIMEOUT, 'Clipboard timed out')); }, TIMEOUT_MS);
    const onAbort = () => { child.kill(); reject(new DeviceToolError(DeviceErrorCode.CANCELLED, 'Cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); reject(new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `Cannot reach the clipboard: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, err.trim().split(/\r?\n/).slice(-2).join(' ') || `Clipboard command failed (${code})`));
    });
    if (input !== undefined) child.stdin.end(input, 'utf8');
    else child.stdin.end();
  });
}

const ps = (script) => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script]];

/** Lệnh đọc / ghi chữ trên macOS / Linux theo công cụ có sẵn — không có → null. */
export function unixClipboardCommands({ platform = process.platform, env = process.env, onPath = (n) => findOnPath([n]) } = {}) {
  if (platform === 'darwin') return { read: ['pbpaste', []], write: ['pbcopy', []] };
  if (platform !== 'linux') return null;
  if (env.WAYLAND_DISPLAY && onPath('wl-paste') && onPath('wl-copy')) return { read: ['wl-paste', ['--no-newline']], write: ['wl-copy', []] };
  if (!env.DISPLAY) return null;
  if (onPath('xclip')) return { read: ['xclip', ['-selection', 'clipboard', '-o']], write: ['xclip', ['-selection', 'clipboard']] };
  if (onPath('xsel')) return { read: ['xsel', ['--clipboard', '--output']], write: ['xsel', ['--clipboard', '--input']] };
  return null;
}

/** `null` khi máy không có clipboard dùng được (máy chủ không màn hình, thiếu công cụ). */
export function createClipboard({ platform = process.platform, spawnImpl = spawn, unix = unixClipboardCommands({ platform }) } = {}) {
  if (platform !== 'win32' && !unix) return null;

  async function read(ctx) {
    if (platform === 'win32') {
      const [cmd, args] = ps(PS_READ);
      const res = JSON.parse((await run(cmd, args, { signal: ctx?.signal, spawnImpl })) || '{}');
      if (res.private) return { private: true, note: 'The app that copied this marked it private (e.g. a password manager) — it is not read.' };
      if (typeof res.text === 'string') return { kind: 'text', ...cutText(res.text) };
      if (Array.isArray(res.files)) return { kind: 'files', files: res.files };
      if (res.image) {
        if (res.image.base64.length * 0.75 > MAX_IMAGE_BYTES) return { kind: 'image', too_large: true, width: res.image.width, height: res.image.height };
        return { kind: 'image', image: res.image };
      }
      return { kind: 'empty' };
    }
    const text = await run(unix.read[0], unix.read[1], { signal: ctx?.signal, spawnImpl }).catch(() => '');
    return text ? { kind: 'text', ...cutText(text) } : { kind: 'empty' };
  }

  async function write(args = {}, ctx) {
    const text = String(args.text ?? '');
    if (text.length > MAX_TEXT) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Text too long for the clipboard (max ${MAX_TEXT} characters)`);
    if (platform === 'win32') {
      const [cmd, a] = ps(PS_WRITE);
      await run(cmd, a, { input: text, signal: ctx?.signal, spawnImpl });
    } else {
      await run(unix.write[0], unix.write[1], { input: text, signal: ctx?.signal, spawnImpl });
    }
    return { ok: true, chars: text.length };
  }

  return { read, write };
}

function cutText(text) {
  return text.length > MAX_TEXT ? { text: text.slice(0, MAX_TEXT), truncated: true, total_chars: text.length } : { text };
}

const schema = (properties, required = []) => ({ type: 'object', properties, required });

export function buildClipboardTools(clipboard) {
  return [
    { name: 'clipboard.read', group: ToolGroup.SYSTEM, read_only: true, handler: (_a, c) => clipboard.read(c),
      description: 'What the user has copied right now: text, an image (Windows) or the files copied in Explorer (Windows: their paths). Content a password manager marked private is never returned.',
      input_schema: schema({}) },
    { name: 'clipboard.write', group: ToolGroup.SYSTEM, handler: (a, c) => clipboard.write(a, c),
      description: 'Put text on the clipboard (replaces what the user had copied), so they can paste it anywhere.',
      input_schema: schema({ text: { type: 'string', description: 'text to copy' } }, ['text']) },
  ];
}
