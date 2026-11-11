import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContract, parseReport, parseTestCheck, reportTemplate, sha256 } from '../bin/lib/remote/agentContract.mjs';
import { CONTRACT, TEST_CHECK, report } from './agentFixtures.mjs';

test('CONTRACT.md: mẫu của tài liệu hợp lệ, điền mặc định; mã băm phải khớp toàn bộ file; CRLF / BOM vẫn đọc được', () => {
  const r = parseContract(CONTRACT, { expectedSha: sha256(CONTRACT) });
  assert.deepEqual(r.errors, []);
  assert.equal(r.contract.contract_id, 'ctr_01');
  assert.equal(r.contract.risk, 'standard');
  assert.deepEqual(r.contract.verify[0], { id: 'test', argv: ['npm', 'test'], timeout_ms: 300000, report: 'junit.xml' });
  assert.deepEqual(r.contract.limits, { max_fix_rounds: 2, max_budget_usd: 3, max_wall_ms: 1800000, effort: 'high' });
  assert.deepEqual(r.contract.test_check, { file_id: 'f_1', sha256: undefined, flows: ['checkout'] });
  assert.equal(r.contract.workspace.isolation, 'worktree');
  assert.match(parseContract(CONTRACT, { expectedSha: sha256(`${CONTRACT} `) }).errors[0], /sha256 does not match/);
  assert.equal(parseContract(`\uFEFF${CONTRACT.replace(/\n/g, '\r\n')}`).ok, true);
});

