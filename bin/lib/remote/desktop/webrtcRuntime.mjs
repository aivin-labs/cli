import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { gunzipSync } from 'zlib';
import axios from 'axios';
import { REMOTE_CONFIG_DIR } from '../constants.mjs';

/**
 * Runtime WebRTC native (`@roamhq/wrtc`) cho Desktop Scenecast. Cài qua npm → có sẵn trong node_modules. Bản một tệp (Bun) không mang được
 * thư viện native → lần đầu cần thì tải gói npm đã GHIM (phiên bản + mã băm sha512 lấy từ package-lock), kiểm băm, bung vào
 * `~/.aivin/runtime/wrtc-<bản>/node_modules`, các lần sau nạp từ đó. Tải hỏng / sai băm → không dùng, phiên xem lùi về JPEG.
 */

export const WRTC_VERSION = '0.10.0';

const REGISTRY = 'https://registry.npmjs.org';
const COMMON_PACKAGES = [
  { name: '@roamhq/wrtc', version: WRTC_VERSION, integrity: 'sha512-yFqQQ0EV1ZUHaphh3tmjoxPi2wzhW2vjmzoAVNRRLUjXYd2e1nvwi9TKfE2w4WNvNws/hBkouvOt23Xo9FkXkQ==' },
  { name: 'domexception', version: '4.0.0', integrity: 'sha512-A2is4PLG+eeSfoTMA95/s4pvAoSo2mKtiM5jlHkAVewmiO8ISFTFKZjH7UAM1Atli/OT/7JHOrJRJiMKUZKYBw==' },
  { name: 'webidl-conversions', version: '7.0.0', integrity: 'sha512-VwddBukDzu71offAQR975unBIGqfKZpM+8ZX6ySk8nYhVoo5CYaZyzt3YBvYtRtO+aoGlqxPg/B87NGVZ/fu6g==' },
];
/** Gói native theo nền tảng — Desktop Scenecast hiện chỉ Windows. */
const NATIVE_PACKAGES = {
  'win32-x64': { name: '@roamhq/wrtc-win32-x64', version: WRTC_VERSION, integrity: 'sha512-wEVXMvLrBizdLyrd+Zc7zb7zpwUuHUBXwrdIvI69e3i/AA8YsVYI2xo/sxk6GoQ+o8a14ONc4SStDS35TCjg+w==' },
};
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;

export function runtimeDir(home = REMOTE_CONFIG_DIR) {
  return path.join(home, 'runtime', `wrtc-${WRTC_VERSION}`);
}

export function runtimePackages(triple = `${os.platform()}-${os.arch()}`) {
  const native = NATIVE_PACKAGES[triple];
  return native ? [...COMMON_PACKAGES, native] : null;
}

function tarballUrl({ name, version }) {
  const base = name.split('/').pop();
  return `${REGISTRY}/${name}/-/${base}-${version}.tgz`;
}

export function integrityOk(buf, integrity) {
  const [algo, expected] = String(integrity).split('-');
  if (algo !== 'sha512' || !expected) return false;
  return createHash('sha512').update(buf).digest('base64') === expected;
}

/**
 * Bung tarball npm (ustar, đã gunzip) vào `destDir`: chỉ tệp thường dưới `package/`, bỏ đường dẫn tuyệt đối / `..` (chống ghi ra ngoài).
 */
export function extractNpmTarball(tar, destDir) {
  const root = path.resolve(destDir);
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = field(345, 155);
    let name = longName || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type !== '0' && type !== '\0') continue;
    name = name.replace(/^package\//, '');
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
}

async function fetchTarball(pkg, get) {
  const res = await get(tarballUrl(pkg), { responseType: 'arraybuffer', timeout: 120_000, maxContentLength: MAX_TARBALL_BYTES });
  const buf = Buffer.from(res.data);
  if (!integrityOk(buf, pkg.integrity)) throw new Error(`${pkg.name}: sai mã băm`);
  return buf;
}

/** Tải + kiểm + bung mọi gói vào thư mục tạm rồi đổi tên một lần (không để lại bản dở). */
export async function installRuntime({ home = REMOTE_CONFIG_DIR, triple, get = axios.get } = {}) {
  const packages = runtimePackages(triple);
  if (!packages) return false;
  const dir = runtimeDir(home);
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    for (const pkg of packages) {
      const tgz = await fetchTarball(pkg, get);
      extractNpmTarball(gunzipSync(tgz), path.join(tmp, 'node_modules', ...pkg.name.split('/')));
    }
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'aivin-wrtc-runtime', private: true }));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    return true;
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

function loadFromDir(dir, log = () => {}) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) return null;
  try {
    return createRequire(path.join(dir, 'package.json'))('@roamhq/wrtc');
  } catch (e) {
    log(`Không nạp được WebRTC runtime ở ${dir}: ${e?.message || e}`);
    return null;
  }
}

/**
 * Nạp runtime: node_modules → bản đã tải → (chưa có) tải nền một lần rồi trả `null` cho lần này (phiên đầu chạy JPEG, phiên sau có
 * WebRTC). `AIVIN_NO_WRTC_DOWNLOAD=1` tắt việc tải.
 */
export function createWebRtcRuntimeLoader({ home = REMOTE_CONFIG_DIR, importNpm = () => import('@roamhq/wrtc'), install = installRuntime, log = () => {} } = {}) {
  let installing = null;
  return async function loadWebRtcRuntime() {
    // Bản một tệp: Bun đã gói phần JS của wrtc nhưng không có tệp native — lần nhập đầu ném lỗi, lần sau trả module RỖNG (đo 02/11/2026).
    // Chỉ nhận khi thật sự có RTCPeerConnection.
    const npm = await importNpm().catch(() => null);
    const npmRuntime = npm?.RTCPeerConnection ? npm : npm?.default?.RTCPeerConnection ? npm.default : null;
    if (npmRuntime) return npmRuntime;
    const cached = loadFromDir(runtimeDir(home), log);
    if (cached) return cached;
    if (process.env.AIVIN_NO_WRTC_DOWNLOAD === '1' || !runtimePackages()) return null;
    installing ||= install({ home })
      .then((ok) => { if (ok) log('WebRTC runtime đã tải — lần xem màn hình sau dùng video trực tiếp'); })
      .catch((e) => { log(`Không tải được WebRTC runtime: ${e?.message || e} — xem màn hình dùng ảnh JPEG`); installing = null; });
    return null;
  };
}
