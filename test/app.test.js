import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FILES, FRIEREN_BATCH, FRIEREN_BROKEN, FRIEREN_OTHER, startMockUpstream, VALID_KEY } from '../scripts/mock-upstream.js';
import { clientIp, createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { encodeConfig } from '../src/stremio/userConfig.js';
import { toMemberToken, toToken } from '../src/subs/convert.js';

describe('the addon over HTTP', () => {
  let mock;
  const running = [];

  async function start(env = {}, options = {}) {
    const app = createApp({ config: mock.config(env), ...options });
    const server = createServer(app.handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const instance = {
      url,
      app,
      get: (path, init) => fetch(`${url}${path}`, init),
      getJson: async (path, init) => {
        const response = await fetch(`${url}${path}`, init);
        return { response, body: await response.json() };
      },
      close: () => new Promise((resolve) => (app.close(), server.closeAllConnections(), server.close(resolve))),
    };
    running.push(instance);
    return instance;
  }

  before(async () => {
    mock = await startMockUpstream();
  });
  after(async () => {
    await Promise.all(running.map((i) => i.close()));
    await mock.close();
  });
  beforeEach(() => {
    mock.requests.length = 0;
    mock.limitNext(0, 0);
    mock.failNext(500, 0);
    mock.delay(0);
  });

  const segment = (extra = {}) => encodeConfig({ jimakuApiKey: VALID_KEY, ...extra });

  describe('pages and files', () => {
    let addon;
    before(async () => {
      addon = await start();
    });

    it('serves the setup page with a strict policy and no inline script', async () => {
      for (const path of ['/', '/configure', `/${segment()}/configure`]) {
        const response = await addon.get(path);
        assert.equal(response.status, 200, path);
        assert.match(response.headers.get('content-type'), /^text\/html/);
        const csp = response.headers.get('content-security-policy');
        assert.match(csp, /default-src 'none'/);
        assert.match(csp, /script-src 'self'(;|$)/);
        assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
        assert.equal(response.headers.get('x-frame-options'), 'DENY');
        const html = await response.text();
        assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, 'every script is an external file');
        assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
        assert.doesNotMatch(html, /style=/i, 'no inline styles');
        assert.doesNotMatch(html, /https?:\/\/(?!jimaku\.cc)/, 'nothing is loaded from another site');
      }
    });

    it('serves its own assets with the right types', async () => {
      const types = { '/configure.js': /javascript/, '/configure.css': /text\/css/, '/logo.png': /image\/png/, '/icon.png': /image\/png/, '/favicon.ico': /image\/png/ };
      for (const [path, type] of Object.entries(types)) {
        const response = await addon.get(path);
        assert.equal(response.status, 200, path);
        assert.match(response.headers.get('content-type'), type, path);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.ok((await response.arrayBuffer()).byteLength > 100);
      }
    });

    it('serves nothing else from disk', async () => {
      for (const path of ['/package.json', '/src/app.js', '/configure.html', '/public/configure.js', '/..%2fpackage.json', '/%2e%2e/package.json', '/LICENSE', '/.env', '/node_modules/x']) {
        assert.equal((await addon.get(path)).status, 404, path);
      }
    });

    it('answers /health', async () => {
      const { response, body } = await addon.getJson('/health');
      assert.equal(response.status, 200);
      assert.equal(body.status, 'ok');
      assert.match(body.version, /^\d+\.\d+\.\d+$/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    });

    it('allows any origin, because Stremio runs in a browser too', async () => {
      const response = await addon.get('/manifest.json');
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      const preflight = await addon.get('/manifest.json', { method: 'OPTIONS' });
      assert.equal(preflight.status, 204);
      assert.match(preflight.headers.get('access-control-allow-methods'), /GET/);
    });

    it('answers HEAD without a body, and refuses other methods', async () => {
      const head = await addon.get('/manifest.json', { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal((await head.text()).length, 0);
      const put = await addon.get('/manifest.json', { method: 'PUT' });
      assert.equal(put.status, 405);
      assert.match(put.headers.get('allow'), /GET/);
    });

    it('says 404 in JSON for anything unknown', async () => {
      const { response, body } = await addon.getJson('/nothing/here');
      assert.equal(response.status, 404);
      assert.deepEqual(body, { error: 'Not found' });
    });

    it('survives a malformed address', async () => {
      assert.equal((await addon.get('/%E0%A4%A')).status, 404);
      assert.equal((await addon.get('/%')).status, 404);
    });
  });

  describe('manifest', () => {
    let addon;
    before(async () => {
      addon = await start();
    });

    it('without settings, asks to be configured', async () => {
      const { response, body } = await addon.getJson('/manifest.json');
      assert.equal(response.status, 200);
      assert.equal(body.id, 'community.jimakukaiyo');
      assert.deepEqual(body.resources, ['subtitles']);
      assert.deepEqual(body.types, ['movie', 'series', 'anime']);
      assert.deepEqual(body.idPrefixes, ['tt', 'kitsu', 'mal', 'anilist', 'anidb']);
      assert.equal(body.behaviorHints.configurable, true);
      assert.equal(body.behaviorHints.configurationRequired, true);
      assert.equal(body.logo, `${addon.url}/logo.png`);
    });

    it('with settings, is ready, and has an id of its own', async () => {
      const { body } = await addon.getJson(`/${segment()}/manifest.json`);
      assert.equal(body.behaviorHints.configurationRequired, false);
      assert.equal(body.id, `community.jimakukaiyo.${segment().slice(0, 8)}`);
      assert.ok(!JSON.stringify(body).includes(VALID_KEY), 'the key is never echoed back');
    });

    it('refuses settings it cannot read', async () => {
      for (const bad of ['notbase64!!', Buffer.from('{"jimakuApiKey":"short"}').toString('base64url'), Buffer.from('not json at all').toString('base64url')]) {
        const response = await addon.get(`/${bad}/manifest.json`);
        assert.equal(response.status, 400, bad);
      }
    });

    it('names itself by how it was reached, behind a proxy', async () => {
      const { body } = await addon.getJson('/manifest.json', { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'addon.example.org' } });
      assert.equal(body.logo, 'https://addon.example.org/logo.png');
      assert.equal(body.icon, 'https://addon.example.org/icon.png');
    });

    it('assumes https for a public host that says nothing about it, and http for a local one', async () => {
      const logoFor = async (headers) => (await addon.getJson('/manifest.json', { headers })).body.logo;
      assert.equal(await logoFor({ 'x-forwarded-host': 'abc123-jimaku.baby-beamup.club' }), 'https://abc123-jimaku.baby-beamup.club/logo.png');
      assert.equal(await logoFor({ 'x-forwarded-host': 'addon.example.org', 'x-forwarded-proto': 'http' }), 'http://addon.example.org/logo.png', 'an explicit answer wins');
      assert.equal(await logoFor({ 'x-forwarded-host': 'localhost:7000' }), 'http://localhost:7000/logo.png');
      assert.equal(await logoFor({ 'x-forwarded-host': '192.168.1.20:7000' }), 'http://192.168.1.20:7000/logo.png');
      assert.equal(await logoFor({ 'x-forwarded-host': 'nas.local:7000' }), 'http://nas.local:7000/logo.png');
    });

    it('ignores a forwarded host that is not a plausible host name', async () => {
      const { body } = await addon.getJson('/manifest.json', { headers: { 'x-forwarded-host': 'evil.example/"><script>' } });
      assert.equal(body.logo, 'http://localhost:7000/logo.png', 'falls back to the configured port on localhost');
    });

    it('uses BASE_URL when it is set, whatever the headers say', async () => {
      const fixed = await start({ BASE_URL: 'https://subs.example.com/' });
      const { body } = await fixed.getJson('/manifest.json', { headers: { 'x-forwarded-host': 'other.example.org' } });
      assert.equal(body.logo, 'https://subs.example.com/logo.png');
    });

    it('is ready without settings when the server has its own key', async () => {
      const own = await start({ JIMAKU_API_KEY: VALID_KEY });
      const { body } = await own.getJson('/manifest.json');
      assert.equal(body.behaviorHints.configurationRequired, false);
    });
  });

  describe('subtitles', () => {
    let addon;
    before(async () => {
      addon = await start();
    });

    it('lists the subtitles of an episode, in Stremio’s format', async () => {
      const { response, body } = await addon.getJson(`/${segment()}/subtitles/series/kitsu:46474:2.json`);
      assert.equal(response.status, 200);
      assert.equal(body.subtitles.length, 3);
      for (const s of body.subtitles) {
        assert.deepEqual(Object.keys(s).sort(), ['id', 'label', 'lang', 'url']);
        assert.equal(s.lang, 'jpn');
      }
      assert.match(response.headers.get('cache-control'), /^public, max-age=900, stale-while-revalidate=\d+, stale-if-error=\d+$/);
    });

    it('takes the id with its colons encoded, as Stremio may send it', async () => {
      const { body } = await addon.getJson(`/${segment()}/subtitles/series/kitsu%3A46474%3A2.json`);
      assert.equal(body.subtitles.length, 3);
    });

    it('works without settings in the path when the server has a key', async () => {
      const own = await start({ JIMAKU_API_KEY: VALID_KEY });
      const { body } = await own.getJson('/subtitles/series/kitsu:46474:2.json');
      assert.equal(body.subtitles.length, 3);
    });

    it('gives a converted ASS address on this server, and that address works', async () => {
      const { body } = await addon.getJson(`/${segment()}/subtitles/series/kitsu:46474:2.json`);
      const converted = body.subtitles.find((s) => s.url.includes('/convert/'));
      assert.ok(converted.url.startsWith(`${addon.url}/convert/`));
      const response = await fetch(converted.url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/x-subrip; charset=utf-8');
      assert.match(response.headers.get('content-disposition'), /^inline; filename\*=UTF-8''/);
      assert.match(await response.text(), /^1\n00:00:01,000 --> 00:00:03,500\nおはよう、フリーレン。/);
    });

    it('reads the file name in the extra part whole, even when it holds "&" and "+"', async () => {
      const filename = 'Notes & [SubsPlease] Sousou no Frieren + - 02 (1080p) [A1B2C3D4].mkv';
      const extra = `videoHash=abc&videoSize=123&filename=${encodeURIComponent(filename)}`;
      const { body } = await addon.getJson(`/${segment()}/subtitles/series/kitsu:46474:2/${extra}.json`);
      assert.match(body.subtitles[0].label, /^SubsPlease/, 'the release named after the "&" still counted');
    });

    it('honours the settings in the path', async () => {
      const { body } = await addon.getJson(`/${segment({ assMode: 'both', maxSubtitles: 2 })}/subtitles/series/kitsu:46474:2.json`);
      assert.equal(body.subtitles.length, 2);
    });

    it('answers an empty list, not an error, for what it cannot find', async () => {
      for (const path of [`/${segment()}/subtitles/series/kitsu:999002:1.json`, `/${segment()}/subtitles/series/yt_id:x.json`, '/subtitles/movie/tt5311514.json', `/not-a-config/subtitles/series/kitsu:46474:2.json`]) {
        const { response, body } = await addon.getJson(path);
        assert.equal(response.status, 200, path);
        assert.deepEqual(body, { subtitles: [] }, path);
      }
    });

    it('answers an empty list when the key is wrong', async () => {
      const { response, body } = await addon.getJson(`/${encodeConfig({ jimakuApiKey: 'wrong-key-000' })}/subtitles/series/kitsu:46474:3.json`);
      assert.equal(response.status, 200);
      assert.deepEqual(body, { subtitles: [] });
      assert.equal(response.headers.get('cache-control'), 'public, max-age=120');
    });

    it('stops waiting for a slow upstream and answers empty, to stay inside Stremio’s patience', async () => {
      const impatient = await start({ REQUEST_TIMEOUT_MS: '150' });
      mock.delay(600);
      const started = Date.now();
      const { response, body } = await impatient.getJson(`/${segment()}/subtitles/series/kitsu:46474:5.json`);
      assert.ok(Date.now() - started < 450, 'answered well before the upstream did');
      assert.deepEqual(body, { subtitles: [] });
      assert.equal(response.headers.get('cache-control'), 'public, max-age=15');
      mock.delay(0);
      await new Promise((resolve) => setTimeout(resolve, 700)); // let the abandoned lookup finish
    });
  });

  describe('converter route', () => {
    let addon;
    before(async () => {
      addon = await start();
    });
    const tokenFor = (id, name) => toToken(`${mock.origin}/entry/${id}/download/${encodeURIComponent(name)}`);

    it('converts a file it is pointed at', async () => {
      const ass = FILES[101].find((f) => f.name.endsWith('.ass'));
      const response = await addon.get(`/convert/${tokenFor(101, ass.name)}.srt`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control'), /max-age=3600/);
    });

    it('answers in JSON with the right status when it cannot', async () => {
      const cases = [
        [`/convert/${toToken('http://169.254.169.254/entry/1/download/a.srt')}.srt`, 403],
        [`/convert/${toToken('http://127.0.0.1:1/entry/1/download/a.srt')}.srt`, 403],
        [`/convert/${toToken(`${mock.origin}/api/secret`)}.srt`, 400],
        [`/convert/${toToken('file:///etc/passwd')}.srt`, 400],
        [`/convert/${tokenFor(101, 'gone.srt')}.srt`, 404],
        [`/convert/${tokenFor(5, 'empty.srt')}.srt`, 422],
        ['/convert/!!!.srt', 400],
      ];
      for (const [path, status] of cases) {
        const { response, body } = await addon.getJson(path);
        assert.equal(response.status, status, path);
        assert.equal(typeof body.error, 'string');
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
    });

    it('never reaches an address that is not allowed', async () => {
      mock.requests.length = 0;
      await addon.get(`/convert/${toToken(`${mock.origin}/jimaku/entries/search`)}.srt`);
      assert.equal(mock.requests.length, 0);
    });

    describe('files inside ZIP archives', () => {
      const zipUrl = (name) => `${mock.origin}/entry/101/download/${encodeURIComponent(name)}`;
      const member = '[SubsPlease] Sousou no Frieren (1080p)/[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1235].ass';
      const memberToken = (name = FRIEREN_BATCH, path = member) => toMemberToken(zipUrl(name), path);

      it('serves a file from inside a ZIP, converted to SRT or as the styled ASS, by the suffix', async () => {
        const srt = await addon.get(`/convert/${memberToken()}.srt`);
        assert.equal(srt.status, 200);
        assert.equal(srt.headers.get('content-type'), 'application/x-subrip; charset=utf-8');
        assert.match(srt.headers.get('content-disposition'), /\.srt$/);
        assert.match(await srt.text(), /^1\n00:00:01,000 --> 00:00:03,500\nおはよう、フリーレン。 \(episode 5\)/);

        const ass = await addon.get(`/convert/${memberToken()}.ass`);
        assert.equal(ass.status, 200);
        assert.equal(ass.headers.get('content-type'), 'text/x-ssa; charset=utf-8');
        assert.match(ass.headers.get('content-disposition'), /\.ass$/);
        assert.match(await ass.text(), /^\[Script Info\]/);
      });

      it('answers in JSON with the right status when the archive or the file in it is the problem', async () => {
        const cases = [
          [`/convert/${memberToken(FRIEREN_BATCH, 'not/there.ass')}.srt`, 404],
          [`/convert/${memberToken('gone.zip')}.srt`, 404],
          [`/convert/${memberToken(FRIEREN_BROKEN)}.srt`, 422],
          [`/convert/${memberToken(FRIEREN_OTHER, 'Season 1/E05.srt')}.ass`, 422],
          [`/convert/${toMemberToken('http://169.254.169.254/entry/1/download/a.zip', 'a.srt')}.srt`, 403],
          [`/convert/${Buffer.from('{"u":5}').toString('base64url')}.srt`, 400],
        ];
        for (const [path, status] of cases) {
          const { response, body } = await addon.getJson(path);
          assert.equal(response.status, status, path.slice(0, 60));
          assert.equal(typeof body.error, 'string');
        }
      });

      it('end to end: an episode that is only in ZIPs is listed, and every address it lists works', async () => {
        const { body } = await addon.getJson(`/${segment({ assMode: 'both' })}/subtitles/series/kitsu:46474:5.json`);
        assert.equal(body.subtitles.length, 4);
        for (const subtitle of body.subtitles) {
          assert.ok(subtitle.url.startsWith(`${addon.url}/convert/`), subtitle.url.slice(0, 50));
          const response = await fetch(subtitle.url);
          assert.equal(response.status, 200, subtitle.label);
          assert.ok((await response.text()).length > 20, subtitle.label);
        }
      });
    });
  });

  describe('key check', () => {
    const post = (addon, body, headers = {}) => addon.getJson('/api/validate', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    let addon;
    before(async () => {
      addon = await start({ VALIDATE_PER_MINUTE: '100' });
    });

    it('says whether Jimaku accepts the key', async () => {
      const ok = await post(addon, { jimakuApiKey: VALID_KEY });
      assert.deepEqual(ok.body, { status: 'valid' });
      assert.equal(ok.response.headers.get('cache-control'), 'no-store');
      assert.deepEqual((await post(addon, { jimakuApiKey: 'wrong-key-000' })).body, { status: 'invalid' });
    });

    it('does not bother Jimaku with something that cannot be a key', async () => {
      mock.requests.length = 0;
      for (const key of ['short', 'has spaces in it', '', 'ключ-не-ascii-12345', 'x'.repeat(300)]) {
        assert.deepEqual((await post(addon, { jimakuApiKey: key })).body, { status: 'invalid' }, key.slice(0, 10));
      }
      assert.equal(mock.count('jimaku'), 0);
    });

    it('reports a busy Jimaku as such', async () => {
      mock.limitNext(1, 30);
      assert.deepEqual((await post(addon, { jimakuApiKey: VALID_KEY })).body, { status: 'rate_limited' });
    });

    it('turns away bad bodies', async () => {
      assert.equal((await post(addon, 'not json')).response.status, 400);
      const big = await post(addon, JSON.stringify({ jimakuApiKey: 'x'.repeat(5000) }));
      assert.equal(big.response.status, 413);
    });

    it('limits how often one visitor may ask', async () => {
      const limited = await start({ VALIDATE_PER_MINUTE: '3' });
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await post(limited, { jimakuApiKey: 'short' })).response.status);
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
      const { response } = await post(limited, { jimakuApiKey: 'short' });
      assert.equal(response.headers.get('retry-after'), '60');
    });
  });

  describe('what ends up in the logs', () => {
    it('never contains an API key or the settings segment, not even for a mistyped address', async () => {
      const lines = [];
      const logger = createLogger({ level: 'debug', format: 'json', stream: { write: (chunk) => lines.push(chunk) } });
      const addon = await start({}, { logger });
      const seg = segment();
      await addon.get(`/${seg}/manifest.json`);
      await addon.get(`/${seg}/subtitles/series/kitsu:46474:2.json`);
      await addon.get(`/${seg}/configure`);
      await addon.get(`/${seg}/mistyped/route`);
      await addon.get(`/${encodeConfig({ jimakuApiKey: 'wrong-key-000' })}/subtitles/series/kitsu:46474:3.json`);
      await addon.get(`/${seg}`);
      const log = lines.join('');
      assert.ok(log.includes('"path":"/<config>/manifest.json"'));
      assert.ok(lines.length >= 6);
      for (const secret of [VALID_KEY, seg, 'wrong-key-000', encodeConfig({ jimakuApiKey: 'wrong-key-000' })]) assert.ok(!log.includes(secret), 'a secret reached the log');
    });
  });
});

describe('clientIp', () => {
  const req = (peer, forwarded) => ({ socket: { remoteAddress: peer }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });

  it('believes the forwarded address only from a local proxy', () => {
    assert.equal(clientIp(req('127.0.0.1', '203.0.113.9, 10.0.0.1')), '203.0.113.9');
    assert.equal(clientIp(req('::ffff:10.1.2.3', '203.0.113.9')), '203.0.113.9');
    assert.equal(clientIp(req('172.17.0.2', '203.0.113.9')), '203.0.113.9');
  });

  it('ignores a forwarded address from anyone else, who could be lying', () => {
    assert.equal(clientIp(req('198.51.100.7', '203.0.113.9')), '198.51.100.7');
    assert.equal(clientIp(req('172.32.0.1', '203.0.113.9')), '172.32.0.1');
  });

  it('uses the peer when nothing is forwarded', () => {
    assert.equal(clientIp(req('198.51.100.7')), '198.51.100.7');
    assert.equal(clientIp({ socket: {}, headers: {} }), 'unknown');
  });
});
