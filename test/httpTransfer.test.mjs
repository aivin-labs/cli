import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { buildTransferTools } = await import('../bin/lib/remote/httpTransfer.mjs');

const TICKET = 'A'.repeat(43);

/** Máy chủ giả: nhận PUT từng khúc (đối chiếu Content-Length + token máy), trả GET cả tệp. */
function fakeServer(stored) {
  const seen = { parts: [], tokens: new Set() };
  const server = http.createServer((req, res) => {
    seen.tokens.add(req.headers['x-aivin-device-token']);
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.endsWith(`/plugins/device-agent/transfers/${TICKET}`)) { res.statusCode = 404; return res.end(); }
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        seen.parts.push({ part: Number(url.searchParams.get('part')), length: Number(req.headers['content-length']), body });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ received: body.length }));
      });
      return;
    }
    res.setHeader('content-length', String(stored.length));
    res.end(stored);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test('fs.upload gửi từng khúc có Content-Length đúng vé; fs.download ghi ra tệp; vé lạ / máy dùng chung bị từ chối', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-xfer-')));
  const data = Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 256));
  fs.writeFileSync(path.join(root, 'video.mp4'), data);
  const { server, seen, url } = await fakeServer(data);
  try {
    const [upload, download] = buildTransferTools({ serverUrl: url, deviceToken: 'dev-token' });
    const env = { roots: [root] };
    const up = await upload.handler({ path: 'video.mp4', ticket: TICKET, size: data.length, parts: 3, part_bytes: 1000 }, {}, env);
    assert.equal(up.bytes, data.length);
    assert.deepEqual(seen.parts.map((p) => [p.part, p.length]), [[0, 1000], [1, 1000], [2, 500]]);
    assert.deepEqual(Buffer.concat(seen.parts.map((p) => p.body)), data);
    assert.deepEqual([...seen.tokens], ['dev-token']);

    const down = await download.handler({ path: 'out/copy.mp4.aivin-part', ticket: TICKET }, {}, env);
    assert.equal(down.bytes, data.length);
    assert.deepEqual(fs.readFileSync(path.join(root, 'out', 'copy.mp4.aivin-part')), data);

    await assert.rejects(upload.handler({ path: 'video.mp4', ticket: 'http://evil', size: data.length, parts: 1, part_bytes: 5000 }, {}, env), /Invalid transfer ticket/);
    await assert.rejects(upload.handler({ path: 'video.mp4', ticket: TICKET, size: 1, parts: 1, part_bytes: 5000 }, {}, env), /File changed/);
    await assert.rejects(upload.handler({ path: 'video.mp4', ticket: TICKET, size: data.length, parts: 1, part_bytes: 5000 }, {}, { ...env, runAs: { uid: 1 } }), /shared computer/);
  } finally {
    server.close();
  }
});
