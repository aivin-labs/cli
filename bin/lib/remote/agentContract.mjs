import { createHash } from 'crypto';
import YAML from 'yaml';

/**
 * Ba file Markdown đi giữa Agentic, daemon và agent lập trình (11/11/2026): `CONTRACT.md` (Agentic viết, bất biến), `TEST_CHECK.md` (bộ check
 * test của dự án khách, Agentic là bên duy nhất ghi), `REPORT.md` (agent viết cuối job). Mỗi file = frontmatter YAML cho máy + thân cho người
 * và AI đọc. Quy tắc giữ khuôn:
 * - frontmatter chỉ chứa giá trị ngắn (mã, enum, số, đường dẫn, đúng/sai) — câu chữ ở thân file, vì YAML hay hỏng nhất ở chuỗi tự do;
 * - mỗi ca kiểm là một khối `#### <mã> <tên>` + mỗi trường một dòng `- <nhãn>: <giá trị>` (không bảng Markdown);
 * - YAML đọc chặt: không khoá trùng, không alias, schema core (YAML 1.2 — `yes` / `on` vẫn là chữ).
 * Module này chỉ đọc + kiểm; gộp kết quả vào `TEST_CHECK.md` là việc của Agentic (BE).
 */

export const Risk = Object.freeze({ READ_ONLY: 'read_only', STANDARD: 'standard', STRICT: 'strict' });
export const CheckKind = Object.freeze({
  COMMAND_PASSED: 'command_passed', DIFF_IN_SCOPE: 'diff_in_scope', PROTECTED_UNTOUCHED: 'protected_untouched',
  TESTS_NOT_REDUCED: 'tests_not_reduced', NO_NEW_SKIPS: 'no_new_skips', CHECK_FILE_COVERED: 'check_file_covered', OUTPUTS_COMPLETE: 'outputs_complete',
});
export const ReportStatus = Object.freeze({ DONE: 'done', PARTIAL: 'partial', BLOCKED: 'blocked' });
/** Kết quả một ca trong `REPORT.md` (agent tự khai — daemon đo lại ca `auto`). */
export const CASE_RESULTS = Object.freeze(['pass', 'fail', 'blocked', 'not_tested']);
/** Trạng thái một ca trong `TEST_CHECK.md` — `stale` do Agentic đặt khi luồng đổi code sau lần `pass`. */
export const CASE_STATUSES = Object.freeze([...CASE_RESULTS, 'stale']);
/** 8 nhóm khả năng phải xét cho mỗi quy tắc. */
export const CHECK_GROUPS = Object.freeze(['main', 'boundary', 'error', 'regression', 'permission', 'legacy_data', 'concurrency', 'non_functional']);
export const CHECK_METHODS = Object.freeze(['auto', 'agent', 'manual']);
export const OUTPUT_KINDS = Object.freeze(['git_branch', 'report_md']);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES = ['plan', 'manual', 'accept_edits'];

/** Các mục bắt buộc ở thân `REPORT.md`, theo thứ tự. */
export const REPORT_SECTIONS = Object.freeze(['Đã đổi gì', 'Vì sao', 'Phần chưa làm', 'Ca kiểm mới', 'Rủi ro còn lại']);
const NOT_DONE_SECTION = 'Phần chưa làm';
const NEW_CHECKS_SECTION = 'Ca kiểm mới';

/** Nhãn trường của một khối ca kiểm → tên máy. */
const FIELD_LABELS = Object.freeze({
  'nhóm': 'group', 'ưu tiên': 'priority', 'cách kiểm': 'method', 'tình huống': 'scenario', 'mong đợi': 'expected',
  'trạng thái': 'status', job: 'job', commit: 'commit', 'bằng chứng': 'evidence',
});
const REQUIRED_CASE_FIELDS = ['group', 'priority', 'method', 'scenario', 'expected'];

const MAX_FILE_CHARS = 256 * 1024;
/** Chuỗi trong frontmatter dài hơn thế là câu chữ — phải xuống thân file. */
const MAX_SHORT_VALUE = 300;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CHECK_ID_RE = /^CK-\d{1,6}$/;
const NEW_CHECK_ID_RE = /^NEW-\d{1,4}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** Tên công cụ cho `--allowedTools`: `Read`, `Bash(npm test *)`… — không dấu xuống dòng, ngoặc không lồng. */
const TOOL_RULE_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}(\([^()\r\n]{1,200}\))?$/;
/** Shell không kèm mẫu lệnh = chạy được mọi lệnh — hợp đồng phải khai mẫu (`Bash(npm test *)`). */
const UNBOUNDED_SHELL = new Set(['Bash', 'PowerShell']);

