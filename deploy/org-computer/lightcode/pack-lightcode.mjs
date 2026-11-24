#!/usr/bin/env node
/**
 * Đóng gói máy chủ LightCode (headless) cho image Cloud Computer — chạy trên máy dev/CI CÓ mã nguồn LightCode, KHÔNG chạy lúc build image
 * và KHÔNG cần mạng lúc chạy container (24/11/2026). LightCode chưa có bản Linux nên image dùng bundle server build từ mã nguồn (esbuild),
 * ghim bản bằng LIGHTCODE_VERSION + LIGHTCODE_SHA256 (Dockerfile kiểm sha256 trước khi giải nén).
 *
 *   node deploy/org-computer/lightcode/pack-lightcode.mjs --src H:/LCAgent [--out deploy/org-computer/lightcode] [--skip-bundle]
 *
 * Mặc định --out = chính thư mục này (lightcode/): Dockerfile COPY cả thư mục vào /opt/lightcode-dist/ và tìm tarball ở đó. KHÔNG dùng dist/
 * (.dockerignore loại `dist`). Tarball + lightcode.pin.json đã nằm trong .gitignore — không commit.
 *
 * Kết quả trong --out:
 *   lightcode-server-<version>.tar.gz  — index.js (bundle) + assets + package.json (type:module + dependencies native: @lydell/node-pty)
 *   lightcode.pin.json                 — { version, file, sha256, bytes, packed_at } → truyền vào docker build:
 *       --build-arg LIGHTCODE_VERSION=<version> --build-arg LIGHTCODE_SHA256=<sha256>
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Gói native phải cài bằng npm trong image (esbuild để external) — lấy đúng bản từ package.json của server. */
export const NATIVE_DEPS = Object.freeze(['@lydell/node-pty']);

export function parseArgs(argv) {
  const out = { src: '', out: HERE, skipBundle: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src') out.src = argv[++i] || '';
    else if (argv[i] === '--out') out.out = argv[++i] || out.out;
    else if (argv[i] === '--skip-bundle') out.skipBundle = true;
    else throw new Error(`Tham số lạ: ${argv[i]}`);
  }
  if (!out.src) throw new Error('Thiếu --src <thư mục gốc mã nguồn LightCode>');
  return out;
}

/**
 * Đối số + thư mục chạy của `tar` để nén stage → tarball. Tên tệp đích truyền DẠNG TƯƠNG ĐỐI (cwd = thư mục đích): GNU tar (Git Bash trên Windows)
 * hiểu "H:..." là máy từ xa ("Cannot connect to H:") nên không bao giờ đưa đường dẫn có ổ đĩa vào -f. `-C <stage>` là thư mục nên an toàn.
 */
export function buildTarInvocation({ outDir, tarballName, stageDir }) {
  return { args: ['-czf', tarballName, '-C', stageDir, '.'], cwd: path.resolve(outDir) };
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** package.json của bản đóng gói: chỉ khai báo kiểu module + gói native để `npm install --omit=dev` trong image. */
export function buildRuntimePackage(serverPkg) {
  const dependencies = {};
  for (const name of NATIVE_DEPS) {
    const ver = serverPkg?.dependencies?.[name];
    if (!ver) throw new Error(`package.json của server không khai báo ${name}`);
    dependencies[name] = ver;
  }
  return { name: 'lightcode-server-runtime', private: true, type: 'module', dependencies };
}

export function pinRecord({ version, file, sha256, bytes, now = new Date() }) {
  return { version, file: path.basename(file), sha256, bytes, packed_at: now.toISOString() };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const serverDir = path.join(path.resolve(args.src), 'server');
  const serverPkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8'));
  const version = String(serverPkg.version || '').trim();
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error(`Phiên bản server không hợp lệ: "${version}"`);
  if (!args.skipBundle) execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'bundle'], { cwd: serverDir, stdio: 'inherit', shell: process.platform === 'win32' });
  const bundle = path.join(serverDir, 'dist-bundle');
  if (!fs.existsSync(path.join(bundle, 'index.js'))) throw new Error(`Không thấy ${bundle}/index.js — chạy lại không có --skip-bundle`);

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pack-'));
  try {
    fs.cpSync(bundle, stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(buildRuntimePackage(serverPkg), null, 2) + '\n');
    fs.mkdirSync(args.out, { recursive: true });
    const tarball = path.join(path.resolve(args.out), `lightcode-server-${version}.tar.gz`);
    const tar = buildTarInvocation({ outDir: args.out, tarballName: path.basename(tarball), stageDir: stage });
    execFileSync('tar', tar.args, { cwd: tar.cwd, stdio: 'inherit' });
    const pin = pinRecord({ version, file: tarball, sha256: sha256File(tarball), bytes: fs.statSync(tarball).size });
    fs.writeFileSync(path.join(args.out, 'lightcode.pin.json'), JSON.stringify(pin, null, 2) + '\n');
    console.log(`Đã đóng gói ${pin.file} (${pin.bytes} byte)\n  --build-arg LIGHTCODE_VERSION=${pin.version} --build-arg LIGHTCODE_SHA256=${pin.sha256}`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`Lỗi: ${e?.message || e}`); process.exit(1); }
}
