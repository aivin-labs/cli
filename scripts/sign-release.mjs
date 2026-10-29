// Ký bản build: dist/SHA256SUMS → dist/SHA256SUMS.sig (Ed25519). Chạy trên máy giữ khoá bí mật, SAU `npm run build:binary`, TRƯỚC
// `npm run get:publish` (publish từ chối bản thiếu chữ ký).
//
//   AIVIN_RELEASE_KEY_FILE=<khoá .pem> npm run sign:release
//
// Ký xong tự kiểm lại bằng khoá công khai nhúng trong CLI (bin/lib/releaseKeys.mjs) — khoá không có trong danh sách thì báo lỗi, vì máy
// đã cài sẽ không nhận chữ ký đó.
import { createPrivateKey, sign } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RELEASE_PUBLIC_KEYS } from '../bin/lib/releaseKeys.mjs';
import { releaseKeyId, signedMessage, verifyReleaseSignature } from '../bin/lib/selfUpdate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keyFile = process.env.AIVIN_RELEASE_KEY_FILE;
if (!keyFile) throw new Error('Đặt AIVIN_RELEASE_KEY_FILE=<đường dẫn khoá .pem> (tạo bằng scripts/release-key.mjs).');
const version = `v${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}`;
const sumsFile = path.join(root, 'dist', 'SHA256SUMS');
if (!fs.existsSync(sumsFile)) throw new Error('Chưa có dist/SHA256SUMS — chạy `npm run build:binary` trước.');
const sums = fs.readFileSync(sumsFile);
const privateKey = createPrivateKey(fs.readFileSync(keyFile));
const sig = sign(null, signedMessage(version, sums), privateKey).toString('base64');
const body = JSON.stringify({ alg: 'ed25519', key_id: releaseKeyId(privateKey), version, sig }) + '\n';
verifyReleaseSignature({ version, sums, sigText: body, keys: RELEASE_PUBLIC_KEYS });
fs.writeFileSync(path.join(root, 'dist', 'SHA256SUMS.sig'), body);
console.log(`✔ dist/SHA256SUMS.sig — ${version}, khoá ${JSON.parse(body).key_id}`);