export const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
const nfc = (s) => String(s ?? '').normalize('NFC');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Tách frontmatter (giữa hai dòng `---` ở đầu file) và thân. Không có frontmatter → `{ error }`. */
export function splitFrontmatter(text) {
  const src = nfc(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (src.length > MAX_FILE_CHARS) return { error: `file is larger than ${MAX_FILE_CHARS} characters` };
  if (!src.startsWith('---\n')) return { error: 'file must start with a frontmatter block (a line "---")' };
  const end = src.indexOf('\n---', 3);
  if (end < 0 || (src[end + 4] !== undefined && src[end + 4] !== '\n')) return { error: 'frontmatter is not closed by a line "---"' };
  return { yaml: src.slice(4, end + 1), body: src.slice(end + 5).replace(/^\n+/, '') };
}

/** Đọc YAML chặt → object, hoặc `{ errors }`. */
function parseYaml(yaml) {
  const doc = YAML.parseDocument(yaml, { schema: 'core', uniqueKeys: true, strict: true, prettyErrors: false });
  if (doc.errors.length) return { errors: doc.errors.map((e) => `frontmatter: ${e.message.split('\n')[0]}`) };
  let data;
  try { data = doc.toJS({ maxAliasCount: 0 }); } catch (e) { return { errors: [`frontmatter: ${e.message}`] }; }
  if (!isObj(data)) return { errors: ['frontmatter must be a mapping of fields'] };
  return { data };
}

/** Mọi chuỗi trong frontmatter phải ngắn, một dòng. */
function checkShortValues(value, at, errors) {
  if (typeof value === 'string') {
    if (value.includes('\n') || value.length > MAX_SHORT_VALUE) errors.push(`${at}: frontmatter holds short values only — move sentences to the body`);
  } else if (Array.isArray(value)) value.forEach((v, i) => checkShortValues(v, `${at}[${i}]`, errors));
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) checkShortValues(v, at ? `${at}.${k}` : k, errors);
}

/** Bộ kiểm trường nhỏ gọn: mỗi hàm đẩy lỗi vào `errors`, trả giá trị đã chuẩn hoá (hoặc giá trị mặc định). */
function fieldCheckers(errors) {
  const fail = (at, msg) => { errors.push(`${at}: ${msg}`); return undefined; };
  return {
    fail,
    id: (v, at, { optional = false } = {}) => (v === undefined || v === '' ? (optional ? undefined : fail(at, 'is required')) : ID_RE.test(String(v)) ? String(v) : fail(at, 'must be a short id (letters, digits, _ . -)')),
    oneOf: (v, at, list, dflt) => (v === undefined ? (dflt !== undefined ? dflt : fail(at, `is required (${list.join(' | ')})`)) : list.includes(v) ? v : fail(at, `must be one of ${list.join(' | ')}`)),
    int: (v, at, { min = 0, max = Number.MAX_SAFE_INTEGER, dflt } = {}) => (v === undefined && dflt !== undefined ? dflt : Number.isInteger(v) && v >= min && v <= max ? v : fail(at, `must be a whole number from ${min} to ${max}`)),
    num: (v, at, { min = 0, max, dflt } = {}) => (v === undefined && dflt !== undefined ? dflt : typeof v === 'number' && Number.isFinite(v) && v > min && v <= max ? v : fail(at, `must be a number above ${min}, at most ${max}`)),
    bool: (v, at, dflt) => (v === undefined && dflt !== undefined ? dflt : typeof v === 'boolean' ? v : fail(at, 'must be true or false')),
    strList: (v, at, { dflt = [], test, what = 'text' } = {}) => {
      if (v === undefined) return dflt;
      if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s || (test && !test(s)))) return fail(at, `must be a list of ${what}`);
      return v;
    },
    list: (v, at) => (v === undefined ? [] : Array.isArray(v) && v.every(isObj) ? v : fail(at, 'must be a list of mappings') || []),
    obj: (v, at, { optional = false } = {}) => (v === undefined && optional ? undefined : isObj(v) ? v : fail(at, 'must be a mapping') || {}),
  };
}

/** Đường dẫn tương đối, không thoát khỏi thư mục làm việc. */
const isRelativePath = (p) => typeof p === 'string' && !!p && !/^([a-z]:|[\\/])/i.test(p) && !p.split(/[\\/]/).includes('..');

