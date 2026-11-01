/**
 * `git.*` CHỈ ĐỌC chạy an toàn trên kho lạ (02/11/2026). Cấu hình của kho (`.git/config` — agent ghi được bằng fs.write / shell, hoặc kho tải
 * về) chạy được chương trình tuỳ ý ngay trong `git status` / `git diff` / `git log`: `core.fsmonitor`, `diff.external`, `diff.<x>.textconv`,
 * hook `post-index-change` khi git làm mới chỉ mục… Công cụ chỉ đọc không được hỏi xác nhận nên đây là đường chạy mã lách sàn luật.
 * - `--no-optional-locks`: status không ghi lại chỉ mục (không có hook ghi chỉ mục);
 * - `-c core.fsmonitor=false`, `-c core.hooksPath=<thiết bị rỗng>`: không chạy fsmonitor, không tìm thấy hook nào (áp cả cho kho con);
 * - diff / show / log thêm `--no-ext-diff --no-textconv`;
 * - bỏ mọi biến môi trường `GIT_*` của tiến trình (GIT_EXTERNAL_DIFF, GIT_SSH_COMMAND, GIT_CONFIG_*, GIT_DIR…), tắt hỏi mật khẩu.
 * Còn hở: `filter.<x>.clean` (kho tự khai bộ lọc qua `.gitattributes` + cấu hình) có thể chạy khi so tệp đang sửa — xem file-operations.md.
 */

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const DIFF_LIKE = new Set(['diff', 'show', 'log']);

/** argv cho `git` (đã gồm `-C <cwd>`), `sub` = lệnh con và tham số của nó. */
export function safeGitArgv(cwd, sub, { nullDevice = NULL_DEVICE } = {}) {
  const [cmd, ...rest] = sub;
  const hardened = DIFF_LIKE.has(cmd) ? [cmd, '--no-ext-diff', '--no-textconv', ...rest] : [cmd, ...rest];
  return ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${nullDevice}`, '-C', cwd, ...hardened];
}

/** Môi trường cho git: bỏ mọi `GIT_*` (Windows: tên biến không phân biệt hoa thường), thêm cờ không hỏi mật khẩu / không đọc pager. */
export function safeGitEnv(base = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(base || {})) {
    if (/^git_/i.test(key)) continue;
    out[key] = value;
  }
  return { ...out, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}
