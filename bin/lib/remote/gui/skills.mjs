import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { DeviceErrorCode, REMOTE_CONFIG_DIR, ToolGroup } from '../constants.mjs';
import { DeviceToolError } from '../sandbox.mjs';
import { SEED_SKILLS } from './skillSeeds.mjs';

/**
 * Kỹ năng giao diện chạy TẤT ĐỊNH (14/11/2026) — luồng đã làm đúng một lần (thường do Planner dò ra) lưu thành các bước có MỐC nhận diện và ĐIỀU
 * KIỆN kết quả, chạy lại không cần LLM. Mỗi bước kiểm mốc trước khi bấm; lệch → dừng, trả lý do có cấu trúc (`failed_step`, `code`) để Planner /
 * BE sửa đúng bước đó rồi lưu bản mới — không bấm mù như ghi-rồi-phát-lại.
 *
 * Định dạng (Markdown, người và AI cùng đọc): frontmatter chỉ trường ngắn (`key`, `app`, `ui_lang`, `params`, `risk`, `effect`, `summary`), các bước
 * trong một khối ```yaml``` (mỗi bước một mục). Mốc dùng vai trò + tên + AutomationId; chữ hiển thị đổi theo ngôn ngữ giao diện nên mỗi kỹ năng ghi
 * `ui_lang` (cùng cách bản đồ site của AI Browser lưu theo host + ngôn ngữ). Kỹ năng ghép được (`call`), nên một kỹ năng của nhà cung cấp đăng nhập
 * (google.pick_account) dùng chung cho mọi ứng dụng.
 *
 * Nguồn: hạt giống nhúng trong mã (`skillSeeds.mjs` — bản chạy đóng gói không có thư mục) + kỹ năng trên máy (`~/.aivin/skills/*.md`, trùng key thì
 * bản trên máy thắng).
 */

const LOCAL_DIR = path.join(REMOTE_CONFIG_DIR, 'skills');
const BROWSERS = ['msedge', 'chrome', 'firefox', 'brave', 'opera', 'vivaldi'];
const DEFAULT_WAIT_MS = 8000;
const MAX_CALL_DEPTH = 4;

/** Mã kết quả của một lần chạy kỹ năng. */
export const SkillCode = Object.freeze({
  OK: 'ok',
  ANCHOR_MISSING: 'anchor_missing',
  AMBIGUOUS: 'ambiguous',
  TIMEOUT: 'timeout',
  NEEDS_HUMAN: 'needs_human',
  EXPECT_FAILED: 'expect_failed',
  ERROR: 'error',
});

/** Đọc một tệp kỹ năng: frontmatter + khối yaml đầu tiên chứa danh sách bước. */
export function parseSkill(text, source = '') {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new Error(`Skill ${source}: thiếu frontmatter`);
  const meta = YAML.parse(m[1]) || {};
  const block = m[2].match(/```ya?ml\r?\n([\s\S]*?)\r?\n```/);
  const steps = block ? YAML.parse(block[1]) : null;
  if (!meta.key || !Array.isArray(steps) || !steps.length) throw new Error(`Skill ${source}: cần key + khối yaml các bước`);
  return { ...meta, params: meta.params || [], steps, source };
}

/** Tệp kỹ năng hỏng không bị nuốt im lặng: ghi vào `errors` để gui.skills báo ra (bản đầu bỏ qua → kỹ năng "biến mất" không ai biết). */
function readDir(dir, errors) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const file = path.join(dir, f);
    try { return parseSkill(fs.readFileSync(file, 'utf8'), file); } catch (e) { errors.push({ file: f, error: String(e.message || e).slice(0, 200) }); return null; }
  }).filter(Boolean);
}

/** Mọi kỹ năng: hạt giống + trên máy (bản trên máy thắng khi trùng key). `map.errors` = tệp không đọc được. `seedDir` (test) thay hạt giống nhúng. */
export function loadSkills({ seedDir, localDir = LOCAL_DIR, seeds = SEED_SKILLS } = {}) {
  const map = new Map();
  const errors = [];
  if (seedDir) for (const s of readDir(seedDir, errors)) map.set(s.key, s);
  else for (const [file, text] of Object.entries(seeds)) {
    try { const s = parseSkill(text, file); map.set(s.key, s); } catch (e) { errors.push({ file, error: String(e.message || e).slice(0, 200) }); }
  }
  for (const s of readDir(localDir, errors)) map.set(s.key, s);
  map.errors = errors;
  return map;
}

const fill = (v, vars) => (typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? '')) : v);
const lc = (s) => String(s || '').toLowerCase();

