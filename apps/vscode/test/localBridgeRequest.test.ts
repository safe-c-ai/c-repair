import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { localBridgeRequest } from '../src/bridge/localBridgeRequest';
import { BridgeClient, CANCELLED_STATUS, BridgeHttpError } from '../src/bridge/BridgeClient';

async function fixture(handler: RequestListener, run: (url: string) => Promise<void>) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const source: Parameters<BridgeClient['inferContext']>[0] = {
  source_id: 'transport-test', filename: 'test.c', language: 'c',
  content: 'int f(void) { return 1; }', content_hash: 'sha256:test',
  size_bytes: 23, origin: 'fixture',
};

test('local infer bypasses fetch header deadline and preserves JSON request and response', async () => {
  await fixture(async (req, res) => {
    assert.equal(req.url, '/context/infer');
    assert.equal(req.headers.authorization, 'Bearer test-token');
    let body = ''; for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body).source_document, source);
    setTimeout(() => res.end(JSON.stringify({ result: 'done' })), 30);
  }, async url => {
    const previous = globalThis.fetch;
    globalThis.fetch = async () => { throw new TypeError('fetch headers timeout'); };
    try { assert.deepEqual(await new BridgeClient(url, 'test-token', 1000).inferContext(source), { result: 'done' }); }
    finally { globalThis.fetch = previous; }
  });
});

test('local infer preserves actionable bridge errors', async () => {
  await fixture((_req, res) => {
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: { code: 'local_generation_limit', message: 'Increase token limit.' } }));
  }, async url => {
    await assert.rejects(new BridgeClient(url, 'test-token', 1000).inferContext(source), e => {
      assert.ok(e instanceof BridgeHttpError); assert.equal(e.code, 'local_generation_limit'); return true;
    });
  });
});

for (const partialBody of [false, true]) {
  test(`local request cancellation closes connection ${partialBody ? 'during body' : 'before headers'}`, async () => {
    const abort = new AbortController();
    let disconnected!: () => void;
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    await fixture((_req, res) => {
      res.on('close', disconnected);
      if (partialBody) { res.writeHead(200); res.write('{'); }
      setTimeout(() => abort.abort(), 30);
    }, async url => {
      await assert.rejects(new BridgeClient(url, 'test-token', 1000).inferContext(source, [], abort.signal), e => {
        assert.ok(e instanceof BridgeHttpError); assert.equal(e.status, CANCELLED_STATUS); return true;
      });
      await closed;
    });
  });
}

test('already cancelled local request does not wait for a server', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(localBridgeRequest('http://127.0.0.1:1', { method: 'POST', headers: {}, signal: abort.signal }), { name: 'AbortError' });
});

test('truncated local response rejects instead of waiting forever', async () => {
  await fixture((_req, res) => { res.writeHead(200); res.write('{'); setTimeout(() => res.destroy(), 20); }, async url => {
    await assert.rejects(localBridgeRequest(url, { method: 'POST', headers: {}, signal: new AbortController().signal }));
  });
});
