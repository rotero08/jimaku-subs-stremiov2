import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FILES, startMockUpstream } from '../scripts/mock-upstream.js';
import { assertDownloadUrl, ConvertError, createConverter, fromToken, toToken } from '../src/subs/convert.js';

describe('assertDownloadUrl', () => {
  const hosts = ['jimaku.cc'];
  const ok = 'https://jimaku.cc/entry/123/download/%5BGroup%5D%20Show%20-%2001.ass';

  it('accepts a Jimaku download address', () => {
    assert.equal(assertDownloadUrl(ok, hosts).host, 'jimaku.cc');
    assert.doesNotThrow(() => assertDownloadUrl('https://JIMAKU.cc/entry/9/download/a.srt', hosts));
  });

  it('refuses everything else, with the status a caller should answer', () => {
    const refused = {
      'not a url at all': 400,
      'file:///etc/passwd': 400,
      'ftp://jimaku.cc/entry/1/download/a.srt': 400,
      'https://user:pass@jimaku.cc/entry/1/download/a.srt': 400,
      'https://evil.example/entry/1/download/a.srt': 403,
      'https://jimaku.cc.evil.example/entry/1/download/a.srt': 403,
      'https://evil.example/@jimaku.cc/entry/1/download/a.srt': 403,
      'https://jimaku.cc:8443/entry/1/download/a.srt': 403,
      'http://169.254.169.254/entry/1/download/a.srt': 403,
      'http://localhost:7000/entry/1/download/a.srt': 403,
      'https://jimaku.cc/api/entries/1/files': 400,
      'https://jimaku.cc/entry/abc/download/a.srt': 400,
      'https://jimaku.cc/entry/1/download/': 400,
      'https://jimaku.cc/entry/1/download/a/b.srt': 400,
      'https://jimaku.cc/entry/1/download/..%2f..%2fadmin': 400,
      'https://jimaku.cc/entry/1/download/../../admin': 400,
    };
    for (const [url, status] of Object.entries(refused)) {
      assert.throws(() => assertDownloadUrl(url, hosts), (e) => e instanceof ConvertError && e.status === status, `${url} should be ${status}`);
    }
  });

  it('round-trips an address through the token', () => {
    assert.equal(fromToken(toToken(ok)), ok);
    assert.match(toToken(ok), /^[A-Za-z0-9_-]+$/);
  });
});

describe('converter', () => {
  let mock;
  let converter;
  const url = (id, name) => `${mock.origin}/entry/${id}/download/${encodeURIComponent(name)}`;
  const fileOf = (id, predicate) => FILES[id].find((f) => predicate(f.name));

  before(async () => {
    mock = await startMockUpstream();
  });
  after(() => mock.close());
  beforeEach(() => {
    mock.requests.length = 0;
    converter = createConverter({ config: mock.config({ MAX_SUBTITLE_BYTES: '1048576' }) });
  });

  it('turns an ASS file into SRT', async () => {
    const ass = fileOf(101, (n) => n.endsWith('.ass'));
    const result = await converter.convert(url(101, ass.name));
    assert.equal(result.contentType, 'application/x-subrip; charset=utf-8');
    assert.equal(result.filename, ass.name.replace(/\.ass$/, '') + '.srt');
    assert.equal(
      result.body,
      '1\n00:00:01,000 --> 00:00:03,500\nおはよう、フリーレン。\n\n2\n00:00:04,000 --> 00:00:06,200\n<i>…そうだね。</i>\n旅を続けよう。\n\n3\n00:00:07,000 --> 00:00:09,000\nありがとう。\n',
    );
  });

  it('turns a Shift-JIS SRT into UTF-8', async () => {
    const sjis = fileOf(101, (n) => n.endsWith('.ja.srt'));
    const result = await converter.convert(url(101, sjis.name));
    assert.match(result.body, /こんにちは、世界。/);
    assert.ok(!result.body.includes('\r'), 'line endings are normalised');
  });

  it('passes a UTF-8 SRT through', async () => {
    const srt = fileOf(101, (n) => n.startsWith('[Erai-raws]'));
    const result = await converter.convert(url(101, srt.name));
    assert.match(result.body, /^1\n00:00:01,000 --> 00:00:03,500\nおはよう、フリーレン。/);
  });

  it('remembers a file, so repeat requests cost nothing', async () => {
    const srt = fileOf(101, (n) => n.startsWith('[Erai-raws]'));
    const first = await converter.convert(url(101, srt.name));
    const second = await converter.convert(url(101, srt.name));
    assert.equal(first, second);
    assert.equal(mock.count('download'), 1);
  });

  it('shares one download between requests made together', async () => {
    const srt = fileOf(101, (n) => n.startsWith('[Erai-raws]'));
    await Promise.all([1, 2, 3].map(() => converter.convert(url(101, srt.name))));
    assert.equal(mock.count('download'), 1);
  });

  it('sends its User-Agent', async () => {
    const srt = fileOf(101, (n) => n.startsWith('[Erai-raws]'));
    await converter.convert(url(101, srt.name));
    assert.match(mock.requests[0].headers['user-agent'], /^jimaku-subs-stremio\//);
  });

  it('follows a redirect that stays on an allowed host', async () => {
    const result = await converter.convert(url(5, 'redirect-inside'));
    assert.match(result.body, /00:00:01,000 --> 00:00:03,500/);
  });

  it('refuses a redirect that leaves the allowed hosts', async () => {
    await assert.rejects(converter.convert(url(5, 'redirect-away')), (e) => e instanceof ConvertError && e.status === 502 && /169\.254\.169\.254 refused/.test(e.message));
    assert.equal(mock.count('download'), 1, 'the second address was never contacted');
  });

  it('gives up on a redirect loop', async () => {
    await assert.rejects(converter.convert(url(1, 'redirect-loop')), (e) => e instanceof ConvertError && e.status === 502);
  });

  it('refuses a file over the size limit', async () => {
    await assert.rejects(converter.convert(url(5, 'huge.srt')), (e) => e instanceof ConvertError && e.status === 413);
  });

  it('answers 404 for a file that is gone, 422 for one with nothing in it', async () => {
    await assert.rejects(converter.convert(url(101, 'gone.srt')), (e) => e.status === 404);
    await assert.rejects(converter.convert(url(5, 'empty.srt')), (e) => e.status === 422);
  });

  it('survives a file name with a stray percent sign', async () => {
    const result = await converter.convert(`${mock.origin}/entry/5/download/broken-name%.srt`);
    assert.equal(result.filename, 'broken-name%.srt', 'the extension is not doubled');
  });

  it('does not contact anything for a refused address', async () => {
    await assert.rejects(converter.convert('http://169.254.169.254/entry/1/download/a.srt'), (e) => e.status === 403);
    await assert.rejects(converter.convert(`${mock.origin}/not-a-download`), (e) => e.status === 400);
    assert.equal(mock.requests.length, 0);
  });

  it('does not cache failures', async () => {
    await assert.rejects(converter.convert(url(101, 'later.srt')));
    FILES[101].push({ name: 'later.srt', episode: 9, body: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nあ\n') });
    try {
      assert.match((await converter.convert(url(101, 'later.srt'))).body, /あ/);
    } finally {
      FILES[101].pop();
    }
  });
});