/** Phần tử khớp mốc `{ role, name, name_contains, name_regex, aid, password }` (chữ đã điền tham số). */
export function nodeMatches(node, spec, vars = {}) {
  if (!node || !spec) return false;
  if (spec.role && lc(node.role) !== lc(spec.role)) return false;
  if (spec.name !== undefined && String(node.name || '').trim() !== fill(spec.name, vars)) return false;
  if (spec.name_contains !== undefined && !lc(node.name).includes(lc(fill(spec.name_contains, vars)))) return false;
  if (spec.name_regex !== undefined && !new RegExp(fill(spec.name_regex, vars), 'i').test(String(node.name || ''))) return false;
  if (spec.aid !== undefined && String(node.automation_id || '') !== fill(spec.aid, vars)) return false;
  if (spec.password !== undefined && !!node.password !== !!spec.password) return false;
  return true;
}

/** Phần tử đứng ngay sau một nhãn chữ trùng `label` (đọc giá trị của trường "Email: …"). */
function afterLabel(nodes, label, vars) {
  const want = fill(label, vars);
  const i = nodes.findIndex((n) => String(n.name || '').trim() === want);
  return i >= 0 ? nodes.slice(i + 1).find((n) => n.name && String(n.name).trim() !== want) : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Chạy một kỹ năng. `gui` = bộ điều khiển (createGuiController). `params` = tham số kỹ năng. Trả { ok, code, vars, trace, failed_step?, error? } —
 * không ném lỗi khi bước lệch mốc (đó là kết quả cần báo Planner), chỉ ném khi kỹ năng không tồn tại / tham số thiếu.
 */
export async function runSkill({ gui, skills, key, params = {}, ctx = {}, env = {}, depth = 0 }) {
  const skill = skills.get(key);
  if (!skill) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No skill "${key}"`);
  for (const p of skill.params) if (params[p] === undefined || params[p] === '') throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Skill ${key} needs param "${p}"`);
  const vars = { ...params };
  const trace = [];
  let win = vars.window || null;

  const observe = async () => {
    if (!win) throw Object.assign(new Error('no window yet'), { code: SkillCode.ANCHOR_MISSING });
    return gui.observe({ window: win, max_nodes: 1200 }, ctx);
  };
  const findOne = async (spec, stepNo) => {
    const obs = await observe();
    const hits = obs.nodes.filter((n) => nodeMatches(n, spec, vars) && !n.disabled);
    const visible = hits.filter((n) => !n.offscreen);
    const pool = visible.length ? visible : hits;
    if (!pool.length) throw Object.assign(new Error(`step ${stepNo}: no element matches ${JSON.stringify(spec)}`), { code: SkillCode.ANCHOR_MISSING });
    if (pool.length > 1 && !spec.first) throw Object.assign(new Error(`step ${stepNo}: ${pool.length} elements match ${JSON.stringify(spec)}`), { code: SkillCode.AMBIGUOUS, choices: pool.slice(0, 5).map((n) => `${n.role} "${n.name}"`) });
    return { node: pool[0], obs };
  };
  const waitFor = async (spec, timeoutMs, gone = false) => {
    const deadline = Date.now() + (timeoutMs || DEFAULT_WAIT_MS);
    for (;;) {
      const obs = await observe().catch(() => ({ nodes: [] }));
      const present = obs.nodes.some((n) => nodeMatches(n, spec, vars));
      if (present !== gone) return true;
      if (Date.now() > deadline) return false;
      await sleep(400);
    }
  };
  const findWindow = async (step) => {
    const procs = (step.process_any || (step.process ? [step.process] : [])).map(lc);
    const deadline = Date.now() + (step.timeout_ms || DEFAULT_WAIT_MS);
    for (;;) {
      const list = (await gui.windows({}, ctx)).windows;
      const w = list.find((x) => (!procs.length || procs.includes(lc(x.process)))
        && (!step.title_regex || new RegExp(fill(step.title_regex, vars), 'i').test(String(x.title || ''))) && !x.blocked);
      if (w) return w;
      if (Date.now() > deadline) return null;
      await sleep(500);
    }
  };

  for (let i = 0; i < skill.steps.length; i++) {
    const step = skill.steps[i];
    const kind = Object.keys(step).find((k) => ['window', 'browser', 'click', 'wait', 'wait_gone', 'read', 'collect', 'expect', 'stop_if', 'call', 'return_if', 'check_equals', 'pause'].includes(k));
    const started = Date.now();
    const rec = { step: i + 1, kind, note: step.note };
    try {
      // `unless`: trang đã ở trạng thái bước này nhắm tới (vd đã mở trang Account) → bỏ qua bước.
      if (step.unless && win) {
        const obs = await observe().catch(() => ({ nodes: [] }));
        if (obs.nodes.some((n) => nodeMatches(n, step.unless, vars))) { trace.push({ ...rec, skipped: 'unless', ms: Date.now() - started }); continue; }
      }
      if (kind === 'window' || kind === 'browser') {
        const spec = { ...(kind === 'browser' ? { process_any: BROWSERS, ...step.browser } : step.window), ...(step.timeout_ms ? { timeout_ms: step.timeout_ms } : {}) };
        let w = await findWindow({ ...spec, timeout_ms: spec.open ? 1500 : spec.timeout_ms });
        if (!w && spec.open) {
          const opened = await gui.openApp({ name: spec.open }, ctx, env);
          w = opened?.window || await findWindow(spec);
          if (spec.settle_ms) await sleep(spec.settle_ms);
        }
        if (!w) throw Object.assign(new Error(`step ${i + 1}: no window for ${JSON.stringify(spec)}`), { code: SkillCode.ANCHOR_MISSING });
        win = w.window;
        vars.window = win;
        rec.window = `${w.process} "${String(w.title || '').slice(0, 60)}"`;
      } else if (kind === 'click') {
        const { node } = await findOne(step.click, i + 1);
        await gui.act({ action: 'click', node_id: node.id }, ctx);
        rec.target = `${node.role} "${String(node.name || '').slice(0, 60)}"`;
        if (step.settle_ms) await sleep(step.settle_ms);
      } else if (kind === 'wait' || kind === 'wait_gone') {
        const ok = await waitFor(step[kind], step.timeout_ms, kind === 'wait_gone');
        if (!ok) throw Object.assign(new Error(`step ${i + 1}: ${kind} timed out for ${JSON.stringify(step[kind])}`), { code: SkillCode.TIMEOUT });
      } else if (kind === 'read') {
        const obs = await observe();
        const node = step.read.after_label ? afterLabel(obs.nodes, step.read.after_label, vars) : obs.nodes.find((n) => nodeMatches(n, step.read, vars));
        if (!node) throw Object.assign(new Error(`step ${i + 1}: nothing to read for ${JSON.stringify(step.read)}`), { code: SkillCode.ANCHOR_MISSING });
        vars[step.save] = String(node.name || node.value || '').trim();
        rec.saved = step.save;
      } else if (kind === 'collect') {
        // Chữ theo thứ tự giữa hai mốc (vd trang hạn mức: từ tiêu đề trang tới nút làm mới) — Planner / bộ hiểu hạn mức đọc tiếp.
        const obs = await observe();
        const from = step.collect.from ? obs.nodes.findIndex((n) => nodeMatches(n, step.collect.from, vars)) : 0;
        const to = step.collect.to ? obs.nodes.findIndex((n, k) => k > from && nodeMatches(n, step.collect.to, vars)) : obs.nodes.length;
        if (from < 0) throw Object.assign(new Error(`step ${i + 1}: collect start anchor missing`), { code: SkillCode.ANCHOR_MISSING });
        vars[step.save] = obs.nodes.slice(from, to < 0 ? obs.nodes.length : to).filter((n) => n.name && (!step.collect.role || lc(n.role) === lc(step.collect.role))).map((n) => String(n.name).trim());
        rec.saved = step.save;
      } else if (kind === 'expect') {
        const obs = await observe();
        const all = step.expect.all || [];
        const any = step.expect.any || [];
        const ok = all.every((s) => obs.nodes.some((n) => nodeMatches(n, s, vars))) && (!any.length || any.some((s) => obs.nodes.some((n) => nodeMatches(n, s, vars))));
        if (!ok) throw Object.assign(new Error(`step ${i + 1}: expectation not met ${JSON.stringify(step.expect)}`), { code: SkillCode.EXPECT_FAILED });
      } else if (kind === 'stop_if') {
        const obs = await observe().catch(() => ({ nodes: [] }));
        if (obs.nodes.some((n) => nodeMatches(n, step.stop_if, vars))) {
          const code = step.code || SkillCode.NEEDS_HUMAN;
          rec.ms = Date.now() - started;
          trace.push(rec);
          return { ok: false, code, vars, trace, failed_step: i + 1, error: step.message || `stopped at step ${i + 1}` };
        }
      } else if (kind === 'return_if') {
        // Đã đạt sẵn (vd đang ở đúng tài khoản) → xong, không làm các bước đổi trạng thái phía sau.
        if (lc(fill(step.return_if.equals?.[0], vars)) === lc(fill(step.return_if.equals?.[1], vars))) {
          rec.ms = Date.now() - started;
          trace.push({ ...rec, returned: true });
          return { ok: true, code: SkillCode.OK, vars, trace, early: true };
        }
      } else if (kind === 'check_equals') {
        // Điều kiện kết quả: hai giá trị phải trùng (không phân biệt hoa thường) — vd email sau khi chuyển = email đích.
        const [a, b] = (step.check_equals || []).map((v) => lc(String(fill(v, vars)).trim()));
        if (!a || a !== b) throw Object.assign(new Error(`step ${i + 1}: check failed (${a || '-'} ≠ ${b || '-'})`), { code: SkillCode.EXPECT_FAILED });
      } else if (kind === 'call') {
        if (depth >= MAX_CALL_DEPTH) throw Object.assign(new Error('skill call depth exceeded'), { code: SkillCode.ERROR });
        const args = Object.fromEntries(Object.entries(step.call.params || {}).map(([k, v]) => [k, fill(v, vars)]));
        const sub = await runSkill({ gui, skills, key: step.call.skill, params: { ...args, window: undefined }, ctx, env, depth: depth + 1 });
        rec.call = step.call.skill;
        rec.sub = sub.trace;
        if (!sub.ok) {
          rec.ms = Date.now() - started;
          trace.push(rec);
          return { ok: false, code: sub.code, vars, trace, failed_step: i + 1, error: `${step.call.skill}: ${sub.error}` };
        }
        for (const [k, v] of Object.entries(sub.vars || {})) if (k !== 'window') vars[k] = v;
      } else if (kind === 'pause') {
        await sleep(Number(step.pause) || 0);
      } else {
        throw Object.assign(new Error(`step ${i + 1}: unknown step`), { code: SkillCode.ERROR });
      }
      rec.ms = Date.now() - started;
      trace.push(rec);
    } catch (e) {
      rec.ms = Date.now() - started;
      // `optional`: bước có thể không có (trang xác nhận chỉ hiện lần đầu cấp quyền) → bỏ qua khi thiếu mốc / hết giờ chờ.
      if (step.optional && [SkillCode.ANCHOR_MISSING, SkillCode.EXPECT_FAILED, SkillCode.TIMEOUT].includes(e.code)) { trace.push({ ...rec, skipped: 'optional' }); continue; }
      trace.push(rec);
      return { ok: false, code: e.code && Object.values(SkillCode).includes(e.code) ? e.code : SkillCode.ERROR, vars, trace, failed_step: i + 1, error: String(e.message || e).slice(0, 300), choices: e.choices };
    }
  }
  return { ok: true, code: SkillCode.OK, vars, trace };
}

