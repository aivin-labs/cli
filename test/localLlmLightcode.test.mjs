import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INVALID_JSON_ERROR, LIGHTCODE_BUSY_ERROR, LIGHTCODE_DISABLED_ERROR, QUOTA_ERROR, QUOTA_RESERVED_ERROR,
  createLocalLlm,
} from '../bin/lib/remote/localLlm.mjs';
import { lightcodeAnnounceState, lightcodeStatus } from '../bin/lib/remote/lightcodeAgent.mjs';

const fakeLc = (over = {}) => ({
  id: 'lightcode',
  label: 'LightCode',
  kind: 'http',
  dynamic: true,
  find: () => ({ bin: 'http://127.0.0.1:4190', version: '2.5.0', connector: { port: 4190, key: 'k_local', ...over } }),
});

test('completeViaLightcodeHttp: gửi tier + effort, không gửi model, chỉ gửi provider khi chọn; trả đủ provider/account/model/tier/profile', async () => {
  const sentBodies = [];
  const chunks = [];
  const llm = createLocalLlm({
    adapters: [fakeLc()],
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:4190/connector/v1/complete');
      sentBodies.push(JSON.parse(init.body));
      const ndjson = [
        JSON.stringify({ type: 'delta', text: 'Xin ' }),
        JSON.stringify({ type: 'delta', text: 'chào' }),
        JSON.stringify({
          type: 'result', ok: true, text: 'Xin chào', agent: 'lightcode',
          provider: 'codex', account: 'Work #1', model: 'gpt-6.1-sol', tier: 'hard', profile: 'balanced',
          usage: { input_tokens: 12, output_tokens: 5 },
        }),
      ].join('\n') + '\n';
      return { ok: true, status: 200, body: (async function* () { yield ndjson; })() };
    },
  });

  const out1 = await llm.complete(
    { agent: 'lightcode', prompt: 'Hi', tier: 'hard', effort: 'high', model: 'auto' },
    { onOutput: (stream, text) => chunks.push([stream, text]) },
  );
  assert.equal('model' in sentBodies[0], false, 'không gửi model sang LightCode');
  assert.equal('provider' in sentBodies[0], false, 'không gửi provider khi không chọn');
  assert.equal(sentBodies[0].tier, 'hard');
  assert.equal(sentBodies[0].effort, 'high');
  assert.deepEqual(chunks, [['stdout', 'Xin '], ['stdout', 'chào']]);
  assert.deepEqual([out1.provider, out1.account, out1.model, out1.tier, out1.profile], ['codex', 'Work #1', 'gpt-6.1-sol', 'hard', 'balanced']);

  await llm.complete({ agent: 'lightcode', prompt: 'Hi', tier: 'medium', provider: 'claude', model: 'ignored-model' });
  assert.equal(sentBodies[1].provider, 'claude');
  assert.equal('model' in sentBodies[1], false);
  assert.equal(sentBodies[1].tier, 'medium');

  await llm.complete({ agent: 'lightcode', prompt: 'Hi', tier: 'light', provider: 'auto' });
  assert.equal('provider' in sentBodies[2], false, 'provider=auto cũng bỏ qua để LightCode tự định tuyến');
});

