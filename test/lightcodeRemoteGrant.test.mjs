import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightcodeRemoteGrant } from '../bin/lib/remote/lightcodeAgent.mjs';

const connector = { port: 4611, key: 'k' };
const answer = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

test('grant: trả địa chỉ + token khi LightCode đồng ý', async () => {
  const res = await lightcodeRemoteGrant({ connector, fetchImpl: answer(200, { url: 'https://a.lightcode.live', token: 'lcd_x', host_name: 'PC' }) });
  assert.deepEqual(res, { ok: true, url: 'https://a.lightcode.live', token: 'lcd_x', host_name: 'PC' });
});

test('grant: từ chối trả mã lý do, không ném', async () => {
  const reason = async (deps) => (await lightcodeRemoteGrant({ connector, ...deps })).reason;
  assert.equal(await reason({ fetchImpl: answer(404, {}) }), 'outdated');
  assert.equal(await reason({ fetchImpl: answer(409, { code: 'remote_off' }) }), 'remote_off');
  assert.equal(await reason({ fetchImpl: answer(403, { code: 'revoked' }) }), 'revoked');
  assert.equal(await reason({ fetchImpl: answer(500, { code: 'x' }) }), 'failed');
  assert.equal(await reason({ fetchImpl: answer(200, { url: 'https://a', token: 'nope' }) }), 'failed');
  assert.equal(await reason({ fetchImpl: async () => { throw new Error('down'); } }), 'not_running');
  assert.equal((await lightcodeRemoteGrant({ ensure: async () => { throw new Error('none'); }, connector: null, file: 'missing' })).reason, 'not_running');
});
