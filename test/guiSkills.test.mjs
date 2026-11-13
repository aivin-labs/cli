import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { loadSkills, nodeMatches, parseSkill, runSkill, SkillCode, buildSkillTools } = await import('../bin/lib/remote/gui/skills.mjs');

/**
 * Giao diện giả: các "màn hình" của Antigravity + Edge, chuyển màn theo cú bấm (giống luồng chạy thật 13/11). Mỗi observe trả cây của màn hiện tại.
 */
function fakeDesktop({ signedIn = 'a@x.com', chooser = ['a@x.com', 'b@x.com'], passwordPrompt = false, consent = true } = {}) {
  const state = { ag: 'main', edge: null, signedIn, clicks: [] };
  const AG = { window: '0xA', process: 'Antigravity', title: 'Antigravity', pid: 1 };
  const EDGE = { window: '0xE', process: 'msedge', title: 'Đăng nhập - Tài khoản Google - Microsoft Edge', pid: 2 };
  const agNodes = () => ({
    main: [{ role: 'button', name: 'Settings' }, { role: 'button', name: 'New Conversation' }],
    settings: [{ role: 'button', name: 'Settings' }, { role: 'button', name: 'Models' }, { role: 'button', name: `Me ${state.signedIn}` }],
    account: [{ role: 'button', name: 'Models' }, { role: 'button', name: `Me ${state.signedIn}` }, { role: 'text', name: 'Email' }, { role: 'text', name: state.signedIn }, { role: 'button', name: 'Sign Out' }],
    models: [{ role: 'button', name: 'Models' }, { role: 'text', name: 'Models & Usage Refresh quota and credits data' }, { role: 'text', name: 'Claude and GPT models' }, { role: 'text', name: '0%' }, { role: 'button', name: 'Refresh quota and credits data' }],
    welcome: [{ role: 'text', name: 'Welcome to Antigravity!' }, { role: 'button', name: 'Continue with Google' }],
  }[state.ag]);
  const edgeNodes = () => (state.edge === 'chooser'
    ? [...(passwordPrompt ? [{ role: 'edit', name: 'Password', password: true }] : []), ...chooser.map((e) => ({ role: 'listitem', name: `User ${e}` }))]
    : state.edge === 'consent' ? [{ role: 'text', name: 'Sign in to Antigravity' }, { role: 'button', name: 'Đăng nhập' }] : []);
  let snap = 0;
  const ids = new Map();
  const tag = (nodes, w) => nodes.map((n, i) => { const id = `${++snap}.${i}`; ids.set(id, { ...n, w }); return { id, ...n }; });
  const gui = {
    windows: async () => ({ windows: [AG, ...(state.edge ? [EDGE] : [])] }),
    openApp: async () => ({ window: AG }),
    observe: async ({ window }) => ({ snapshot: snap, window: window === EDGE.window ? EDGE : AG, nodes: tag(window === EDGE.window ? edgeNodes() : agNodes(), window) }),
    act: async ({ node_id: id }) => {
      const n = ids.get(id);
      state.clicks.push(n.name);
      if (n.name === 'Settings') state.ag = 'settings';
      else if (n.name === 'Models') state.ag = 'models';
      else if (n.name.startsWith('Me ')) state.ag = 'account';
      else if (n.name === 'Sign Out') state.ag = 'welcome';
      else if (n.name === 'Continue with Google') state.edge = 'chooser';
      else if (n.name.startsWith('User ')) { state.pending = n.name.slice(5); if (consent) state.edge = 'consent'; else { state.signedIn = state.pending; state.edge = null; state.ag = 'main'; } }
      else if (n.name === 'Đăng nhập') { state.signedIn = state.pending; state.edge = null; state.ag = 'main'; }
      return { ok: true };
    },
  };
  return { gui, state };
}

const seeds = () => loadSkills({ localDir: path.join(os.tmpdir(), 'aivin-no-local-skills') });

