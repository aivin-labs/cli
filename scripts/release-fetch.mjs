// Lấy bản build do CI tạo (GitHub Release của tag, `.github/workflows/release.yml` — build sạch bằng `npm ci`) về dist/ để ký, thay vì
// build trên máy giữ khoá ký. Cần GitHub CLI (`gh`) đã đăng nhập.
//
//   npm run release:fetch -- v1.0.9
//   AIVIN_RELEASE_KEY_FILE=<khoá> npm run sign:release && npm run get:publish
//
// Kiểm: tag khớp package.json (sign:release / get:publish lấy phiên bản từ đó), đủ 8 bản build, mã SHA-256 của từng tệp khớp SHA256SUMS
// CI đã tính. Không tin SHA256SUMS mù quáng: tính lại từ tệp đã tải rồi ghi lại.
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = process.env.AIVIN_CLI_REPO || 'aivin-labs/cli';
const EXPECTED_ASSETS = 8;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+/.test(tag || '')) throw new Error('Dùng: npm run release:fetch -- v<phiên bản>');
const pkg = `v${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}`;
if (pkg !== tag) throw new Error(`Tag ${tag} khác package.json (${pkg}) — checkout đúng commit của tag rồi chạy lại.`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-release-fetch-'));
try {
  execFileSync('gh', ['release', 'download', tag, '--repo', REPO, '--dir', tmp, '--pattern', 'aivin-*.gz', '--pattern', 'SHA256SUMS'], { stdio: 'inherit' });
  const sums = fs.readFileSync(path.join(tmp, 'SHA256SUMS'), 'utf8');
  const lines = sums.trim().split(/\r?\n/).map((l) => l.trim().split(/\s+\*?/)).filter(([h, f]) => /^[0-9a-f]{64}$/i.test(h) && f);
  if (lines.length < EXPECTED_ASSETS) throw new Error(`SHA256SUMS của ${tag} chỉ có ${lines.length} bản build (cần ${EXPECTED_ASSETS}).`);
  for (const [hash, file] of lines) {
    const actual = createHash('sha256').update(fs.readFileSync(path.join(tmp, file))).digest('hex');
    if (actual !== hash.toLowerCase()) throw new Error(`${file} không khớp SHA256SUMS của CI — dừng, không ký.`);
  }
  fs.mkdirSync(dist, { recursive: true });
  for (const [, file] of lines) fs.copyFileSync(path.join(tmp, file), path.join(dist, file));
  fs.writeFileSync(path.join(dist, 'SHA256SUMS'), lines.map(([h, f]) => `${h.toLowerCase()}  ${f}`).join('\n') + '\n');
  fs.rmSync(path.join(dist, 'SHA256SUMS.sig'), { force: true });
  console.log(`✔ dist/: ${lines.length} bản build của ${tag} từ CI, mã băm khớp — tiếp: AIVIN_RELEASE_KEY_FILE=<khoá> npm run sign:release`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
