// Khoá ký bản phát hành (Ed25519) — chạy trên máy tin cậy, KHÔNG phải máy chạy trang tải (get.aivin.vn) hay CI, và tốt nhất không phải máy
// đang ghép Device Agent ở chế độ toàn quyền (agent đọc được mọi tệp ngoài ~/.aivin, ~/.aivin-release).
//
//   node scripts/release-key.mjs <thư mục giữ khoá>     tạo khoá mới (hỏi mật khẩu, ghi tệp đã mã hoá)
//   node scripts/release-key.mjs encrypt <tệp .pem>     mã hoá tại chỗ một khoá đang để trần
//
// Mật khẩu: AIVIN_RELEASE_KEY_PASSPHRASE hoặc gõ trong terminal (không hiện chữ). Sau khi tạo: chép tệp khoá ra thiết bị rời / kho mật khẩu,
// giữ một bản sao lưu — mất khoá thì máy đã cài không tự cập nhật được nữa. Tạo xong in khoá công khai để dán vào bin/lib/releaseKeys.mjs.
// Đổi khoá: thêm khoá mới vào danh sách, phát hành một bản ký bằng khoá CŨ có cả hai khoá, rồi mới dùng khoá mới.
import { createHash, generateKeyPairSync } from 'crypto';
import fs from 'fs';
import path from 'path';
import { encryptKeyFile, encryptedPem, readPassphrase } from './release-key-file.mjs';

const [command, target] = process.argv.slice(2);
if (!command) throw new Error('Dùng: node scripts/release-key.mjs <thư mục giữ khoá> | encrypt <tệp .pem>');

if (command === 'encrypt') {
  if (!target) throw new Error('Dùng: node scripts/release-key.mjs encrypt <tệp .pem>');
  await encryptKeyFile(path.resolve(target));
  console.log(`✔ Đã mã hoá ${path.resolve(target)} — từ giờ ký phải nhập mật khẩu. Nên chép tệp sang thiết bị rời và xoá khỏi máy này.`);
} else {
  const dir = path.resolve(command);
  const passphrase = await readPassphrase({ confirm: true });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const id = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `aivin-release-${id}.pem`);
  fs.writeFileSync(file, encryptedPem(privateKey, passphrase), { mode: 0o600, flag: 'wx' });
  console.log(`✔ Khoá bí mật (đã mã hoá): ${file}`);
  console.log('  Thêm vào RELEASE_PUBLIC_KEYS trong bin/lib/releaseKeys.mjs:');
  console.log(`  { id: '${id}', key: '${raw.toString('base64')}' },`);
}
