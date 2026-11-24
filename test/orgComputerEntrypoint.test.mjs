import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { spawnSync } from 'child_process';

const SRC = fs.readFileSync(new URL('../deploy/org-computer/entrypoint.sh', import.meta.url), 'utf8');

test('entrypoint: daemon LightCode có LCAGENT_DATA_DIR trong /var/lib/aivin-lc (không rơi về /data), tạo + chown + 0700 trước khi chạy', () => {
  assert.match(SRC, /LC_DATA_DIR=\/var\/lib\/aivin-lc\/data/);
  const env = SRC.match(/LC_ENV="([^"]*)"/)?.[1] ?? '';
  assert.match(env, /LCAGENT_DATA_DIR=\$LC_DATA_DIR/);
  assert.match(env, /LCAGENT_MANAGED_RUNTIME=1/);
  const iMk = SRC.indexOf('mkdir -p "$LC_DATA_DIR"');
  const iChown = SRC.indexOf('chown aivin-lc:aivin-lc "$LC_DATA_DIR"');
  const iChmod = SRC.indexOf('chmod 700 "$LC_DATA_DIR"');
  const iRun = SRC.indexOf('LC_CMD=');
  assert.ok(iMk > 0 && iChown > iMk && iChmod > iChown && iRun > iChmod, 'thứ tự mkdir → chown → chmod → chạy');
});

const DOCKERFILE = fs.readFileSync(new URL('../deploy/org-computer/Dockerfile', import.meta.url), 'utf8');

test('Dockerfile: opencode-ai ghim bản bằng ARG, cài cùng khối npm -g và kiểm opencode --version; không đặt XDG_* ra ngoài $HOME thành viên', () => {
  assert.match(DOCKERFILE, /^ARG OPENCODE_VERSION=1\.19\.\d+$/m);
  const install = DOCKERFILE.match(/RUN npm install -g[\s\S]*?\nENV /)?.[0] ?? '';
  assert.match(install, /"opencode-ai@\$\{OPENCODE_VERSION\}"/);
  assert.match(install, /&& opencode --version/);
  assert.doesNotMatch(DOCKERFILE, /ENV[^\n]*XDG_(CONFIG|DATA|CACHE|STATE)_HOME/, 'opencode phải rơi về $HOME của từng thành viên');
});

// Chạy đúng khối tính LCAGENT_AI_GATEWAY_HOSTS trích từ entrypoint.sh bằng bash thật.
function gatewayHosts(env) {
  const a = SRC.indexOf('  LC_GATEWAY_HOSTS="host.docker.internal');
  const b = SRC.indexOf('\nEOF_HOSTS\n') + '\nEOF_HOSTS\n'.length; // dòng đóng heredoc, không phải chỗ mở `<<EOF_HOSTS`
  const script = `log(){ echo "LOG: $*" >&2; }\n${SRC.slice(a, b)}\nprintf '%s' "$LC_GATEWAY_HOSTS"\n`;
  const r = spawnSync('bash', ['-c', script], { env: { ...process.env, AIVIN_SERVER: '', AIVIN_AI_GATEWAY_HOSTS: '', ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split(',');
}
const DEFAULT_HOSTS = ['host.docker.internal', 'localhost', '127.0.0.1', '::1'];
const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;

test('entrypoint: LC_ENV truyền LCAGENT_AI_GATEWAY_HOSTS cho daemon, không dùng wildcard', () => {
  const env = SRC.match(/LC_ENV="([^"]*)"/)?.[1] ?? '';
  assert.match(env, /LCAGENT_AI_GATEWAY_HOSTS=\$LC_GATEWAY_HOSTS/);
  assert.ok(SRC.indexOf('LC_GATEWAY_HOSTS=') < SRC.indexOf('LC_ENV='), 'tính danh sách trước khi dựng LC_ENV');
  assert.doesNotMatch(SRC, /LC_GATEWAY_HOSTS="[^"]*\*/);
});

test('entrypoint: host cổng AI = mặc định + hostname AIVIN_SERVER (bỏ scheme/cổng/đường dẫn, chữ thường)', { skip: !hasBash }, () => {
  assert.deepEqual(gatewayHosts({}), DEFAULT_HOSTS);
  assert.deepEqual(gatewayHosts({ AIVIN_SERVER: 'https://API.Aivin.vn:8443/x?y#z' }), [...DEFAULT_HOSTS, 'api.aivin.vn']);
  assert.deepEqual(gatewayHosts({ AIVIN_SERVER: 'http://host.docker.internal:3001' }), DEFAULT_HOSTS, 'không nhân đôi mục mặc định');
});

test('entrypoint: AIVIN_AI_GATEWAY_HOSTS thêm host hợp lệ, bỏ giá trị lạ (wildcard, URL, khoảng trắng giữa), không trùng', { skip: !hasBash }, () => {
  const got = gatewayHosts({
    AIVIN_SERVER: 'https://api.aivin.vn',
    AIVIN_AI_GATEWAY_HOSTS: ' gw.example.com , *.evil.com,a b,http://x.com,GW.example.com,1.2.3.4,-bad.com,$(id)',
  });
  assert.deepEqual(got, [...DEFAULT_HOSTS, 'api.aivin.vn', 'gw.example.com', '1.2.3.4']);
});
