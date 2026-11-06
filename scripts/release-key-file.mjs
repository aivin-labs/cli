// Khoá ký bản phát hành trên đĩa: luôn mã hoá bằng mật khẩu (PKCS#8, AES-256-CBC + PBKDF2) — tệp khoá lọt ra ngoài (agent đọc trộm, sao lưu
// máy, đồng bộ đám mây) không ký được gì khi không có mật khẩu. Mật khẩu: AIVIN_RELEASE_KEY_PASSPHRASE, không có thì hỏi trong terminal
// (không hiện chữ). Không bao giờ ghi mật khẩu ra đĩa / log.
import { createPrivateKey } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';

const MIN_PASSPHRASE = 12;

export const isEncryptedPem = (pem) => /-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(String(pem));

/** Hỏi một dòng trong terminal không hiện chữ gõ. Không có terminal → lỗi (không chờ treo). */
export function askSecret(prompt) {
  if (!process.stdin.isTTY) return Promise.reject(new Error('Cần terminal để nhập mật khẩu (hoặc đặt AIVIN_RELEASE_KEY_PASSPHRASE).'));
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = '';
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (err) reject(err); else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Người dùng đã huỷ thao tác bằng phím tắt.'));
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write('\b \b');
          }
        } else {
          value += ch;
          process.stderr.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

export async function readPassphrase({ confirm = false } = {}) {
  const fromEnv = process.env.AIVIN_RELEASE_KEY_PASSPHRASE;
  const pass = fromEnv ?? await askSecret('Mật khẩu khoá ký: ');
  if (confirm && fromEnv === undefined && pass !== await askSecret('Nhập lại mật khẩu: ')) throw new Error('Hai lần nhập không khớp.');
  if (confirm && pass.length < MIN_PASSPHRASE) throw new Error(`Mật khẩu cần ít nhất ${MIN_PASSPHRASE} ký tự.`);
  return pass;
}

export const encryptedPem = (privateKey, passphrase) => privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase });

/** Nạp khoá để ký. Khoá chưa mã hoá → từ chối, chỉ cách mã hoá (khoá trần trên máy có agent toàn quyền là khoá đã lộ). */
export async function loadReleasePrivateKey(file) {
  const pem = fs.readFileSync(file, 'utf8');
  if (!isEncryptedPem(pem)) throw new Error(`Khoá ${file} chưa mã hoá — chạy \`node scripts/release-key.mjs encrypt "${file}"\` trước khi ký.`);
  // On Windows, reuse a passphrase protected by the current user's DPAPI. This keeps
  // the normal publish.bat flow one-click after the one-time cache setup.
  const cachedFile = `${file}.passphrase.dpapi`;
  let pass = process.env.AIVIN_RELEASE_KEY_PASSPHRASE;
  if (pass === undefined && process.platform === 'win32' && fs.existsSync(cachedFile)) {
    const encodedPath = Buffer.from(cachedFile, 'utf16le').toString('base64');
    const ps = `$p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}')); $raw=Get-Content -Raw -LiteralPath $p; $raw=$raw -replace '\\s',''; $s=ConvertTo-SecureString $raw; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}`;
    pass = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trimEnd();
  }
  if (pass === undefined) pass = await readPassphrase();
  try {
    return createPrivateKey({ key: pem, format: 'pem', passphrase: pass });
  } catch (e) {
    throw new Error('Sai mật khẩu khoá ký.', { cause: e });
  }
}

/** Mã hoá tại chỗ một khoá đang để trần: ghi tệp mới cạnh bên rồi đổi tên nguyên khối (hỏng giữa chừng không mất khoá). */
export async function encryptKeyFile(file) {
  const pem = fs.readFileSync(file, 'utf8');
  if (isEncryptedPem(pem)) throw new Error(`${file} đã mã hoá.`);
  const key = createPrivateKey(pem);
  const passphrase = await readPassphrase({ confirm: true });
  const tmp = `${file}.enc-tmp`;
  fs.writeFileSync(tmp, encryptedPem(key, passphrase), { mode: 0o600, flag: 'wx' });
  // Đọc lại được bằng đúng mật khẩu rồi mới thay tệp cũ.
  createPrivateKey({ key: fs.readFileSync(tmp, 'utf8'), format: 'pem', passphrase });
  fs.renameSync(tmp, file);
}
