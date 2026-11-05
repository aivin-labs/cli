import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { WorkFolderStatus, clearWorkFolderState, isAllowedWorkFolder, resolveWorkFolder, withExtraRoots, workFolderConfirmText } = await import('../bin/lib/remote/workFolder.mjs');
const { loadMascotSettings, saveMascotSettings } = await import('../bin/lib/remote/mascot/index.mjs');
const { loadDeviceCredentials, saveDeviceCredentials } = await import('../bin/lib/remote/credentials.mjs');
const { createMascotChat } = await import('../bin/lib/remote/mascot/ask.mjs');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-wf-')));
const never = async () => { throw new Error('không được hỏi'); };

test('thư mục trong quyền: dùng luôn, không hỏi', async () => {
  const root = tmp();
  const inside = path.join(root, 'con');
  fs.mkdirSync(inside);
  assert.deepEqual(await resolveWorkFolder(inside, { roots: [root], confirm: never }), { status: WorkFolderStatus.OK, path: inside });
});

test('thư mục ngoài quyền: chỉ mở khi chủ máy đồng ý', async () => {
  const root = tmp();
  const other = tmp();
  const asked = [];
  const yes = await resolveWorkFolder(other, { roots: [root], confirm: async (p) => { asked.push(p); return true; } });
  assert.deepEqual(yes, { status: WorkFolderStatus.NEEDS_ROOT, path: other });
  assert.deepEqual(asked, [other]);
  const no = await resolveWorkFolder(other, { roots: [root], confirm: async () => false });
  assert.equal(no.status, WorkFolderStatus.DENIED);
});

test('không hỏi với thứ đồng ý cũng không dùng được: không tồn tại, là tệp, ổ mạng, thư mục cấu hình Aivin', async () => {
  const root = tmp();
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'x');
  for (const bad of [path.join(root, 'khong-co'), file, '\\\\server\\share']) {
    assert.equal((await resolveWorkFolder(bad, { roots: [root], confirm: never })).status, WorkFolderStatus.DENIED, bad);
  }
  const home = process.env.AIVIN_REMOTE_HOME;
  assert.equal((await resolveWorkFolder(home, { roots: [root], confirm: never })).status, WorkFolderStatus.DENIED);
});

test('khôi phục lúc khởi động: thư mục đã bị thu quyền hoặc đã xoá thì bỏ', () => {
  const root = tmp();
  assert.equal(isAllowedWorkFolder(root, [root]), true);
  assert.equal(isAllowedWorkFolder(tmp(), [root]), false);
  assert.equal(isAllowedWorkFolder(path.join(root, 'khong-co'), [root]), false);
});

test('danh sách thư mục: giữ thứ tự gốc, thêm phần đã đồng ý, không trùng, bỏ giá trị lạ', () => {
  const a = path.resolve('a');
  const b = path.resolve('b');
  assert.deepEqual(withExtraRoots([a], [b, a, '', 3]), [a, b]);
  assert.deepEqual(withExtraRoots([a], undefined), [a]);
});

test('hộp xác nhận nêu đúng thư mục, nhắc chỉ đồng ý khi chính mình chọn', () => {
  const vi = workFolderConfirmText('D:\\x', 'vi');
  assert.match(vi.detail, /D:\\x/);
  assert.match(vi.reason, /chính bạn/);
  assert.match(workFolderConfirmText('D:\\x', 'zz').reason, /yourself/);
});

test('gỡ cài đặt: bỏ yêu cầu còn chờ, thư mục làm việc, quyền đã đồng ý; giữ ghép máy và thư mục gốc', () => {
  const dir = tmp();
  const attachDir = path.join(dir, 'attach');
  fs.mkdirSync(attachDir);
  fs.writeFileSync(path.join(attachDir, '1.workdir'), 'D:\\x');
  const settingsFile = path.join(dir, 'm.json');
  saveMascotSettings({ work_dir: 'D:\\x', x: 1, y: 2 }, settingsFile);
  const base = path.resolve('goc');
  const granted = path.resolve('da-dong-y');
  saveDeviceCredentials({ device_id: 'd1', device_token: 't', server_url: 'http://x', roots: [base, granted], extra_roots: [granted] });

  clearWorkFolderState({ attachDir, settingsFile });

  assert.equal(fs.existsSync(attachDir), false);
  const settings = loadMascotSettings(settingsFile);
  assert.equal(settings.work_dir, undefined);
  assert.equal(settings.x, 1);
  const creds = loadDeviceCredentials();
  assert.equal(creds.device_id, 'd1');
  assert.deepEqual(creds.roots, [base]);
  assert.equal('extra_roots' in creds, false);
});

function fakeChat() {
  const sent = [];
  const emitted = [];
  const saved = [];
  const socket = {
    connected: true,
    timeout: () => ({ emitWithAck: async (_e, payload) => { emitted.push(payload); return { ok: true, session_id: 's' }; } }),
  };
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi', onWorkDir: (d) => saved.push(d) });
  return { chat, sent, emitted, saved, files: () => sent.filter((c) => c.t === 'ask_files').at(-1) };
}

test('ô hỏi: thư mục làm việc đi kèm mọi câu, chip ghim không tính là tệp chờ, × thì bỏ và lưu lại', async () => {
  const { chat, emitted, saved, files } = fakeChat();
  chat.setWorkDir('D:\\du-an');
  assert.deepEqual(saved, ['D:\\du-an']);
  assert.equal(files().n, 0);
  assert.equal(files().files[0].pinned, true);
  assert.equal(files().files[0].kind, 'folder');
  assert.match(files().files[0].name, /Làm việc ở: du-an/);
  await chat.ask('câu một');
  assert.equal(emitted[0].working_dir, 'D:\\du-an');
  chat.detach('D:\\du-an');
  assert.equal(chat.workDir(), null);
  assert.deepEqual(saved, ['D:\\du-an', null]);
  assert.equal(files().files.length, 0);
});

test('ô hỏi: khôi phục im lặng (không lưu lại); tệp đính kèm gửi xong vẫn còn chip thư mục', async () => {
  const { chat, emitted, saved, files } = fakeChat();
  chat.setWorkDir('D:\\du-an', { quiet: true });
  assert.deepEqual(saved, []);
  chat.attach(['D:\\du-an\\a.docx']);
  assert.equal(files().n, 1);
  assert.equal(files().files.length, 2);
  await chat.reply('xem giúp');
  assert.equal(emitted[0].working_dir, 'D:\\du-an');
  assert.equal(files().n, 0);
  assert.deepEqual(files().files.map((c) => c.pinned), [true]);
});

test('ô hỏi: không có thư mục làm việc thì không gửi trường này', async () => {
  const { chat, emitted } = fakeChat();
  await chat.ask('hỏi');
  assert.equal('working_dir' in emitted[0], false);
});
