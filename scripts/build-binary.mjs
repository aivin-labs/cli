// Đóng gói CLI thành MỘT tệp chạy (không cần cài Node.js) cho bộ cài `install.ps1` / `install.sh`.
// Chạy bằng Bun: `npx bun scripts/build-binary.mjs [target...]` — mặc định đủ 8 nền tảng phát hành; ra `dist/` + `dist/SHA256SUMS`.
// Bun build chéo được mọi nền tảng từ một máy (CI chỉ cần một runner).
/* global Bun */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';

// x64 dùng bản "baseline" (không đòi AVX2): bản thường chết "Illegal instruction" trên CPU cũ / máy ảo tắt AVX2 — chậm hơn không đáng kể
// với việc của CLI (chờ mạng, chạy tiến trình con). musl cho Alpine (bản glibc không chạy được trên musl).
const TARGETS = {
  'windows-x64': { bun: 'bun-windows-x64-baseline', file: 'aivin-windows-x64.exe' },
  'windows-arm64': { bun: 'bun-windows-arm64', file: 'aivin-windows-arm64.exe' },
  'linux-x64': { bun: 'bun-linux-x64-baseline', file: 'aivin-linux-x64' },
  'linux-arm64': { bun: 'bun-linux-arm64', file: 'aivin-linux-arm64' },
  'linux-x64-musl': { bun: 'bun-linux-x64-baseline-musl', file: 'aivin-linux-x64-musl' },
  'linux-arm64-musl': { bun: 'bun-linux-arm64-musl', file: 'aivin-linux-arm64-musl' },
  'darwin-x64': { bun: 'bun-darwin-x64-baseline', file: 'aivin-darwin-x64' },
  'darwin-arm64': { bun: 'bun-darwin-arm64', file: 'aivin-darwin-arm64' },
};

// ink nạp `react-devtools-core` ngay khi khởi động (chỉ dùng khi DEV=true) — gói không cài sẵn, thay bằng bản rỗng.
const stubDevtools = {
  name: 'stub-react-devtools-core',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default { initialize() {}, connectToDevTools() {} };',
      loader: 'js',
    }));
  },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const sdkVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@aivin-labs', 'sdk', 'package.json'), 'utf8')).version;
const wanted =process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TARGETS);

fs.mkdirSync(outDir, { recursive: true });
const sums = [];
for (const key of wanted) {
  const target = TARGETS[key];
  if (!target) throw new Error(`Không biết nền tảng "${key}". Có: ${Object.keys(TARGETS).join(', ')}`);
  const outfile = path.join(outDir, target.file);
  const result = await Bun.build({
    entrypoints: [path.join(root, 'bin', 'cli.mjs')],
    compile: { target: target.bun, outfile },
    minify: true,
    plugins: [stubDevtools],
    define: {
      'process.env.AIVIN_CLI_BINARY': JSON.stringify(version),
      'process.env.AIVIN_CLI_SDK_VERSION': JSON.stringify(sdkVersion),
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Đóng gói ${key} thất bại`);
  }
  // Phát hành bản nén .gz (~1/2 dung lượng) — bộ cài tải bản nén, kiểm mã băm của chính tệp .gz rồi giải nén.
  const gz = gzipSync(fs.readFileSync(outfile), { level: 9 });
  fs.writeFileSync(`${outfile}.gz`, gz);
  const hash = createHash('sha256').update(gz).digest('hex');
  sums.push(`${hash}  ${target.file}.gz`);
  console.log(`✔ ${key}: ${target.file} (${(fs.statSync(outfile).size / 1048576).toFixed(1)} MB, .gz ${(gz.length / 1048576).toFixed(1)} MB)`);
}
fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log(`✔ dist/SHA256SUMS (${sums.length} tệp) — phiên bản ${version}`);