test('completeViaLightcodeHttp: phân biệt reserved / disabled / busy ở cả HTTP lẫn NDJSON stream', async () => {
  const cases = [
    ['HTTP 429 reserved', { ok: false, status: 429, json: async () => ({ code: 'quota_exceeded', reason: 'reserved', error: 'Reserved for owner', reset_at: '2026-11-29T00:00:00Z' }) }, QUOTA_RESERVED_ERROR],
    ['HTTP 403 disabled', { ok: false, status: 403, json: async () => ({ code: 'disabled', error: 'Disabled in settings' }) }, LIGHTCODE_DISABLED_ERROR],
    ['HTTP 503 busy', { ok: false, status: 503, json: async () => ({ code: 'busy', error: 'Too many concurrent calls' }) }, LIGHTCODE_BUSY_ERROR],
    ['HTTP 502 invalid_json', { ok: false, status: 502, json: async () => ({ ok: false, code: 'invalid_json', error: 'Invalid JSON' }) }, INVALID_JSON_ERROR],
    ['HTTP 429 quota thường', { ok: false, status: 429, json: async () => ({ code: 'quota_exceeded', error: 'Out of quota' }) }, QUOTA_ERROR],
    ['stream result reserved', { ok: true, status: 200, body: (async function* () { yield JSON.stringify({ type: 'result', ok: false, code: 'quota_exceeded', reason: 'reserved', error: 'Reserved' }) + '\n'; })() }, QUOTA_RESERVED_ERROR],
    ['stream result disabled', { ok: true, status: 200, body: (async function* () { yield JSON.stringify({ type: 'result', ok: false, code: 'disabled', error: 'Disabled' }) + '\n'; })() }, LIGHTCODE_DISABLED_ERROR],
    ['stream result busy', { ok: true, status: 200, body: (async function* () { yield JSON.stringify({ type: 'result', ok: false, code: 'busy', error: 'Busy' }) + '\n'; })() }, LIGHTCODE_BUSY_ERROR],
    ['stream result invalid_json', { ok: true, status: 200, body: (async function* () { yield JSON.stringify({ type: 'result', ok: false, code: 'invalid_json', error: 'Invalid JSON' }) + '\n'; })() }, INVALID_JSON_ERROR],
  ];

  for (const [label, response, expectedCode] of cases) {
    const llm = createLocalLlm({ adapters: [fakeLc()], fetchImpl: async () => response });
    await assert.rejects(
      llm.complete({ agent: 'lightcode', prompt: 'Hi', tier: 'hard' }),
      (e) => e.code === expectedCode,
      label,
    );
  }
});

test('completeViaLightcodeHttp: quá hạn trả CALL_TIMEOUT', async () => {
  const llm = createLocalLlm({
    adapters: [fakeLc()],
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  await assert.rejects(
    llm.complete({ agent: 'lightcode', prompt: 'Hi', timeout_ms: 25 }),
    (e) => e.code === 'CALL_TIMEOUT',
  );
});

test('lightcodeStatus & lightcodeAnnounceState: đọc complete + features + providers và chịu được bản cũ', async () => {
  const connector = { app: 'LightCode', port: 4190, key: 'k_local', pid: process.pid, app_version: '2.5.0', protocol: 2 };
  const newInfo = {
    protocol: 2, min_client_protocol: 1, can_run: true, accounts: 3, providers: ['claude', 'codex'],
    features: ['masters', 'complete_tier', 'complete_images'],
    complete: { enabled: true, tiers: ['medium', 'code', 'hard', 'xhard'], reserve_percent: 20, max_concurrent: 4, images: true },
  };
  const stNew = await lightcodeStatus({ connector, fetchImpl: async () => ({ ok: true, json: async () => newInfo }) });
  assert.deepEqual(stNew.complete, { enabled: true, tiers: ['medium', 'code', 'hard', 'xhard'], reserve_percent: 20, max_concurrent: 4, images: true });

  const annNew = await lightcodeAnnounceState({ connector, fetchImpl: async () => ({ ok: true, json: async () => newInfo }) });
  assert.deepEqual(annNew.features, ['masters', 'complete_tier', 'complete_images']);
  assert.deepEqual(annNew.complete, { enabled: true, tiers: ['medium', 'code', 'hard', 'xhard'], reserve_percent: 20, max_concurrent: 4, images: true });
  assert.deepEqual(annNew.providers, ['claude', 'codex']);

  // Bản cũ không có `complete` lẫn `complete_tier`
  const oldInfo = { protocol: 2, min_client_protocol: 1, can_run: true, accounts: 1, providers: ['claude'], features: ['masters'] };
  const annOld = await lightcodeAnnounceState({ connector, fetchImpl: async () => ({ ok: true, json: async () => oldInfo }) });
  assert.deepEqual(annOld, { issue: null, features: ['masters'], providers: ['claude'] });
});
