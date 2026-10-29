// Tạo khoá ký bản phát hành (Ed25519) — chạy MỘT lần trên máy tin cậy, KHÔNG phải máy chạy trang tải (get.aivin.vn) hay CI.
//
//   node scripts/release-key.mjs <thư mục giữ khoá bí mật>
//
// Ghi `<thư mục>/aivin-release-<mã khoá>.pem` (khoá bí mật — chép ra kho mật khẩu / USB rồi xoá khỏi máy nếu được), in khoá công khai
// để dán vào bin/lib/releaseKeys.mjs. Đổi khoá: thêm khoá mới vào danh sách, phát hành một bản ký bằng khoá CŨ có cả hai khoá, rồi mới
// dùng khoá mới — máy chưa lên bản đó chỉ tin khoá cũ.
import { createHash, generateKeyPairSync } from 'crypto';
import fs from 'fs';
import path from 'path';

const dir = process.argv[2];
if (!dir) throw new Error('Dùng: node scripts/release-key.mjs <thư mục giữ khoá bí mật>');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const id = createHash('sha256').update(raw).digest('hex').slice(0, 16);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(path.resolve(dir), `aivin-release-${id}.pem`);
fs.writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
console.log(`✔ Khoá bí mật: ${file}`);
console.log('  Thêm vào RELEASE_PUBLIC_KEYS trong bin/lib/releaseKeys.mjs:');
console.log(`  { id: '${id}', key: '${raw.toString('base64')}' },`);
