import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { getJson, HttpError, request, requestJson } from '../src/http.js';

describe('outgoing HTTP', () => {
  let server;
  let base;
  const seen = [];

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method, path: url.pathname, headers: req.headers, body: Buffer.concat(chunks).toString() });
        switch (url.pathname) {
          case '/json':
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end('{"ok":true}');
          case '/text':
            res.writeHead(200);
            return res.end('hello');
          case '/bad-json':
            res.writeHead(200);
            return res.end('<html>');
          case '/missing':
            res.writeHead(404, { 'x-ratelimit-reset-after': '3' });
            return res.end('{"error":"no"}');
          case '/redirect':
            res.writeHead(302, { Location: '/json' });
            return res.end();
          case '/redirect-away':
            res.writeHead(302, { Location: 'http://elsewhere.invalid/x' });
            return res.end();
          case '/loop':
            res.writeHead(302, { Location: '/loop' });
            return res.end();
          case '/slow':
            return void setTimeout(() => res.end('late'), 500);
          case '/big-declared':
            res.writeHead(200, { 'Content-Length': 5000 });
            return res.end(Buffer.alloc(5000));
          case '/big-streamed':
            res.writeHead(200); // chunked: no length up front
            res.write(Buffer.alloc(3000));
            res.write(Buffer.alloc(3000));
            return res.end();
          default:
            res.writeHead(404);
            return res.end();
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))));

  it('returns status, headers and the body as a Buffer', async () => {
    const r = await request(fetch, `${base}/text`);
    assert.equal(r.status, 200);
    assert.ok(Buffer.isBuffer(r.body));
    assert.equal(r.body.toString(), 'hello');
  });

  it('sends the method, headers and body it is given', async () => {
    seen.length = 0;
    await request(fetch, `${base}/text`, { method: 'POST', headers: { 'X-Test': 'yes', 'User-Agent': 'addon/1' }, body: 'payload' });
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].headers['x-test'], 'yes');
    assert.equal(seen[0].headers['user-agent'], 'addon/1');
    assert.equal(seen[0].body, 'payload');
  });

  it('follows a redirect by hand', async () => {
    const r = await request(fetch, `${base}/redirect`);
    assert.equal(r.status, 200);
    assert.equal(r.url, `${base}/json`);
  });

  it('lets the caller refuse a redirect, naming where it led', async () => {
    await assert.rejects(request(fetch, `${base}/redirect-away`, { allowRedirect: (u) => new URL(u).hostname === '127.0.0.1' }), (e) => {
      assert.ok(e instanceof HttpError);
      assert.match(e.message, /redirect to elsewhere\.invalid refused/);
      return true;
    });
  });

  it('gives up on a redirect loop', async () => {
    await assert.rejects(request(fetch, `${base}/loop`, { maxRedirects: 2 }), /redirect to .* refused/);
  });

  it('times out', async () => {
    await assert.rejects(request(fetch, `${base}/slow`, { timeoutMs: 50 }), (e) => e instanceof HttpError && /timed out after 50 ms/.test(e.message));
  });

  it('reports a refused connection as a network error that names the cause', async () => {
    const spare = createServer();
    await new Promise((resolve) => spare.listen(0, '127.0.0.1', resolve));
    const { port } = spare.address();
    await new Promise((resolve) => spare.close(resolve)); // nothing listens on it now
    await assert.rejects(request(fetch, `http://127.0.0.1:${port}/`, { timeoutMs: 2000 }), (e) => e instanceof HttpError && /network error: ECONNREFUSED/.test(e.message));
    await assert.rejects(request(fetch, 'http://no-such-host.invalid/', { timeoutMs: 2000 }), /network error: ENOTFOUND/);
  });

  it('refuses a body its length header says is too big, without reading it', async () => {
    await assert.rejects(request(fetch, `${base}/big-declared`, { maxBytes: 1000 }), (e) => e.status === 413);
  });

  it('stops reading a body that grows past the limit with no length header', async () => {
    await assert.rejects(request(fetch, `${base}/big-streamed`, { maxBytes: 4000 }), (e) => e.status === 413);
  });

  it('parses JSON', async () => {
    assert.deepEqual(await getJson(fetch, `${base}/json`), { ok: true });
    const { data, headers } = await requestJson(fetch, `${base}/json`);
    assert.deepEqual(data, { ok: true });
    assert.equal(headers.get('content-type'), 'application/json');
  });

  it('asks for JSON unless told otherwise', async () => {
    seen.length = 0;
    await getJson(fetch, `${base}/json`);
    assert.equal(seen[0].headers.accept, 'application/json');
    seen.length = 0;
    await getJson(fetch, `${base}/json`, { headers: { Accept: 'application/vnd.api+json' } });
    assert.equal(seen[0].headers.accept, 'application/vnd.api+json');
  });

  it('turns a non-2xx answer into an HttpError that carries the status and headers', async () => {
    await assert.rejects(getJson(fetch, `${base}/missing`), (e) => {
      assert.equal(e.status, 404);
      assert.equal(e.headers.get('x-ratelimit-reset-after'), '3');
      return true;
    });
  });

  it('turns an answer that is not JSON into an HttpError', async () => {
    await assert.rejects(getJson(fetch, `${base}/bad-json`), /not valid JSON/);
  });
});
