import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  LoginApp, LoginOutcome, buildLoginUrl, createPkcePair, parseCallback, resultLang, resultPageHtml,
} from '../bin/lib/loginHandoff.mjs';

// browserLogin ghi mã máy vào thư mục cấu hình: trỏ sang thư mục tạm trước khi nạp module.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-login-'));
process.env.AIVIN_REMOTE_HOME = home;
process.env.AIVIN_NO_BROWSER = '1';
const { browserLogin } = await import('../bin/lib/auth.mjs');

test('PKCE: challenge = base64url(sha256(verifier)), verifier đúng chuẩn RFC 7636', () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(createPkcePair().verifier, verifier);
});

test('URL đăng nhập: có challenge + gợi ý chính sách, KHÔNG có verifier', () => {
  const { verifier, challenge } = createPkcePair();
  const url = buildLoginUrl({
    webBaseUrl: 'https://app.example.test', port: 5123, state: 'st', name: 'WES', app: 'desktop', challenge,
    hints: { access: 'full', confirm: 'risky', cast: 'ask' },
  });
  const p = url.searchParams;
  assert.equal(p.get('cli_redirect'), 'http://127.0.0.1:5123/callback');
  assert.equal(p.get('cli_app'), LoginApp.DESKTOP);
  assert.equal(p.get('cli_challenge'), challenge);
  assert.equal(p.get('cli_access'), 'full');
  assert.equal(p.get('cli_cast'), 'ask');
  assert.ok(!url.toString().includes(verifier));
  assert.equal(buildLoginUrl({ webBaseUrl: 'https://a.test', port: 1, state: 's', name: 'n', app: 'evil', challenge }).searchParams.get('cli_app'), LoginApp.CLI);
});

test('callback: sai state bị bỏ qua; huỷ; mã; khoá kiểu web cũ', () => {
  const q = (s) => new URLSearchParams(s);
  assert.equal(parseCallback(q('code=x&state=other'), 'st').kind, LoginOutcome.BAD_REQUEST);
  assert.equal(parseCallback(q('error=cancelled&state=st'), 'st').kind, LoginOutcome.CANCELLED);
  assert.deepEqual(parseCallback(q('code=abc&state=st'), 'st'), { kind: 'code', code: 'abc' });
  assert.deepEqual(parseCallback(q('key=wes-ak-1&state=st'), 'st'), { kind: 'key', key: 'wes-ak-1' });
  assert.equal(parseCallback(q('state=st'), 'st').kind, LoginOutcome.FAILED);
});

test('trang cuối: đúng ngôn ngữ, đúng app, không nhắc terminal với app desktop, thoát ký tự', () => {
  assert.equal(resultLang('vi-VN'), 'vi');
  assert.equal(resultLang('fr', 'vi-VN'), 'en');
  assert.equal(resultLang(null, 'vi-VN'), 'vi');
  const desktop = resultPageHtml({ outcome: LoginOutcome.OK, app: 'desktop', lang: 'vi' });
  assert.match(desktop, /AIVIN Bot/);
  assert.doesNotMatch(desktop, /dòng lệnh|terminal/i);
  assert.match(resultPageHtml({ outcome: LoginOutcome.OK, app: 'cli', lang: 'en' }), /terminal/);
  assert.match(resultPageHtml({ outcome: LoginOutcome.CANCELLED, app: 'desktop', lang: 'en' }), /cancelled/);
});

/** Máy chủ giả cho `POST /apikey/cli-login/exchange`: chỉ trả khoá khi verifier khớp challenge đã thấy trên URL đăng nhập. */
async function fakeServer(getChallenge) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      calls.push({ url: req.url, data });
      const ok = req.url === '/apikey/cli-login/exchange' && createHash('sha256').update(data.code_verifier).digest('base64url') === getChallenge() && data.code === 'good-code';
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { data: { api_key: 'wes-ak-from-server', name: 'WES', replaced: 0 } } : { i18n: 'APIKEY.CLI_LOGIN_CODE_INVALID' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, calls, url: `http://127.0.0.1:${server.address().port}` };
}

/** Chạy browserLogin, bắt URL nó in ra (không mở trình duyệt). */
async function startLogin(opts) {
  const logs = [];
  const original = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  const promise = browserLogin(opts);
  promise.catch(() => {});
  let loginUrl;
  for (let i = 0; i < 100 && !loginUrl; i++) {
    await new Promise((r) => setTimeout(r, 20));
    loginUrl = logs.map((l) => l.match(/https?:\/\/\S+cli_redirect\S+/)?.[0]).find(Boolean);
  }
  console.log = original;
  return { promise, loginUrl: new URL(loginUrl) };
}

test('browserLogin: mã + verifier đổi lấy khoá qua máy chủ; lời gọi lạ (sai state) không làm hỏng lần đăng nhập', async () => {
  let challenge;
  const api = await fakeServer(() => challenge);
  try {
    const { promise, loginUrl } = await startLogin({ app: LoginApp.DESKTOP, serverUrl: api.url });
    challenge = loginUrl.searchParams.get('cli_challenge');
    const cb = loginUrl.searchParams.get('cli_redirect');
    const state = loginUrl.searchParams.get('cli_state');

    const stray = await fetch(`${cb}?code=good-code&state=wrong`);
    assert.equal(stray.status, 400);

    const page = await fetch(`${cb}?code=good-code&state=${state}&lang=vi`);
    assert.match(await page.text(), /AIVIN Bot/);
    assert.equal(await promise, 'wes-ak-from-server');
    const exchange = api.calls.find((c) => c.url === '/apikey/cli-login/exchange');
    assert.match(exchange.data.device_id, /^dev-/);
  } finally {
    api.server.close();
  }
});

test('browserLogin: bấm Huỷ trên web → kết thúc ngay (không đợi 5 phút)', async () => {
  const { promise, loginUrl } = await startLogin({ app: LoginApp.DESKTOP, serverUrl: 'http://127.0.0.1:9' });
  const cb = loginUrl.searchParams.get('cli_redirect');
  const page = await fetch(`${cb}?error=cancelled&state=${loginUrl.searchParams.get('cli_state')}&lang=en`);
  assert.match(await page.text(), /cancelled/);
  await assert.rejects(promise, /cancelled/);
});

test('browserLogin: máy chủ từ chối mã → báo lỗi, trang cuối báo không thành công', async () => {
  const api = await fakeServer(() => 'not-the-challenge');
  try {
    const { promise, loginUrl } = await startLogin({ serverUrl: api.url });
    const cb = loginUrl.searchParams.get('cli_redirect');
    const page = await fetch(`${cb}?code=good-code&state=${loginUrl.searchParams.get('cli_state')}&lang=en`);
    assert.match(await page.text(), /Sign-in failed/);
    await assert.rejects(promise, /Could not finish login/);
  } finally {
    api.server.close();
  }
});

test.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* tệp còn mở */ } });
