import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { buildCommandAuthEnv, redactAuthText, sanitizeAuthEnv } from '../bin/lib/remote/ephemeralAuth.mjs';
import { createLlmLogin, normalizeLocalCallbackUrl, parseLocalCallbackTarget } from '../bin/lib/remote/localLlmLogin.mjs';
import { SIGN_IN_PROBES } from '../bin/lib/remote/localLlmMembers.mjs';
import { memberSpawner } from '../bin/lib/remote/codingAgents.mjs';
import { createLocalLlm } from '../bin/lib/remote/localLlm.mjs';

test('ephemeralAuth: lọc đúng allowlist, tạo GIT_CONFIG extraheader và che sạch cả token lẫn base64', () => {
  const clean = sanitizeAuthEnv({
    GH_TOKEN: 'gho_secret_token_999',
    PATH: '/evil/bin',
    LD_PRELOAD: '/evil.so',
    CLOUDFLARE_ACCOUNT_ID: 'acc_123456',
  });
  assert.deepEqual(clean, { GH_TOKEN: 'gho_secret_token_999', CLOUDFLARE_ACCOUNT_ID: 'acc_123456' });

  const { env, secrets } = buildCommandAuthEnv(clean, 'git push origin main');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.match(env.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /);

  const b64 = Buffer.from('x-access-token:gho_secret_token_999', 'utf8').toString('base64');
  assert.equal(redactAuthText(`token=gho_secret_token_999 hdr=${b64} acc=acc_123456`, secrets), 'token=[REDACTED] hdr=[REDACTED] acc=acc_123456');
});

test('localLlmLogin: chuyển tiếp OAuth callback về đúng cổng loopback, chặn cổng/host lạ', async () => {
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Foauth2callback&state=st1';
  assert.deepEqual(parseLocalCallbackTarget(authUrl), { port: 8085, path: '/oauth2callback' });
  assert.equal(normalizeLocalCallbackUrl('http://localhost:8085/oauth2callback?code=abc&state=st1', 8085), 'http://127.0.0.1:8085/oauth2callback?code=abc&state=st1');
  assert.equal(normalizeLocalCallbackUrl('http://localhost:9999/oauth2callback?code=abc&state=st1', 8085), null);
  assert.equal(normalizeLocalCallbackUrl('http://169.254.169.254:8085/latest?code=abc', 8085), null);

  let childRef = null;
  const spawnImpl = () => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
    childRef = child;
    setImmediate(() => child.stdout.write(`Open this URL:\n${authUrl}\n`));
    return child;
  };
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    setImmediate(() => childRef.emit('exit', 0));
    return { ok: true, status: 200 };
  };
  const llm = {
    adapterFor: () => ({ id: 'gemini', label: 'Gemini CLI' }),
    binOf: () => ({ bin: '/usr/local/bin/gemini' }),
    memberDir: '/tmp',
    signIn: { forget: () => {} },
    agents: () => [],
  };
  const login = createLlmLogin({ llm, spawnImpl, fetchImpl, startWaitMs: 2000, codeWaitMs: 2000 });
  const account = { uid: 10001, gid: 10000, home: '/home/u0000000000a1', name: 'u0000000000a1' };

  const started = await login.start({ agent: 'gemini' }, { runAs: account });
  assert.equal(started.state, 'pending');
  assert.equal(started.input_kind, 'callback_url');

  // Sai cổng phải bị từ chối
  await assert.rejects(
    login.submitCode({ login_id: started.login_id, code: 'http://localhost:9999/oauth2callback?code=abc&state=st1' }, { runAs: account }),
    (e) => e.code === 'INVALID_ARGS',
  );

  // Đúng cổng → chuyển tiếp thành công và phiên chuyển sang succeeded
  const done = await login.submitCode({ login_id: started.login_id, code: 'http://localhost:8085/oauth2callback?code=abc&state=st1' }, { runAs: account });
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(fetched, ['http://127.0.0.1:8085/oauth2callback?code=abc&state=st1']);
});

test('codingAgents memberSpawner: giữ lại authExtra sau agentEnv và vẫn lọc biến bí mật của root', () => {
  let captured = null;
  const fakeSpawn = (cmd, argv, opts) => { captured = { cmd, argv, opts }; return new EventEmitter(); };
  const spawner = memberSpawner({ name: 'u01', uid: 10001, gid: 10000, home: '/home/u01' }, fakeSpawn);
  const { env: authExtra } = buildCommandAuthEnv({ GH_TOKEN: 'gho_member_tok_777', CLOUDFLARE_API_TOKEN: 'cf_tok_888' }, 'git');
  spawner('/usr/local/bin/claude', ['-p'], {
    env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-root-must-drop', OPENAI_API_KEY: 'sk-root-openai' },
    authExtra,
  });
  assert.equal(captured.opts.env.GH_TOKEN, 'gho_member_tok_777');
  assert.equal(captured.opts.env.CLOUDFLARE_API_TOKEN, 'cf_tok_888');
  assert.equal(captured.opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(captured.opts.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(captured.opts.env.OPENAI_API_KEY, undefined);
});

test('localLlmMembers: SIGN_IN_PROBES.gemini kiểm tra tệp oauth_creds.json trong thư mục riêng thành viên', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-gemini-probe-'));
  try {
    assert.equal(SIGN_IN_PROBES.gemini.check({ home: tmpHome }), false);
    fs.mkdirSync(path.join(tmpHome, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.gemini', 'oauth_creds.json'), '{}');
    assert.equal(SIGN_IN_PROBES.gemini.check({ home: tmpHome }), false);
    fs.writeFileSync(path.join(tmpHome, '.gemini', 'oauth_creds.json'), JSON.stringify({ access_token: 'ya29.test' }));
    assert.equal(SIGN_IN_PROBES.gemini.check({ home: tmpHome }), true);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('localLlm LIGHTCODE_LLM: gọi /connector/v1/complete cục bộ, stream delta và bắt LOCAL_LLM_QUOTA', async () => {
  const fakeLc = {
    id: 'lightcode',
    label: 'LightCode',
    kind: 'http',
    dynamic: true,
    find: () => ({ bin: 'http://127.0.0.1:4190', version: '2.4.0', connector: { port: 4190, key: 'k_local' } }),
  };
  const chunks = [];
  const llm = createLocalLlm({
    adapters: [fakeLc],
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:4190/connector/v1/complete');
      assert.equal(init.headers.Authorization, 'Bearer k_local');
      const ndjson = [
        JSON.stringify({ type: 'delta', text: 'Chào ' }),
        JSON.stringify({ type: 'delta', text: 'bạn' }),
        JSON.stringify({ type: 'result', ok: true, text: 'Chào bạn', agent: 'lightcode', provider: 'claude', account: 'Acc #2', model: 'sonnet' }),
      ].join('\n') + '\n';
      return { ok: true, status: 200, body: (async function* () { yield ndjson; })() };
    },
  });
  const out = await llm.complete({ agent: 'lightcode', prompt: 'Hi' }, { onOutput: (c) => chunks.push(c) });
  assert.equal(out.text, 'Chào bạn');
  assert.equal(out.account, 'Acc #2');
  assert.deepEqual(chunks, ['Chào ', 'bạn']);

  const llmQuota = createLocalLlm({
    adapters: [fakeLc],
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ code: 'quota_exceeded', error: 'Out of quota' }) }),
  });
  await assert.rejects(llmQuota.complete({ agent: 'lightcode', prompt: 'Hi' }), (e) => e.code === 'LOCAL_LLM_QUOTA');
});
