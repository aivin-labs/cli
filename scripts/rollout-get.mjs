// Đổi đợt phát hành của bản mới nhất trên site tải: bao nhiêu % máy đang chạy tự lên (cố định theo mã máy — tăng % chỉ thêm máy).
//
//   npm run get:rollout -- <%> [<thư mục site>]
//
// rollout.json chỉ hoãn được việc tự cập nhật, không cài được gì (chữ ký mới quyết bản nào được cài) — để cả đội máy dừng lên một bản
// lỗi: đặt 0, rồi đăng bản sửa với số phiên bản cao hơn.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export function writeRollout({ site, version, percent }) {
  const tmp = path.join(site, 'rollout.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ version, percent }) + '\n');
  fs.renameSync(tmp, path.join(site, 'rollout.json'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const percent = Number(process.argv[2]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('Dùng: npm run get:rollout -- <0–100> [<thư mục site>]');
  const site = path.resolve(process.argv[3] || path.join(root, 'deploy', 'get', 'site'));
  const version = fs.readFileSync(path.join(site, 'latest.txt'), 'utf8').trim();
  writeRollout({ site, version, percent });
  console.log(`✔ ${version}: ${percent} % máy đang chạy tự lên`);
}