/** Công cụ cho Planner: liệt kê + chạy kỹ năng. Chạy kỹ năng có rủi ro (đăng xuất…) đi qua cổng duyệt như mọi công cụ có thay đổi. */
export function buildSkillTools(gui, { skillsLoader = loadSkills } = {}) {
  return [
    {
      name: 'gui.skills', group: ToolGroup.GUI, read_only: true,
      handler: async () => {
        const all = skillsLoader();
        return {
          skills: [...all.values()].map((s) => ({ key: s.key, app: s.app, ui_lang: s.ui_lang, params: s.params, risk: s.risk || 'none', summary: s.summary })),
          ...(all.errors?.length ? { unreadable: all.errors } : {}),
        };
      },
      description: 'List saved deterministic GUI skills (verified flows such as reading the signed-in account or switching account of an app). Prefer running a matching skill over planning the clicks yourself.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'gui.run_skill', group: ToolGroup.GUI,
      handler: async (a, ctx, env) => {
        const res = await runSkill({ gui, skills: skillsLoader(), key: String(a.skill || ''), params: a.params || {}, ctx, env });
        const { window: _w, ...vars } = res.vars || {};
        return { ...res, vars };
      },
      description: 'Run a saved GUI skill by key with its params, without planning each click. Every step checks its anchor first; on a mismatch it stops and returns code (anchor_missing / ambiguous / timeout / expect_failed / needs_human), failed_step and the trace, so you can do or fix that step yourself. needs_human = the person must act (e.g. a password prompt).',
      input_schema: {
        type: 'object',
        properties: { skill: { type: 'string', description: 'skill key from gui.skills' }, params: { type: 'object', description: 'skill params, e.g. {"email": "…"}' } },
        required: ['skill'],
      },
    },
  ];
}
