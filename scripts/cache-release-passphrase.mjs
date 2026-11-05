// One-time Windows setup: protect the release-key passphrase with the current user's DPAPI.
import { createPrivateKey } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { askSecret, isEncryptedPem } from './release-key-file.mjs';

if (process.platform !== 'win32') throw new Error('Tác vụ này chỉ dùng trên Windows.');
const dir = path.join(os.homedir(), '.aivin-release');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.pem') && !f.includes('.bak'));
if (files.length !== 1) throw new Error(`Cần đúng một khóa .pem trong ${dir}.`);
const keyFile = path.join(dir, files[0]);
const pem = fs.readFileSync(keyFile, 'utf8');
if (!isEncryptedPem(pem)) throw new Error('Khóa riêng chưa được mã hóa.');
const pass = await askSecret('Nhập mật khẩu khóa ký một lần để lưu an toàn trên máy này: ');
createPrivateKey({ key: pem, format: 'pem', passphrase: pass });
const out = `${keyFile}.passphrase.dpapi`;
const b64 = Buffer.from(pass, 'utf16le').toString('base64');
const ps = `$s=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}')) | ConvertTo-SecureString -AsPlainText -Force; ConvertFrom-SecureString $s`;
const encrypted = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim();
fs.writeFileSync(out, `${encrypted}\n`, { flag: 'w', mode: 0o600 });
console.log(`Đã lưu mật khẩu được Windows bảo vệ cho tài khoản hiện tại: ${out}`);
