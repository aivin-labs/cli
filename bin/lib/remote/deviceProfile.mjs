import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { IGNORED_DIRS } from './constants.mjs';

export { REMOTE_CONFIG_DIR } from './constants.mjs';

const require = createRequire(import.meta.url);
const CLI_VERSION = (() => { try { return require('../../../package.json').version; } catch { return 'unknown'; } })();

/** Chương trình đáng biết trên máy — có thì Planner dùng được, và gói công cụ tương ứng (git…) được bật. */
const KNOWN_BINARIES = [
  'git', 'rg', 'node', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3', 'pip', 'uv', 'docker', 'kubectl', 'go', 'cargo',
  'java', 'mvn', 'gradle', 'dotnet', 'php', 'composer', 'ruby', 'ffmpeg', 'adb', 'code', 'gh', 'terraform', 'make', 'cmake',
];

/** Dấu hiệu nhận ra một dự án trong thư mục. */
const PROJECT_MARKERS = [
  ['package.json', 'node'], ['pyproject.toml', 'python'], ['requirements.txt', 'python'], ['go.mod', 'go'], ['Cargo.toml', 'rust'],
  ['pom.xml', 'java'], ['build.gradle', 'java'], ['build.gradle.kts', 'java'], ['composer.json', 'php'], ['Gemfile', 'ruby'],
  ['pubspec.yaml', 'dart'], ['CMakeLists.txt', 'cpp'],
];
const PROJECT_SCAN_DEPTH = 3;
const MAX_PROJECTS = 50;

/**
 * Chương trình có trên PATH — quét thư mục PATH một lượt (không spawn tiến trình nào), Windows thêm đuôi PATHEXT.
 */
export function detectBinaries() {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').toLowerCase().split(';').filter(Boolean)
    : [''];
  const names = new Set();
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) names.add(entry.toLowerCase());
  }
  return KNOWN_BINARIES.filter((bin) => exts.some((ext) => names.has(`${bin}${ext}`)));
}

/** Dự án trong các thư mục gốc (sâu tối đa 3 cấp): tên, đường tương đối, loại. */
export function detectProjects(roots) {
  const projects = [];
  for (const root of roots) {
    const queue = [[path.resolve(root), 0]];
    while (queue.length && projects.length < MAX_PROJECTS) {
      const [dir, depth] = queue.shift();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      const names = new Set(entries.map((e) => e.name));
      const marker = PROJECT_MARKERS.find(([file]) => names.has(file));
      const isGit = names.has('.git');
      if (marker || isGit || entries.some((e) => /\.(sln|csproj)$/i.test(e.name))) {
        const kind = marker?.[1] || (isGit ? 'git' : 'dotnet');
        projects.push({ name: path.basename(dir), path: path.relative(path.resolve(root), dir) || '.', kind: isGit && marker ? `${kind}+git` : kind });
      }
      if (depth >= PROJECT_SCAN_DEPTH) continue;
      for (const e of entries) {
        if (e.isDirectory() && !e.isSymbolicLink() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push([path.join(dir, e.name), depth + 1]);
      }
    }
  }
  return projects;
}

export function detectShell() {
  if (process.platform === 'win32') return 'powershell';
  return process.env.SHELL ? path.basename(process.env.SHELL) : 'bash';
}

/** Hồ sơ máy gửi BE lúc chào (không chứa bí mật). */
export function buildDeviceProfile(roots) {
  return {
    hostname: os.hostname(),
    platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform,
    arch: os.arch(),
    shell: detectShell(),
    node_version: process.version,
    cli_version: CLI_VERSION,
    roots: roots.map((r) => path.resolve(r)),
    binaries: detectBinaries(),
    projects: detectProjects(roots),
  };
}

/** Danh mục công cụ BE thấy (bỏ công cụ nội bộ) + dấu vân tay — BE chỉ xin bản đầy đủ khi dấu vân tay đổi. */
export function buildCatalog(tools) {
  const catalog = tools.filter((t) => !t.internal).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    read_only: !!t.read_only,
    side_effect: !t.read_only,
    destructive: !!t.destructive,
    concurrency: t.group,
  }));
  const hash = createHash('sha256').update(JSON.stringify(catalog)).digest('hex').slice(0, 32);
  return { catalog, hash };
}
