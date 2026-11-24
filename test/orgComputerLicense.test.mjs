import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const {
  LICENSE_RENEW_EVENT,
  DEFAULT_LICENSE_FILE,
  TICKET_PREFIX,
  TICKET_MAX_LENGTH,
  RenewReason,
  licenseFilePath,
  validateRenewPayload,
  writeLicenseFile,
  createLicenseRenewHandler,
} = await import('../bin/lib/remote/orgComputerLicense.mjs');

// ─── Hằng số ───────────────────────────────────────────────────────────────

test('hằng: tên sự kiện, tiền tố vé, đường dẫn mặc định', () => {
  assert.equal(LICENSE_RENEW_EVENT, 'org_computer.license_renew');
  assert.equal(DEFAULT_LICENSE_FILE, '/var/lib/aivin-lc/lightcode-license.key');
  assert.equal(TICKET_PREFIX, 'LCA1.');
  assert.equal(typeof TICKET_MAX_LENGTH, 'number');
  assert.ok(TICKET_MAX_LENGTH >= 100);
});

test('licenseFilePath: ưu tiên env AIVIN_LIGHTCODE_LICENSE_FILE, fallback về mặc định', () => {
  assert.equal(licenseFilePath({}), DEFAULT_LICENSE_FILE);
  assert.equal(licenseFilePath({ AIVIN_LIGHTCODE_LICENSE_FILE: '/tmp/my.key' }), '/tmp/my.key');
  assert.equal(licenseFilePath({ AIVIN_LIGHTCODE_LICENSE_FILE: '  ' }), DEFAULT_LICENSE_FILE, 'chuỗi trắng → mặc định');
});

// ─── validateRenewPayload ───────────────────────────────────────────────────

const GOOD_TOKEN = 'LCA1.validToken123_~';
const NOW = Date.now();
const FUTURE = NOW + 60_000;

test('validateRenewPayload: token hợp lệ, không có expiresAt → ok', () => {
  const r = validateRenewPayload({ token: GOOD_TOKEN });
  assert.equal(r.ok, true);
  assert.equal(r.token, GOOD_TOKEN);
});

test('validateRenewPayload: token hợp lệ + expiresAt tương lai → ok', () => {
  assert.equal(validateRenewPayload({ token: GOOD_TOKEN, expiresAt: new Date(FUTURE).toISOString() }).ok, true);
  assert.equal(validateRenewPayload({ token: GOOD_TOKEN, expiresAt: FUTURE }).ok, true);
});

test('validateRenewPayload: payload sai kiểu → bad_payload', () => {
  assert.equal(validateRenewPayload(null).reason, RenewReason.BAD_PAYLOAD);
  assert.equal(validateRenewPayload([]).reason, RenewReason.BAD_PAYLOAD);
  assert.equal(validateRenewPayload('string').reason, RenewReason.BAD_PAYLOAD);
  assert.equal(validateRenewPayload(undefined).reason, RenewReason.BAD_PAYLOAD);
});

test('validateRenewPayload: token thiếu hoặc sai định dạng → bad_token', () => {
  assert.equal(validateRenewPayload({ token: '' }).reason, RenewReason.BAD_TOKEN, 'rỗng');
  assert.equal(validateRenewPayload({ token: 'WRONG.format' }).reason, RenewReason.BAD_TOKEN, 'không bắt đầu LCA1.');
  assert.equal(validateRenewPayload({ token: 'LCA1.' + 'x'.repeat(TICKET_MAX_LENGTH) }).reason, RenewReason.BAD_TOKEN, 'quá dài');
  assert.equal(validateRenewPayload({ token: 'LCA1.has space' }).reason, RenewReason.BAD_TOKEN, 'ký tự cấm');
  assert.equal(validateRenewPayload({}).reason, RenewReason.BAD_TOKEN, 'thiếu token');
});

test('validateRenewPayload: expiresAt đã qua → expired', () => {
  const past = NOW - 1000;
  assert.equal(validateRenewPayload({ token: GOOD_TOKEN, expiresAt: past }).reason, RenewReason.EXPIRED);
  assert.equal(validateRenewPayload({ token: GOOD_TOKEN, expiresAt: new Date(past).toISOString() }).reason, RenewReason.EXPIRED);
});

test('validateRenewPayload: expiresAt định dạng sai → bad_expires', () => {
  assert.equal(validateRenewPayload({ token: GOOD_TOKEN, expiresAt: 'not-a-date' }).reason, RenewReason.BAD_EXPIRES);
  assert.equal(validateRenewPayload({ token: GOOD_TOKEN, expiresAt: -1 }).reason, RenewReason.BAD_EXPIRES, 'số âm');
});

test('validateRenewPayload: expiresAt = null được bỏ qua (không kiểm hết hạn)', () => {
  assert.equal(validateRenewPayload({ token: GOOD_TOKEN, expiresAt: null }).ok, true);
});

// ─── writeLicenseFile ───────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-lic-'));
}

