#!/usr/bin/env node
/**
 * Sinh bin/lib/remote/mascot/mermaidBundle.mjs từ gói mermaid của fe (cùng thư viện web dùng vẽ sơ đồ): linh vật tự dựng sơ đồ thành ảnh ngay trên máy, không cần mạng.
 * Nén gzip + base64 để không đội kích thước CLI; chỉ giải nén khi gặp sơ đồ đầu tiên (diagramRender.mjs).
 *
 *   node scripts/gen-mermaid-bundle.mjs [đường dẫn mermaid, mặc định ../fe/node_modules/mermaid]
 */
import fs from 'fs';
import path from 'path';
import { gzipSync } from 'zlib';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.resolve(process.argv[2] || path.join(root, '..', 'fe', 'node_modules', 'mermaid'));
const out = path.join(root, 'bin', 'lib', 'remote', 'mascot', 'mermaidBundle.mjs');
const { version } = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const js = fs.readFileSync(path.join(pkgDir, 'dist', 'mermaid.min.js'));
const notice = fs.readFileSync(path.join(pkgDir, 'LICENSE'), 'utf8').trim().split(/\r?\n/).map((l) => ` * ${l}`.trimEnd()).join('\n');
fs.writeFileSync(out, `// Sinh tự động bằng scripts/gen-mermaid-bundle.mjs từ mermaid ${version} — không sửa tay.
/**
 * Mermaid (https://mermaid.js.org):
 *
${notice}
 */
export const MERMAID_VERSION = ${JSON.stringify(version)};
export const MERMAID_GZ_BASE64 = ${JSON.stringify(gzipSync(js, { level: 9 }).toString('base64'))};
`);
console.log(`mermaid ${version}: ${(js.length / 1048576).toFixed(2)} MB → ${(fs.statSync(out).size / 1048576).toFixed(2)} MB (${path.relative(root, out)})`);
