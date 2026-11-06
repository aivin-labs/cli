import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-server-test-'));
process.env.AIVIN_REMOTE_HOME = path.join(home, 'remote');
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.AIVIN_TOKEN_STORE = 'file';
delete process.env.AIVIN_BASE_URL;
delete process.env.AIVIN_SERVER;
const servers = await import('../bin/lib/servers.mjs?server-test');
const context = await import('../bin/lib/context.mjs?server-test');
const credentials = await import('../bin/lib/remote/credentials.mjs?server-test');

test('server aliases normalize safely and keep explicit API/self-hosted hosts', () => {
  assert.equal(servers.resolveServerUrl('cloud'), 'https://api.aivin.cloud');
  assert.equal(servers.resolveServerUrl('brain.aivin.cloud'), 'https://api.aivin.cloud');
  assert.equal(servers.resolveServerUrl('vn'), 'https://api.aivin.vn');
  assert.equal(servers.resolveServerUrl('wes.aivin.vn'), 'https://api.aivin.vn');
  assert.equal(servers.resolveServerUrl('api.aivin.vn'), 'https://api.aivin.vn');
  assert.equal(servers.resolveServerUrl('beta-api.aivin.vn'), 'https://beta-api.aivin.vn');
  assert.equal(servers.resolveServerUrl('local'), 'http://localhost:3001');
  assert.equal(servers.resolveServerUrl('local:3247'), 'http://localhost:3247');
  assert.equal(servers.resolveServerUrl('https://self.example/base/'), 'https://self.example/base');
  assert.throws(() => servers.resolveServerUrl('http://self.example'), /localhost.*HTTP|HTTP.*localhost/i);
  assert.throws(() => servers.resolveServerUrl('local:70000'), /1–65535/);
});

test('active server persists and API login contexts remain separate per server', () => {
  assert.equal(servers.setActiveServer('vn'), 'https://api.aivin.vn');
  context.saveActiveContext('cloud', 'cloud-key', { email: 'cloud@example.test' });
  context.saveActiveContext('vn', 'vn-key', { email: 'vn@example.test' });
  assert.equal(servers.readActiveServer(), 'https://api.aivin.vn');
  assert.equal(context.loadActiveContext()?.api_key, 'vn-key');
  assert.equal(context.loadActiveContext('cloud')?.api_key, 'cloud-key');
  assert.equal(context.loadActiveContext('vn')?.email, 'vn@example.test');
  const file = JSON.parse(fs.readFileSync(context.GLOBAL_CREDENTIALS_PATH, 'utf8'));
  assert.equal(Object.keys(file.contexts).length, 2);
  context.clearActiveContext('vn');
  assert.equal(context.loadActiveContext('vn'), null);
  assert.equal(context.loadActiveContext('cloud')?.api_key, 'cloud-key');
});

test('pairing tokens and rotation records are isolated by server; clearing one leaves the other intact', () => {
  const common = { device_id: 'dev-same', roots: [], name: 'test' };
  credentials.saveDeviceCredentials({ ...common, server_url: 'https://api.aivin.cloud', device_token: 'cloud-old' });
  credentials.saveDeviceCredentials({ ...common, server_url: 'https://api.aivin.vn', device_token: 'vn-token' });
  assert.equal(credentials.loadDeviceCredentials('cloud')?.device_token, 'cloud-old');
  assert.equal(credentials.loadDeviceCredentials('vn')?.device_token, 'vn-token');
  credentials.saveDeviceCredentials({ ...common, server_url: 'cloud', device_token: 'cloud-new' }, { previousToken: 'cloud-old' });
  assert.equal(credentials.pendingPreviousToken('cloud'), 'cloud-old');
  assert.equal(credentials.pendingPreviousToken('vn'), null);
  assert.equal(credentials.revertTokenRotation('cloud-new', 'cloud'), 'cloud-old');
  assert.equal(credentials.loadDeviceCredentials('vn')?.device_token, 'vn-token');
  assert.equal(credentials.clearDeviceCredentials('cloud-old', 'cloud'), true);
  assert.equal(credentials.loadDeviceCredentials('cloud'), null);
  assert.equal(credentials.loadDeviceCredentials('vn')?.device_token, 'vn-token');
  const stored = JSON.parse(fs.readFileSync(path.join(process.env.AIVIN_REMOTE_HOME, 'device-credentials.json'), 'utf8'));
  assert.equal(Object.keys(stored.servers).length, 1);
});

test('legacy single-server pairing is preserved and migrated when updated', () => {
  const file = path.join(process.env.AIVIN_REMOTE_HOME, 'device-credentials.json');
  fs.writeFileSync(file, JSON.stringify({
    server_url: 'https://api.aivin.cloud', device_id: 'dev-legacy', device_token: 'legacy-token', roots: [],
  }));
  assert.equal(credentials.loadDeviceCredentials('cloud')?.device_token, 'legacy-token');
  credentials.saveDeviceCredentials({
    ...credentials.loadDeviceCredentials('cloud'), device_token: 'legacy-rotated',
  });
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.version, 2);
  assert.equal(credentials.loadDeviceCredentials('cloud')?.device_token, 'legacy-rotated');
});

test('test home is removed', (t) => {
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
});
