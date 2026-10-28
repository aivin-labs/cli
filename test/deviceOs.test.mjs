import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { detectOs } = await import('../bin/lib/remote/deviceProfile.mjs');

const RELEASES = {
  ubuntu: ['NAME="Ubuntu"', 'VERSION_ID="22.04"', 'ID=ubuntu', 'ID_LIKE=debian', 'PRETTY_NAME="Ubuntu 22.04.4 LTS"'].join('\n'),
  alpine: ['NAME="Alpine Linux"', 'ID=alpine', 'VERSION_ID=3.20.1', 'PRETTY_NAME="Alpine Linux v3.20"'].join('\n'),
  fedora: ['NAME="Fedora Linux"', 'VERSION_ID=40', 'ID=fedora', 'PRETTY_NAME="Fedora Linux 40 (Workstation Edition)"'].join('\r\n'),
};

test('Linux: đọc /etc/os-release (bỏ ngoặc kép, cả xuống dòng CRLF), nhận musl / systemd', () => {
  const u = detectOs('linux', () => RELEASES.ubuntu, (p) => p === '/run/systemd/system');
  assert.equal(u.name, 'Ubuntu 22.04.4 LTS');
  assert.equal(u.id, 'ubuntu');
  assert.equal(u.version, '22.04');
  assert.equal(u.like, 'debian');
  assert.equal(u.init, 'systemd');
  const a = detectOs('linux', () => RELEASES.alpine, (p) => p === '/etc/alpine-release' || p === '/sbin/openrc');
  assert.equal(a.id, 'alpine');
  assert.equal(a.init, 'openrc');
  const f = detectOs('linux', () => RELEASES.fedora, () => false);
  assert.equal(f.id, 'fedora');
  assert.equal(f.version, '40');
  const none = detectOs('linux', () => { throw new Error('missing'); }, () => false);
  assert.equal(none.name, 'Linux');
});

test('Windows / macOS: tên + phiên bản', () => {
  assert.equal(detectOs('win32').id, 'windows');
  assert.equal(detectOs('darwin').id, 'macos');
});