test('writeLicenseFile: ghi thành công, nội dung đúng, chown được gọi với chủ của thư mục', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'lightcode-license.key');
  let chownArgs;
  const ownerOf = () => ({ uid: 9999, gid: 0 });
  const chown = (f, uid, gid) => { chownArgs = { f, uid, gid }; };
  const result = writeLicenseFile(file, GOOD_TOKEN, { ownerOf, chown });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), GOOD_TOKEN);
  if (process.platform !== 'win32') {
    assert.equal(chownArgs.uid, 9999);
  }
});

test('writeLicenseFile: thư mục không tồn tại (daemon chưa kích hoạt) → not_enabled', () => {
  const result = writeLicenseFile('/no/such/dir/key', GOOD_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.reason, RenewReason.NOT_ENABLED);
});

test('writeLicenseFile: ghi lỗi (writeAtomic ném) → write_failed', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'key');
  const ownerOf = () => ({ uid: 9999, gid: 0 });
  const writeAtomic = () => { throw new Error('disk full'); };
  const result = writeLicenseFile(file, GOOD_TOKEN, { ownerOf, writeAtomic });
  assert.equal(result.ok, false);
  assert.equal(result.reason, RenewReason.WRITE_FAILED);
});

test('writeLicenseFile: ghi nguyên tử — writeAtomic nhận mode 0o600', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'key');
  let capturedMode;
  const ownerOf = () => ({ uid: 0, gid: 0 });
  const writeAtomic = (f, data, opts) => { capturedMode = opts?.mode; fs.writeFileSync(f, data, opts); };
  const result = writeLicenseFile(file, GOOD_TOKEN, { ownerOf, writeAtomic, chown: () => {} });
  assert.equal(result.ok, true);
  assert.equal(capturedMode, 0o600);
});

// ─── createLicenseRenewHandler ─────────────────────────────────────────────

test('createLicenseRenewHandler: payload hợp lệ → ghi tệp + ack {ok:true} + log "Đã gia hạn"', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'key');
  const logs = [];
  const acks = [];
  const handler = createLicenseRenewHandler({
    file,
    write: (f, token) => { fs.writeFileSync(f, token + '\n'); return { ok: true }; },
    log: (msg) => logs.push(msg),
  });
  handler({ token: GOOD_TOKEN }, (r) => acks.push(r));
  assert.equal(acks[0]?.ok, true);
  assert.ok(logs.length > 0, 'phải log khi thành công');
  assert.ok(logs.every((l) => l.startsWith('[ORG_COMPUTER_LICENSE]')), 'nhãn log cố định');
  assert.ok(!logs.join(' ').includes(GOOD_TOKEN), 'không log token');
});

test('createLicenseRenewHandler: payload sai → ack {ok:false, reason}, không gọi write, log mã lý do (không token)', () => {
  const writes = [];
  const logs = [];
  const acks = [];
  const handler = createLicenseRenewHandler({
    write: (...a) => { writes.push(a); return { ok: true }; },
    log: (msg) => logs.push(msg),
  });
  handler({ token: 'BAD' }, (r) => acks.push(r));
  assert.equal(acks[0]?.ok, false);
  assert.ok(typeof acks[0]?.reason === 'string');
  assert.equal(writes.length, 0, 'không được ghi khi token sai');
  assert.equal(logs.length, 1);
  assert.ok(logs[0].startsWith('[ORG_COMPUTER_LICENSE]') && !logs[0].includes('BAD'), 'log có nhãn, không lộ token');
});

test('createLicenseRenewHandler: ack không phải hàm → không lỗi (vẫn trả kết quả)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'key');
  const handler = createLicenseRenewHandler({
    file,
    write: () => ({ ok: true }),
    log: () => {},
  });
  assert.doesNotThrow(() => handler({ token: GOOD_TOKEN }, undefined));
  assert.doesNotThrow(() => handler({ token: GOOD_TOKEN }, null));
});

test('createLicenseRenewHandler: write lỗi → ack {ok:false, reason:write_failed}, log lý do, không log thành công', () => {
  const acks = [];
  const logs = [];
  const handler = createLicenseRenewHandler({
    write: () => ({ ok: false, reason: RenewReason.WRITE_FAILED }),
    log: (msg) => logs.push(msg),
  });
  handler({ token: GOOD_TOKEN }, (r) => acks.push(r));
  assert.equal(acks[0]?.ok, false);
  assert.equal(acks[0]?.reason, RenewReason.WRITE_FAILED);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('đã gia hạn') && !logs[0].includes(GOOD_TOKEN));
});

test('createLicenseRenewHandler: ack không chứa token (bảo mật)', () => {
  const acks = [];
  const handler = createLicenseRenewHandler({ write: () => ({ ok: true }), log: () => {} });
  handler({ token: GOOD_TOKEN }, (r) => acks.push(r));
  const ackStr = JSON.stringify(acks[0]);
  assert.ok(!ackStr.includes('LCA1.'), 'ack không được chứa token');
});