test('định dạng kỹ năng: frontmatter + khối yaml; tệp hỏng được báo ra, không biến mất im lặng', () => {
  const s = parseSkill('---\nkey: x.y\nparams: [email]\n---\n# t\n```yaml\n- click: { role: button, name: OK }\n```\n');
  assert.equal(s.key, 'x.y');
  assert.deepEqual(s.params, ['email']);
  assert.equal(s.steps.length, 1);
  assert.throws(() => parseSkill('no frontmatter'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  fs.writeFileSync(path.join(dir, 'bad.md'), '---\nkey: a\nsummary: x: y\n---\n```yaml\n- pause: 1\n```\n');
  const all = loadSkills({ seedDir: dir, localDir: path.join(dir, 'none') });
  assert.equal(all.size, 0);
  assert.equal(all.errors[0].file, 'bad.md');
});

test('mốc: vai trò + tên nguyên văn / chứa / regex / AutomationId / ô mật khẩu, có điền tham số', () => {
  assert.equal(nodeMatches({ role: 'button', name: 'Sign Out' }, { role: 'button', name: 'Sign Out' }), true);
  assert.equal(nodeMatches({ role: 'button', name: 'Sign Out now' }, { name: 'Sign Out' }), false);
  assert.equal(nodeMatches({ role: 'listitem', name: 'User b@x.com' }, { name_contains: '{{email}}' }, { email: 'B@X.com' }), true);
  assert.equal(nodeMatches({ role: 'edit', password: true }, { password: true }), true);
  assert.equal(nodeMatches({ automation_id: 'num7Button' }, { aid: 'num7Button' }), true);
});

test('hạt giống: đủ 6 kỹ năng, đọc được', () => {
  const all = seeds();
  assert.deepEqual([...all.keys()].sort(), ['antigravity.read_account', 'antigravity.read_quota', 'antigravity.sign_in_google', 'antigravity.sign_out', 'antigravity.switch_account', 'google.pick_account']);
  assert.deepEqual(all.errors, []);
});

test('đọc tài khoản + hạn mức: không đổi gì, trả email / các dòng hạn mức', async () => {
  const { gui, state } = fakeDesktop();
  const acc = await runSkill({ gui, skills: seeds(), key: 'antigravity.read_account' });
  assert.equal(acc.ok, true, acc.error);
  assert.equal(acc.vars.signed_in_email, 'a@x.com');
  const q = await runSkill({ gui, skills: seeds(), key: 'antigravity.read_quota' });
  assert.equal(q.ok, true, q.error);
  assert.ok(q.vars.quota_lines.includes('0%'));
  assert.ok(!state.clicks.includes('Sign Out'));
});

test('chuyển tài khoản: đăng xuất → chọn tài khoản Google → xác nhận → kiểm email đích', async () => {
  const { gui, state } = fakeDesktop();
  const r = await runSkill({ gui, skills: seeds(), key: 'antigravity.switch_account', params: { email: 'b@x.com' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(state.signedIn, 'b@x.com');
  assert.deepEqual(state.clicks.filter((c) => ['Sign Out', 'Continue with Google', 'User b@x.com', 'Đăng nhập'].includes(c)), ['Sign Out', 'Continue with Google', 'User b@x.com', 'Đăng nhập']);
});

test('đã đúng tài khoản → dừng sớm, không đăng xuất', async () => {
  const { gui, state } = fakeDesktop();
  const r = await runSkill({ gui, skills: seeds(), key: 'antigravity.switch_account', params: { email: 'A@x.com' } });
  assert.equal(r.ok, true);
  assert.equal(r.early, true);
  assert.ok(!state.clicks.includes('Sign Out'));
});

test('trang xác nhận không hiện (đã cấp quyền) → bước optional bỏ qua, vẫn xong', async () => {
  const { gui, state } = fakeDesktop({ consent: false });
  const r = await runSkill({ gui, skills: seeds(), key: 'antigravity.switch_account', params: { email: 'b@x.com' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(state.signedIn, 'b@x.com');
});

test('Google đòi mật khẩu → dừng needs_human, không gõ gì', async () => {
  const { gui, state } = fakeDesktop({ passwordPrompt: true });
  const r = await runSkill({ gui, skills: seeds(), key: 'antigravity.switch_account', params: { email: 'b@x.com' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, SkillCode.NEEDS_HUMAN);
  assert.ok(!state.clicks.includes('User b@x.com'));
});

test('tài khoản đích không có trong trình duyệt → dừng anchor_missing ở đúng bước (Planner / người xử lý)', async () => {
  const { gui } = fakeDesktop({ chooser: ['a@x.com'] });
  const r = await runSkill({ gui, skills: seeds(), key: 'antigravity.switch_account', params: { email: 'c@x.com' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, SkillCode.ANCHOR_MISSING);
  assert.match(r.error, /google\.pick_account|antigravity\.sign_in_google/);
});

test('mốc trùng nhiều phần tử → ambiguous, không bấm; check_equals lệch → expect_failed', async () => {
  const skills = new Map([
    ['t.amb', parseSkill('---\nkey: t.amb\n---\n```yaml\n- window: { process: Antigravity }\n- click: { role: button, name_regex: "." }\n```\n')],
    ['t.chk', parseSkill('---\nkey: t.chk\nparams: [a]\n---\n```yaml\n- check_equals: ["{{a}}", "zzz"]\n```\n')],
  ]);
  const { gui, state } = fakeDesktop();
  const amb = await runSkill({ gui, skills, key: 't.amb' });
  assert.equal(amb.code, SkillCode.AMBIGUOUS);
  assert.equal(state.clicks.length, 0);
  const chk = await runSkill({ gui, skills, key: 't.chk', params: { a: 'x' } });
  assert.equal(chk.code, SkillCode.EXPECT_FAILED);
  await assert.rejects(runSkill({ gui, skills, key: 't.chk' }), /needs param/);
});

test('công cụ cho Planner: gui.skills chỉ đọc; gui.run_skill trả kết quả không kèm handle cửa sổ', async () => {
  const { gui } = fakeDesktop();
  const tools = buildSkillTools(gui, { skillsLoader: seeds });
  assert.equal(tools.find((t) => t.name === 'gui.skills').read_only, true);
  const list = await tools.find((t) => t.name === 'gui.skills').handler({});
  assert.ok(list.skills.some((s) => s.key === 'antigravity.switch_account' && s.risk === 'sign_out'));
  const r = await tools.find((t) => t.name === 'gui.run_skill').handler({ skill: 'antigravity.read_account' }, {}, {});
  assert.equal(r.vars.signed_in_email, 'a@x.com');
  assert.equal(r.vars.window, undefined);
});