test('CONTRACT.md: luật cứng — ngân sách bắt buộc, shell phải có mẫu lệnh, câu chữ không nằm ở frontmatter, YAML chặt', () => {
  const errs = (text) => parseContract(text).errors.join('\n');
  assert.match(errs(CONTRACT.replace('max_budget_usd: 3, ', '')), /max_budget_usd: is required/);
  assert.match(errs(CONTRACT.replace('"Bash(npm test *)"', 'Bash')), /Bash without a command pattern/);
  assert.match(errs(CONTRACT.replace('"Bash(npm test *)"', '"Bash(rm -rf /)\\nRead"')), /tool rules/);
  assert.match(errs(CONTRACT.replace('feature_group: bao-cao-q4', `feature_group: bao-cao-q4\nnote: "${'chữ '.repeat(100)}"`)), /short values only/);
  assert.match(errs(CONTRACT.replace('version: 1\n', 'version: 1\nversion: 2\n')), /frontmatter: .*(unique|Map keys)/i);
  assert.match(errs(CONTRACT.replace('depends_on: []', 'depends_on: &a [x]\nspec2: *a')), /alias/i);
  assert.match(errs(CONTRACT.replace(/verify:\n.*\n/, '').replace(/.*command_passed.*\n/, '')), /standard and strict work need at least one verify/);
  assert.match(errs(CONTRACT.replace('risk: standard', 'risk: read_only')), /read_only work runs in plan mode/);
  assert.match(errs(CONTRACT.replace('command_id: test', 'command_id: build')), /no verify command with id build/);
  assert.match(errs(CONTRACT.replace('report: junit.xml', 'report: ../../etc/x.xml')), /relative path inside the project/);
  assert.match(errs(CONTRACT.replace('base_ref: HEAD', 'base_ref: "--upload-pack=x"')), /must be a git ref/);
  assert.match(errs(CONTRACT.replace(/\n# Báo cáo[\s\S]*$/, '\n')), /title line/);
  assert.match(errs('# không có frontmatter'), /must start with a frontmatter block/);
});

test('TEST_CHECK.md: mẫu của tài liệu → luồng / quy tắc / ca; ca thiếu trường, nhóm lạ, ca ngoài quy tắc, mã trùng đều bị báo', () => {
  const tc = parseTestCheck(TEST_CHECK);
  assert.deepEqual(tc.errors, []);
  assert.equal(tc.meta.version, 12);
  assert.equal(tc.flows[0].id, 'checkout');
  assert.equal(tc.flows[0].not_applicable, 'permission (luồng không đổi quyền).');
  assert.deepEqual(tc.cases[0], {
    id: 'CK-031', title: 'Đơn lúc 23:30 vẫn thuộc đúng ngày', flow_id: 'checkout', rule_id: 'BR-07', group: 'boundary', priority: 'p0', method: 'auto',
    scenario: 'Tạo đơn lúc 23:30 giờ tổ chức.', expected: 'Hoá đơn ghi đúng ngày đó.', status: 'pass', job: 'job_id', commit: 'a1b2c3d', evidence: 'evidence_file_id',
  });
  // Chữ Việt dạng tổ hợp (NFD — gõ trên macOS) vẫn khớp nhãn.
  assert.equal(parseTestCheck(TEST_CHECK.normalize('NFD')).ok, true);
  const errs = (text) => parseTestCheck(text).errors.join('\n');
  assert.match(errs(TEST_CHECK.replace('- mong đợi: Hoá đơn ghi đúng ngày đó.\n', '')), /CK-031 misses "mong đợi"/);
  assert.match(errs(TEST_CHECK.replace('nhóm: boundary', 'nhóm: edge')), /group must be one of/);
  assert.match(errs(TEST_CHECK.replace('trạng thái: pass', 'trạng thái: ok')), /status must be one of/);
  assert.match(errs(TEST_CHECK.replace('### BR-07 Đơn chốt theo ngày của múi giờ tổ chức\n', '')), /outside a "### BR-xx" rule/);
  assert.match(errs(`${TEST_CHECK}\n#### CK-031 lặp\n- nhóm: main\n`), /appears twice/);
  assert.match(errs(TEST_CHECK.replace('- ưu tiên: p0', '- ưu tiên: p0\n- ghi chú: x')), /unknown field "ghi chú"/);
});

test('REPORT.md: frontmatter ngắn + 5 mục; chưa xong thì "Phần chưa làm" không trống; ca mới mang mã NEW-n; đúng hợp đồng', () => {
  const ok = parseReport(report(), { contractId: 'ctr_01' });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.report, { job_id: '', contract_id: 'ctr_01', check_file_version: 12, status: 'partial', needs_scope_change: false, results: { 'CK-031': 'pass' } });
  assert.equal(ok.new_checks[0].id, 'NEW-1');
  assert.equal(ok.new_checks[0].rule_id, 'BR-07');
  const errs = (text) => parseReport(text, { contractId: 'ctr_01' }).errors.join('\n');
  assert.match(errs(report({ left: '' })), /must say what is left when status is partial/);
  assert.equal(parseReport(report({ status: 'done', left: '' })).ok, true);
  assert.match(errs(report().replace('# Vì sao\nTheo BR-07.\n', '')), /missing section "# Vì sao"/);
  assert.match(errs(report({ results: '  CK-031: ok' })), /results\.CK-031: must be one of/);
  assert.match(errs(report({ results: '  NEW-1: pass' })), /not a check id/);
  assert.match(errs(report({ contractId: 'ctr_99' })), /contract_id: must be ctr_01/);
  assert.match(errs(report().replace('#### NEW-1', '#### CK-900')), /"CK-900" is not a valid check id/);
  assert.match(errs(report({ status: 'xong' })), /status: must be one of/);
});

test('khuôn REPORT.md đưa cho agent: điền đúng thì đọc lại được', () => {
  const filled = reportTemplate({ jobId: 'claude-1a2b3c4d', contractId: 'ctr_01', checkFileVersion: 12 })
    .replace('done | partial | blocked', 'done').replace('pass | fail | blocked | not_tested', 'pass')
    .replace(/nhóm: .*/, 'nhóm: boundary').replace(/ưu tiên: .*/, 'ưu tiên: p1').replace(/cách kiểm: .*/, 'cách kiểm: auto');
  const r = parseReport(filled, { contractId: 'ctr_01' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.report.job_id, 'claude-1a2b3c4d');
});
