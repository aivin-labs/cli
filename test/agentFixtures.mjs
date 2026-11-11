/** Mẫu ba file Markdown của job có hợp đồng — dùng chung cho test kiểm khuôn, đo bằng chứng và agent.run. */

/** Mẫu CONTRACT.md trong tài liệu thiết kế (rút gọn phần thân). */
export const CONTRACT = `---
contract_id: ctr_01
version: 1
feature_group: bao-cao-q4
project_id: ""
task_id: ""
risk: standard
spec_refs:
  - { doc: nghiep_vu, version: 12, rule_ids: [BR-07] }
depends_on: []
test_check: { file_id: "f_1", sha256: "", flows: [checkout] }
workspace: { cwd: "", base_ref: HEAD, isolation: worktree }
scope:
  deny_paths: ["**/.env*"]
  protected_paths: [package.json, "**/*.test.*", ".github/**"]
verify:
  - { id: test, argv: [npm, test], timeout_ms: 300000, report: junit.xml }
acceptance:
  - { key: tests_pass, required: true, check: command_passed, command_id: test }
  - { key: diff_in_scope, required: true, check: diff_in_scope }
  - { key: correct_timezone, required: true, verifier: llm_rubric }
limits: { max_fix_rounds: 2, max_budget_usd: 3, max_wall_ms: 1800000, effort: high }
permissions: { mode: accept_edits, allowed_tools: ["Bash(npm test *)"] }
outputs:
  - { id: code, kind: git_branch, required: true, consumer: agentic }
  - { id: report, kind: report_md, required: true, consumer: agentic }
---

# Báo cáo hiển thị đúng múi giờ tổ chức

## Mục tiêu
Báo cáo xuất ra hiển thị đúng giờ theo múi giờ tổ chức.
`;

export const TEST_CHECK = `---
project_id: ""
version: 12
---

# Mục tiêu sản phẩm
Khách đặt hàng và nhận hoá đơn đúng trong một lần thao tác.

## Luồng checkout
Mục tiêu: Hoàn tất đơn hàng và xuất hoá đơn.
Không áp dụng: permission (luồng không đổi quyền).

### BR-07 Đơn chốt theo ngày của múi giờ tổ chức

#### CK-031 Đơn lúc 23:30 vẫn thuộc đúng ngày
- nhóm: boundary
- ưu tiên: p0
- cách kiểm: auto
- tình huống: Tạo đơn lúc 23:30 giờ tổ chức.
- mong đợi: Hoá đơn ghi đúng ngày đó.
- trạng thái: pass
- job: job_id
- commit: a1b2c3d
- bằng chứng: evidence_file_id
`;

export const report = ({ status = 'partial', left = '- Chưa kiểm được thanh toán thật vì thiếu môi trường thử.', results = '  CK-031: pass', contractId = 'ctr_01' } = {}) => `---
job_id: ""
contract_id: ${contractId}
check_file_version: 12
status: ${status}
needs_scope_change: false
results:
${results}
---

# Đã đổi gì
Sửa cách chốt ngày.

# Vì sao
Theo BR-07.

# Phần chưa làm
${left}

# Ca kiểm mới

## Luồng checkout

### BR-07

#### NEW-1 Đơn đúng 00:00 thuộc ngày mới
- nhóm: boundary
- ưu tiên: p1
- cách kiểm: auto
- tình huống: Tạo đơn đúng 00:00 giờ tổ chức.
- mong đợi: Hoá đơn ghi ngày mới.

# Rủi ro còn lại
`;
