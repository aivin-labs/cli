// Đăng bản build lên site tải get.aivin.vn (thư mục nginx phục vụ — deploy/get/site mặc định).
//
//   npm run build:binary && AIVIN_RELEASE_KEY_FILE=<khoá> npm run sign:release && npm run get:publish [-- <thư mục site>] [--rollout <%>]
//
// Bố cục: <site>/<version>/{aivin-*.gz, SHA256SUMS, SHA256SUMS.sig, install.ps1, install.sh}, <site>/install.{ps1,sh}, <site>/index.html,
// <site>/rollout.json, <site>/latest.txt. latest.txt ghi SAU CÙNG (đổi tên nguyên khối): bộ cài đọc nó trước, nên không bao giờ trỏ tới
// thư mục phiên bản còn đang chép dở. Thư mục phiên bản đã đăng là bất biến (CDN cache vĩnh viễn) — muốn sửa thì đăng phiên bản mới.
// Chữ ký (SHA256SUMS.sig) bắt buộc và phải kiểm được bằng khoá nhúng trong CLI: máy đã cài tự cập nhật chỉ nhận bản có chữ ký đó.
// `--rollout <%>` (mặc định 100): chỉ <%> máy đang chạy tự lên bản này (cố định theo mã máy); tăng dần bằng
// `npm run get:rollout -- <%>`. Bộ cài, `aivin update` chạy tay và máy chủ đòi bản tối thiểu không theo đợt.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RELEASE_PUBLIC_KEYS } from '../bin/lib/releaseKeys.mjs';
import { verifyReleaseSignature } from '../bin/lib/selfUpdate.mjs';
import { writeRollout } from './rollout-get.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const rolloutAt = args.indexOf('--rollout');
const positional = args.filter((a, i) => !a.startsWith('--') && i !== rolloutAt + 1);
const site = path.resolve(positional[0] || path.join(root, 'deploy', 'get', 'site'));
const dist = path.join(root, 'dist');
const version = `v${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}`;
const force = args.includes('--force');
const rollout = rolloutAt >= 0 ? Number(args[rolloutAt + 1]) : 100;
if (!Number.isFinite(rollout) || rollout < 0 || rollout > 100) throw new Error('--rollout cần số 0–100');

const sumsFile = path.join(dist, 'SHA256SUMS');
if (!fs.existsSync(sumsFile)) throw new Error('Chưa có dist/SHA256SUMS — chạy `npm run build:binary` trước.');
const sigFile = path.join(dist, 'SHA256SUMS.sig');
if (!fs.existsSync(sigFile)) throw new Error('Chưa có dist/SHA256SUMS.sig — chạy `AIVIN_RELEASE_KEY_FILE=<khoá> npm run sign:release` trước.');
verifyReleaseSignature({ version, sums: fs.readFileSync(sumsFile), sigText: fs.readFileSync(sigFile, 'utf8'), keys: RELEASE_PUBLIC_KEYS });
const assets = fs.readFileSync(sumsFile, 'utf8').trim().split('\n').map((line) => line.trim().split(/\s+\*?/)[1]).filter(Boolean);
if (assets.length < 8 && !force) {
  throw new Error(`dist/SHA256SUMS chỉ có ${assets.length} tệp — build đủ 8 nền tảng (npm run build:binary) hoặc thêm --force.`);
}

const versionDir = path.join(site, version);
if (fs.existsSync(versionDir) && !force) {
  throw new Error(`${version} đã đăng (${versionDir}) — thư mục phiên bản là bất biến; nâng version trong package.json hoặc thêm --force.`);
}
fs.mkdirSync(versionDir, { recursive: true });
for (const file of [...assets, 'SHA256SUMS', 'SHA256SUMS.sig']) fs.copyFileSync(path.join(dist, file), path.join(versionDir, file));
for (const file of ['install.ps1', 'install.sh']) {
  fs.copyFileSync(path.join(root, 'scripts', file), path.join(versionDir, file));
  fs.copyFileSync(path.join(root, 'scripts', file), path.join(site, file));
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aivin CLI</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 16px;color:#1d2129;line-height:1.5}
code,pre{font-family:ui-monospace,Consolas,monospace}pre{background:#f2f3f5;padding:12px 14px;border-radius:10px;overflow-x:auto}
h1{font-size:22px}h2{font-size:16px;margin-top:28px}.muted{color:#86909c;font-size:13px}</style></head>
<body><h1>Aivin CLI ${version}</h1>
<p>Connect a computer to Aivin so your AI agents can work with files and programs on it. No Node.js required.</p>
<h2>Windows (PowerShell)</h2><pre>irm https://get.aivin.vn/install.ps1 | iex</pre>
<h2>macOS / Linux</h2><pre>curl -fsSL https://get.aivin.vn/install.sh | sh</pre>
<p>Alpine / no curl: <code>wget -qO- https://get.aivin.vn/install.sh | sh</code></p>
<p>Then create a pairing code in Aivin (chat box &rarr; Browser menu &rarr; Add this computer) and run <code>aivin remote start --code &lt;code&gt;</code>
&mdash; or copy the one-line command Aivin shows, which installs and connects in one step.</p>
<p class="muted">Builds: ${assets.map((a) => a.replace(/\.gz$/, '')).join(', ')}. Checksums: <a href="/${version}/SHA256SUMS">${version}/SHA256SUMS</a>.</p>
</body></html>
`;
fs.writeFileSync(path.join(site, 'index.html'), page);

// Đợt phát hành ghi TRƯỚC latest.txt: máy đọc latest.txt mới không bao giờ gặp rollout.json của bản cũ (= cả đội máy lên ngay).
writeRollout({ site, version, percent: rollout });

const latestTmp = path.join(site, 'latest.txt.tmp');
fs.writeFileSync(latestTmp, `${version}\n`);
fs.renameSync(latestTmp, path.join(site, 'latest.txt'));
console.log(`✔ Đã đăng ${version} (${assets.length} bản build, ${rollout} % máy đang chạy tự lên) vào ${site}`);