/**
 * Đọc + kiểm `CONTRACT.md`. `expectedSha` (từ BE) phải khớp mã băm của toàn bộ file. Trả `{ ok, errors, contract, body, sha256 }` —
 * `contract` đã điền mặc định. Không ném lỗi.
 */
export function parseContract(text, { expectedSha } = {}) {
  const errors = [];
  const digest = sha256(text);
  if (expectedSha !== undefined && String(expectedSha).toLowerCase() !== digest) errors.push('contract sha256 does not match — the file is not the one Aivin issued');
  const split = splitFrontmatter(text);
  if (split.error) return { ok: false, errors: [...errors, split.error], sha256: digest };
  const parsed = parseYaml(split.yaml);
  if (parsed.errors) return { ok: false, errors: [...errors, ...parsed.errors], sha256: digest };
  const fm = parsed.data;
  checkShortValues(fm, '', errors);
  const f = fieldCheckers(errors);

  const risk = f.oneOf(fm.risk, 'risk', Object.values(Risk));
  const scopeIn = f.obj(fm.scope, 'scope', { optional: true });
  const scope = scopeIn ? {
    deny_paths: f.strList(scopeIn.deny_paths, 'scope.deny_paths', { what: 'path patterns' }) || [],
    protected_paths: f.strList(scopeIn.protected_paths, 'scope.protected_paths', { what: 'path patterns' }) || [],
  } : undefined;

  const verify = f.list(fm.verify, 'verify').map((v, i) => ({
    id: f.id(v.id, `verify[${i}].id`),
    argv: f.strList(v.argv, `verify[${i}].argv`, { dflt: undefined, what: 'command words (argv)' }),
    timeout_ms: f.int(v.timeout_ms, `verify[${i}].timeout_ms`, { min: 1000, max: 3_600_000, dflt: 300_000 }),
    report: v.report === undefined ? undefined : isRelativePath(v.report) ? v.report : f.fail(`verify[${i}].report`, 'must be a relative path inside the project'),
  }));
  verify.forEach((v, i) => { if (!v.argv?.length) errors.push(`verify[${i}].argv: is required`); });
  const verifyIds = new Set();
  for (const v of verify) { if (v.id && verifyIds.has(v.id)) errors.push(`verify: id ${v.id} is used twice`); verifyIds.add(v.id); }

  const kinds = Object.values(CheckKind);
  const acceptance = f.list(fm.acceptance, 'acceptance').map((a, i) => {
    const at = `acceptance[${i}]`;
    const item = { key: f.id(a.key, `${at}.key`), required: f.bool(a.required, `${at}.required`, true) };
    if (a.check !== undefined) item.check = f.oneOf(a.check, `${at}.check`, kinds);
    if (a.verifier !== undefined) item.verifier = f.id(a.verifier, `${at}.verifier`);
    if (!a.check && !a.verifier) errors.push(`${at}: needs check (measured by the device) or verifier (judged by Aivin)`);
    if (item.check === CheckKind.COMMAND_PASSED) {
      item.command_id = f.id(a.command_id, `${at}.command_id`);
      if (item.command_id && !verifyIds.has(item.command_id)) errors.push(`${at}.command_id: no verify command with id ${item.command_id}`);
    }
    return item;
  });

  const limitsIn = f.obj(fm.limits, 'limits', { optional: true }) || {};
  const limits = {
    max_fix_rounds: f.int(limitsIn.max_fix_rounds, 'limits.max_fix_rounds', { max: 10, dflt: 2 }),
    max_budget_usd: limitsIn.max_budget_usd === undefined
      ? f.fail('limits.max_budget_usd', 'is required (a job without a budget can spend without end)')
      : f.num(limitsIn.max_budget_usd, 'limits.max_budget_usd', { max: 200 }),
    max_wall_ms: f.int(limitsIn.max_wall_ms, 'limits.max_wall_ms', { min: 60_000, max: 12 * 3_600_000, dflt: 30 * 60_000 }),
    effort: f.oneOf(limitsIn.effort, 'limits.effort', EFFORTS, 'high'),
  };

  const permIn = f.obj(fm.permissions, 'permissions', { optional: true }) || {};
  const permissions = {
    mode: f.oneOf(permIn.mode, 'permissions.mode', MODES, risk === Risk.READ_ONLY ? 'plan' : 'manual'),
    allowed_tools: f.strList(permIn.allowed_tools, 'permissions.allowed_tools', { test: (s) => TOOL_RULE_RE.test(s), what: 'tool rules like Read or Bash(npm test *)' }) || [],
  };
  for (const t of permissions.allowed_tools) if (UNBOUNDED_SHELL.has(t)) errors.push(`permissions.allowed_tools: ${t} without a command pattern allows every command — write e.g. ${t}(npm test *)`);
  if (risk === Risk.READ_ONLY && permissions.mode !== 'plan') errors.push('permissions.mode: read_only work runs in plan mode');

  const outputs = f.list(fm.outputs, 'outputs').map((o, i) => ({
    id: f.id(o.id, `outputs[${i}].id`), kind: f.oneOf(o.kind, `outputs[${i}].kind`, OUTPUT_KINDS),
    required: f.bool(o.required, `outputs[${i}].required`, true), consumer: f.id(o.consumer, `outputs[${i}].consumer`, { optional: true }),
  }));

  const tcIn = f.obj(fm.test_check, 'test_check', { optional: true });
  const testCheck = tcIn ? {
    file_id: f.id(tcIn.file_id, 'test_check.file_id', { optional: true }),
    sha256: tcIn.sha256 === undefined || tcIn.sha256 === '' ? undefined : SHA256_RE.test(String(tcIn.sha256)) ? String(tcIn.sha256) : f.fail('test_check.sha256', 'must be 64 hex characters'),
    flows: f.strList(tcIn.flows, 'test_check.flows', { test: (s) => ID_RE.test(s), what: 'flow ids' }) || [],
  } : undefined;

  const wsIn = f.obj(fm.workspace, 'workspace', { optional: true }) || {};
  const workspace = {
    cwd: typeof wsIn.cwd === 'string' && wsIn.cwd ? wsIn.cwd : undefined,
    base_ref: wsIn.base_ref === undefined ? 'HEAD'
      : typeof wsIn.base_ref === 'string' && /^[A-Za-z0-9_./^~-]{1,100}$/.test(wsIn.base_ref) && !wsIn.base_ref.startsWith('-') ? wsIn.base_ref
        : f.fail('workspace.base_ref', 'must be a git ref') || 'HEAD',
    isolation: f.oneOf(wsIn.isolation, 'workspace.isolation', ['worktree', 'none'], 'worktree'),
  };

  // Quy tắc cứng: việc có sửa (standard / strict) phải có lệnh kiểm chứng và phạm vi.
  if (risk && risk !== Risk.READ_ONLY) {
    if (!verify.length) errors.push('verify: standard and strict work need at least one verify command');
    if (!scope) errors.push('scope: standard and strict work need a scope (deny_paths, protected_paths)');
  }
  if (!split.body.trim() || !/^# \S/m.test(split.body)) errors.push('body: needs a title line "# …" with the goal, why and criteria below it');

  const contract = {
    contract_id: f.id(fm.contract_id, 'contract_id'), version: f.int(fm.version, 'version', { min: 1 }),
    feature_group: f.id(fm.feature_group, 'feature_group', { optional: true }),
    project_id: typeof fm.project_id === 'string' ? fm.project_id : undefined, task_id: typeof fm.task_id === 'string' ? fm.task_id : undefined,
    risk, spec_refs: Array.isArray(fm.spec_refs) ? fm.spec_refs : [], depends_on: Array.isArray(fm.depends_on) ? fm.depends_on : [],
    test_check: testCheck, workspace, scope: scope || { deny_paths: [], protected_paths: [] }, verify, acceptance, limits, permissions, outputs,
  };
  return { ok: !errors.length, errors, contract, body: split.body, sha256: digest };
}

/** Các dòng H1..H4 của thân: [{ level, text, line }]. Bỏ qua phần trong khối ```. */
function headings(lines) {
  const out = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,4}) +(.+?)\s*$/.exec(l);
    if (m) out.push({ level: m[1].length, text: m[2], line: i });
  });
  return out;
}

