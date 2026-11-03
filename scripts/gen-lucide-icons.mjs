#!/usr/bin/env node
/**
 * Sinh bin/lib/remote/mascot/lucideIcons.mjs từ gói lucide-react (bộ icon web Aivin đang dùng), để linh vật vẽ đúng icon như trên web.
 * Mỗi icon gộp thành một chuỗi path (đơn vị: lưới 24 x 24) — hình tròn, chữ nhật, đường thẳng của SVG đổi về lệnh path.
 *
 *   node scripts/gen-lucide-icons.mjs [đường dẫn lucide-react, mặc định ../fe/node_modules/lucide-react]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.resolve(process.argv[2] || path.join(root, '..', 'fe', 'node_modules', 'lucide-react'));
const iconsDir = path.join(pkgDir, 'dist', 'esm', 'icons');
const out = path.join(root, 'bin', 'lib', 'remote', 'mascot', 'lucideIcons.mjs');

const key = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const n = (v) => Number(v);

function rectPath({ x = 0, y = 0, width, height, rx, ry }) {
  const [X, Y, W, H] = [n(x), n(y), n(width), n(height)];
  const RX = n(rx ?? ry ?? 0);
  const RY = n(ry ?? rx ?? 0);
  if (!RX && !RY) return `M${X} ${Y}h${W}v${H}h${-W}Z`;
  const arc = (dx, dy) => `a${RX} ${RY} 0 0 1 ${dx} ${dy}`;
  return `M${X + RX} ${Y}h${W - 2 * RX}${arc(RX, RY)}v${H - 2 * RY}${arc(-RX, RY)}h${-(W - 2 * RX)}${arc(-RX, -RY)}v${-(H - 2 * RY)}${arc(RX, -RY)}Z`;
}

function ovalPath(cx, cy, rx, ry) {
  return `M${n(cx) - n(rx)} ${n(cy)}a${n(rx)} ${n(ry)} 0 1 0 ${2 * n(rx)} 0a${n(rx)} ${n(ry)} 0 1 0 ${-2 * n(rx)} 0Z`;
}

const NUMBER = '[-+]?(?:\\d*\\.\\d+|\\d+\\.?)';
const LEADING_MOVE = new RegExp(`^\\s*m\\s*(${NUMBER})[\\s,]*(${NUMBER})[\\s,]*`);

/**
 * Mỗi <path> tính từ gốc toạ độ: `m` đầu chuỗi là toạ độ tuyệt đối, gộp chung vào một chuỗi mà giữ `m` thì nét bị lệch theo nét trước. Các cặp số ngay sau
 * `m` là lineto tương đối, nên đổi thành `M` phải chèn thêm `l`, không thì chúng thành toạ độ tuyệt đối.
 */
function absoluteStart(d) {
  const m = d.match(LEADING_MOVE);
  if (!m) return d;
  const rest = d.slice(m[0].length);
  return `M${m[1]} ${m[2]}${/^[-+.\d]/.test(rest) ? 'l' : ''}${rest}`;
}

function nodePath([tag, a]) {
  switch (tag) {
    case 'path': return absoluteStart(a.d);
    case 'circle': return ovalPath(a.cx, a.cy, a.r, a.r);
    case 'ellipse': return ovalPath(a.cx, a.cy, a.rx, a.ry);
    case 'rect': return rectPath(a);
    case 'line': return `M${n(a.x1)} ${n(a.y1)}L${n(a.x2)} ${n(a.y2)}`;
    case 'polyline':
    case 'polygon': {
      const pts = a.points.trim().split(/[\s,]+/).map(Number);
      const parts = [];
      for (let i = 0; i < pts.length; i += 2) parts.push(`${i ? 'L' : 'M'}${pts[i]} ${pts[i + 1]}`);
      return parts.join('') + (tag === 'polygon' ? 'Z' : '');
    }
    default: throw new Error(`Thẻ SVG lạ: ${tag}`);
  }
}

const icons = {};
const aliases = {};
for (const file of fs.readdirSync(iconsDir).filter((f) => f.endsWith('.js') && f !== 'index.js').sort()) {
  const src = fs.readFileSync(path.join(iconsDir, file), 'utf8');
  const name = key(file.slice(0, -3));
  const alias = src.match(/export \{ default \} from '\.\/([^']+)\.js'/);
  if (alias) { aliases[name] = key(alias[1]); continue; }
  const body = src.match(/const __iconNode = (\[[\s\S]*?\]);\s*\nconst /);
  if (!body) throw new Error(`Không đọc được ${file}`);
  // Mã của chính gói lucide-react đã cài, chạy lúc phát triển (không chạy trên máy người dùng).
  icons[name] = new Function(`return ${body[1]}`)().map(nodePath).join('');
}
for (const [a, target] of Object.entries(aliases)) if (icons[a] || !icons[target]) delete aliases[a];

const { version } = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const notice = fs.readFileSync(path.join(pkgDir, 'LICENSE'), 'utf8').trim().split(/\r?\n/).map((l) => ` * ${l}`.trimEnd()).join('\n');
fs.writeFileSync(out, `// Sinh tự động bằng scripts/gen-lucide-icons.mjs từ lucide-react ${version} — không sửa tay.
/**
 * Icon Lucide (https://lucide.dev):
 *
${notice}
 */
const ICONS = ${JSON.stringify(icons)};
const ALIASES = ${JSON.stringify(aliases)};

/** Tên icon Lucide (FileText, file-text, filetext) → chuỗi path trên lưới 24 x 24; tên lạ → null. */
export function lucidePath(name) {
  if (typeof name !== 'string') return null;
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return ICONS[key] ?? ICONS[ALIASES[key]] ?? null;
}

/** Mọi tên icon đã chuẩn hoá (dùng cho test). */
export const LUCIDE_ICON_NAMES = Object.freeze(Object.keys(ICONS));
`);
console.log(`${Object.keys(icons).length} icon, ${Object.keys(aliases).length} tên cũ, ${(fs.statSync(out).size / 1024).toFixed(0)} KB → ${path.relative(root, out)}`);
