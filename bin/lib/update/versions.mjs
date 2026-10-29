import fs from 'fs';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const require = createRequire(import.meta.url);

/** Phiên bản đang chạy: tệp chạy đóng gói ghi sẵn lúc build, bản npm đọc package.json. */
export function currentCliVersion() {
  if (process.env.AIVIN_CLI_BINARY) return process.env.AIVIN_CLI_BINARY;
  try { return require('../../../package.json').version; } catch { return '0.0.0'; }
}

export const isStandaloneBinary = () => !!process.env.AIVIN_CLI_BINARY;

export function parseVersion(v) {
  const m = VERSION_RE.exec(String(v || '').trim());
  return m ? { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null;
}

/** So sánh phiên bản (`v` đầu tuỳ ý): âm / 0 / dương. Bản thử nghiệm (`-beta`) nhỏ hơn bản chính cùng số. Không đọc được → nhỏ nhất. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] - pb.parts[i];
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export const tagOf = (v) => `v${String(v).replace(/^v/, '')}`;

/** Danh sách phiên bản lấy từ ngoài (máy chủ, tệp cài đặt): bỏ mục hỏng, chuẩn hoá `vX.Y.Z`, có trần. */
export const versionList = (list, max = 50) => (Array.isArray(list) ? list.filter((v) => parseVersion(v)).slice(0, max).map(tagOf) : []);

function isMusl() {
  try { return fs.readdirSync('/lib').some((f) => f.startsWith('ld-musl-')); } catch { return false; }
}

/** Tệp x64 chạy dưới Rosetta trên Apple Silicon → lên bản arm64 gốc (như install.sh). */
function underRosetta() {
  try { return execFileSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8', timeout: 5000 }).trim() === '1'; } catch { return false; }
}

/** Tên bản build cho máy này — khớp TARGETS của scripts/build-binary.mjs. */
export function releaseAsset({ platform = process.platform, arch = process.arch, musl, rosetta } = {}) {
  const cpu = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'win32') return `aivin-windows-${cpu}.exe`;
  if (platform === 'darwin') return `aivin-darwin-${cpu === 'x64' && (rosetta ?? underRosetta()) ? 'arm64' : cpu}`;
  if (platform === 'linux') return `aivin-linux-${cpu}${(musl ?? isMusl()) ? '-musl' : ''}`;
  throw new Error(`Nền tảng ${platform} chưa có bản tự cập nhật`);
}

/** Máy nào thuộc đợt nào cố định theo (mã máy, phiên bản): tăng % chỉ thêm máy, không đổi máy đã lên. */
export function rolloutBucket(deviceId, version) {
  return parseInt(createHash('sha256').update(`${deviceId}:${tagOf(version)}`).digest('hex').slice(0, 8), 16) % 100;
}