const sameTitle = (a, b) => nfc(a).trim().toLowerCase() === nfc(b).trim().toLowerCase();

/**
 * Các khối ca kiểm dưới `## Luồng <id>` / `### BR-xx <tên>` / `#### <mã> <tên>` + dòng `- <nhãn>: <giá trị>`. `idRe`: mã hợp lệ của khối
 * (CK-… trong TEST_CHECK.md, NEW-… cho ca mới trong REPORT.md). Trả `{ flows, cases, errors }`.
 */
export function parseCheckBlocks(lines, { idRe = CHECK_ID_RE, at = 'body' } = {}) {
  const errors = [];
  const flows = [];
  const cases = [];
  let flow = null;
  let rule = null;
  let current = null;
  let fence = false;
  const closeCase = () => {
    if (!current) return;
    for (const k of REQUIRED_CASE_FIELDS) if (!current[k]) errors.push(`${at}: ${current.id} misses "${Object.keys(FIELD_LABELS).find((l) => FIELD_LABELS[l] === k)}"`);
    if (current.group && !CHECK_GROUPS.includes(current.group)) errors.push(`${at}: ${current.id} group must be one of ${CHECK_GROUPS.join(' | ')}`);
    if (current.priority && !/^p[0-3]$/.test(current.priority)) errors.push(`${at}: ${current.id} priority must be p0 … p3`);
    if (current.method && !CHECK_METHODS.includes(current.method)) errors.push(`${at}: ${current.id} method must be one of ${CHECK_METHODS.join(' | ')}`);
    if (current.status && !CASE_STATUSES.includes(current.status)) errors.push(`${at}: ${current.id} status must be one of ${CASE_STATUSES.join(' | ')}`);
    current = null;
  };
  const seen = new Set();
  lines.forEach((raw, i) => {
    const l = nfc(raw);
    if (/^\s*```/.test(l)) fence = !fence;
    if (fence) return;
    let m;
    if ((m = /^## +Luồng +([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\s*$/i.exec(l))) {
      closeCase();
      flow = { id: m[1], goal: undefined, not_applicable: undefined, rules: [] };
      rule = null;
      flows.push(flow);
    } else if ((m = /^### +(BR-\d{1,6})\b *(.*)$/.exec(l))) {
      closeCase();
      if (!flow) { errors.push(`${at} line ${i + 1}: rule ${m[1]} is outside a "## Luồng <id>" section`); return; }
      rule = { id: m[1], title: m[2].trim(), cases: [] };
      flow.rules.push(rule);
    } else if ((m = /^#### +(\S+) *(.*)$/.exec(l))) {
      closeCase();
      if (!idRe.test(m[1])) { errors.push(`${at} line ${i + 1}: "${m[1]}" is not a valid check id`); return; }
      if (!rule) { errors.push(`${at} line ${i + 1}: check ${m[1]} is outside a "### BR-xx" rule`); return; }
      if (seen.has(m[1])) errors.push(`${at}: check ${m[1]} appears twice`);
      seen.add(m[1]);
      current = { id: m[1], title: m[2].trim(), flow_id: flow.id, rule_id: rule.id };
      rule.cases.push(current);
      cases.push(current);
    } else if (/^#{1,3} /.test(l)) {
      closeCase();
    } else if (current && (m = /^- +([^:]+?) *: *(.*)$/.exec(l))) {
      const key = FIELD_LABELS[m[1].trim().toLowerCase()];
      if (!key) errors.push(`${at}: ${current.id} has an unknown field "${m[1].trim()}"`);
      else if (current[key] !== undefined) errors.push(`${at}: ${current.id} has "${m[1].trim()}" twice`);
      else current[key] = m[2].trim();
    } else if (flow && !rule && (m = /^(Mục tiêu|Không áp dụng) *: *(.*)$/i.exec(l))) {
      if (/^mục/i.test(m[1])) flow.goal = m[2].trim(); else flow.not_applicable = m[2].trim();
    }
  });
  closeCase();
  return { flows, cases, errors };
}

/** Đọc + kiểm `TEST_CHECK.md`. Trả `{ ok, errors, meta, flows, cases, sha256 }`. */
export function parseTestCheck(text) {
  const digest = sha256(text);
  const split = splitFrontmatter(text);
  if (split.error) return { ok: false, errors: [split.error], flows: [], cases: [], sha256: digest };
  const parsed = parseYaml(split.yaml);
  if (parsed.errors) return { ok: false, errors: parsed.errors, flows: [], cases: [], sha256: digest };
  const errors = [];
  checkShortValues(parsed.data, '', errors);
  const f = fieldCheckers(errors);
  const meta = { project_id: typeof parsed.data.project_id === 'string' ? parsed.data.project_id : undefined, version: f.int(parsed.data.version, 'version', { min: 1 }) };
  const blocks = parseCheckBlocks(split.body.split('\n'));
  return { ok: !errors.length && !blocks.errors.length, errors: [...errors, ...blocks.errors], meta, flows: blocks.flows, cases: blocks.cases, sha256: digest };
}

/**
 * Đọc + kiểm `REPORT.md` của agent. Frontmatter: `status`, `needs_scope_change`, `results` (mã ca → kết quả); thân đủ 5 mục, mục
 * "Phần chưa làm" không trống khi chưa `done`; ca mới trong "Ca kiểm mới" mang mã tạm `NEW-n`. Trả `{ ok, errors, report, new_checks }`.
 */
export function parseReport(text, { contractId } = {}) {
  const split = splitFrontmatter(text);
  if (split.error) return { ok: false, errors: [split.error] };
  const parsed = parseYaml(split.yaml);
  if (parsed.errors) return { ok: false, errors: parsed.errors };
  const fm = parsed.data;
  const errors = [];
  checkShortValues(fm, '', errors);
  const f = fieldCheckers(errors);
  const results = {};
  if (fm.results !== undefined && !isObj(fm.results)) errors.push('results: must be a mapping like CK-031: pass');
  for (const [id, r] of Object.entries(isObj(fm.results) ? fm.results : {})) {
    if (!CHECK_ID_RE.test(id)) errors.push(`results: "${id}" is not a check id (CK-…)`);
    else if (!CASE_RESULTS.includes(r)) errors.push(`results.${id}: must be one of ${CASE_RESULTS.join(' | ')}`);
    else results[id] = r;
  }
  const report = {
    job_id: typeof fm.job_id === 'string' ? fm.job_id : undefined,
    contract_id: typeof fm.contract_id === 'string' ? fm.contract_id : undefined,
    check_file_version: fm.check_file_version === undefined || fm.check_file_version === null ? undefined : f.int(fm.check_file_version, 'check_file_version', { min: 1 }),
    status: f.oneOf(fm.status, 'status', Object.values(ReportStatus)),
    needs_scope_change: f.bool(fm.needs_scope_change, 'needs_scope_change', false),
    results,
  };
  if (contractId && report.contract_id !== contractId) errors.push(`contract_id: must be ${contractId}`);

  const lines = split.body.split('\n');
  const h1 = headings(lines).filter((h) => h.level === 1);
  const sections = {};
  REPORT_SECTIONS.forEach((name) => {
    const at = h1.findIndex((h) => sameTitle(h.text, name));
    if (at < 0) { errors.push(`body: missing section "# ${name}"`); return; }
    const from = h1[at].line + 1;
    const to = h1[at + 1] ? h1[at + 1].line : lines.length;
    sections[name] = lines.slice(from, to);
  });
  if (report.status && report.status !== ReportStatus.DONE && !(sections[NOT_DONE_SECTION] || []).join('').trim()) {
    errors.push(`body: "# ${NOT_DONE_SECTION}" must say what is left when status is ${report.status}`);
  }
  const blocks = parseCheckBlocks(sections[NEW_CHECKS_SECTION] || [], { idRe: NEW_CHECK_ID_RE, at: NEW_CHECKS_SECTION });
  errors.push(...blocks.errors);
  return { ok: !errors.length, errors, report, new_checks: blocks.cases };
}

/** Khuôn `REPORT.md` đưa cho agent (đúng thứ tự mục; ví dụ một ca mới). */
export function reportTemplate({ jobId, contractId, checkFileVersion }) {
  return [
    '---',
    `job_id: ${jobId}`,
    `contract_id: ${contractId}`,
    ...(checkFileVersion ? [`check_file_version: ${checkFileVersion}`] : []),
    'status: done | partial | blocked',
    'needs_scope_change: false',
    'results:',
    '  CK-031: pass | fail | blocked | not_tested',
    '---',
    '',
    `# ${REPORT_SECTIONS[0]}`, '', `# ${REPORT_SECTIONS[1]}`, '', `# ${REPORT_SECTIONS[2]}`, '- (empty only when status is done)', '',
    `# ${REPORT_SECTIONS[3]}`, '', '## Luồng checkout', '', '### BR-07', '', '#### NEW-1 <short title>',
    `- nhóm: ${CHECK_GROUPS.join(' | ')}`, '- ưu tiên: p0 | p1 | p2 | p3', `- cách kiểm: ${CHECK_METHODS.join(' | ')}`,
    '- tình huống: <one line>', '- mong đợi: <one line>', '',
    `# ${REPORT_SECTIONS[4]}`, '',
  ].join('\n');
}
