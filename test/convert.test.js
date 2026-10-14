import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FILES, FRIEREN_BATCH, FRIEREN_OTHER, startMockUpstream } from '../scripts/mock-upstream.js';
import { createArchiveService } from '../src/subs/archive.js';
import { assertDownloadUrl, ConvertError, createConverter, fromToken, parseToken, toMemberToken, toToken } from '../src/subs/convert.js';

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

describe('tokens', () => {
  const zip = 'https://jimaku.cc/entry/123/download/Show%20-%20Episodes%2001-12.zip';

  it('carry the address of a file, or of an archive and the path of a file in it', () => {
    assert.deepEqual(parseToken(toToken('https://jimaku.cc/entry/1/download/a.srt')), { url: 'https://jimaku.cc/entry/1/download/a.srt', member: null });
    const member = '字幕/[Group] フリーレン - 05 (1080p).ass';
    const token = toMemberToken(zip, member);
    assert.match(token, /^[A-Za-z0-9_-]+$/, 'safe in an address');
    assert.deepEqual(parseToken(token), { url: zip, member });
  });

  it('still read the tokens made before archives were supported', () => {
    // exactly what the previous version handed out: base64url of the bare address
    assert.deepEqual(parseToken('aHR0cHM6Ly9qaW1ha3UuY2MvZW50cnkvMS9kb3dubG9hZC9hLnNydA'), { url: 'https://jimaku.cc/entry/1/download/a.srt', member: null });
  });

  it('refuse a token that says something else', () => {
    const wrong = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
    for (const bad of ['{not json', { u: zip }, { f: 'a.srt' }, { u: 5, f: 'a.srt' }, { u: zip, f: '' }, { u: zip, f: 'x'.repeat(2000) }, { u: zip, f: ['a'] }]) {
      assert.throws(() => parseToken(wrong(bad)), (e) => e instanceof ConvertError && e.status === 400, JSON.stringify(bad).slice(0, 40));
    }
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
    assert.match(mock.requests[0].headers['user-agent'], /^jimaku-sakura-stremio\//);
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

describe('files inside ZIP archives', () => {
  let mock;
  let converter;
  const zipUrl = (name) => `${mock.origin}/entry/101/download/${encodeURIComponent(name)}`;
  const batchMember = (n) => `[SubsPlease] Sousou no Frieren (1080p)/[SubsPlease] Sousou no Frieren - 0${n} (1080p) [ABCD123${n}].ass`;
  const downloads = () => mock.requests.filter((r) => r.service === 'download');

  before(async () => {
    mock = await startMockUpstream();
  });
  after(() => mock.close());
  beforeEach(() => {
    mock.requests.length = 0;
    const config = mock.config();
    converter = createConverter({ config, archives: createArchiveService({ config }) });
  });

  it('turns an ASS file in a ZIP into SRT', async () => {
    const result = await converter.convert({ url: zipUrl(FRIEREN_BATCH), member: batchMember(5) });
    assert.equal(result.contentType, 'application/x-subrip; charset=utf-8');
    assert.equal(result.filename, '[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1235].srt', 'named after the file, not the folder');
    assert.match(result.body, /^1\n00:00:01,000 --> 00:00:03,500\nおはよう、フリーレン。 \(episode 5\)\n/);
  });

  it('decodes a Shift-JIS SRT in a ZIP, found by its Shift-JIS name', async () => {
    const result = await converter.convert({ url: zipUrl(FRIEREN_OTHER), member: 'Season 1/E05.srt' });
    assert.match(result.body, /こんにちは、世界。/);
    const named = await converter.convert({ url: zipUrl(FRIEREN_OTHER), member: 'フリーレン 第05話.srt' });
    assert.match(named.body, /こんにちは、世界。/);
    assert.equal(named.filename, 'フリーレン 第05話.srt');
  });

  it('hands over the ASS itself, in UTF-8, when the player is to have the styles', async () => {
    const result = await converter.convert({ url: zipUrl(FRIEREN_BATCH), member: batchMember(6) }, { as: 'ass' });
    assert.equal(result.contentType, 'text/x-ssa; charset=utf-8');
    assert.match(result.body, /^\[Script Info\]/);
    assert.match(result.body, /Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an8}おはよう、フリーレン。 \(episode 6\)/);
    assert.ok(!result.body.includes('\r'));
    assert.equal(result.filename, '[SubsPlease] Sousou no Frieren - 06 (1080p) [ABCD1236].ass');
  });

  it('does not pass an SRT off as ASS', async () => {
    await assert.rejects(converter.convert({ url: zipUrl(FRIEREN_OTHER), member: 'Season 1/E05.srt' }, { as: 'ass' }), (e) => e instanceof ConvertError && e.status === 422);
  });

  it('answers 404 for a path that is not in the archive, or is a folder', async () => {
    for (const member of ['nothing.srt', '[SubsPlease] Sousou no Frieren (1080p)/', 'Season 1/e05.srt']) {
      await assert.rejects(converter.convert({ url: zipUrl(FRIEREN_BATCH), member }), (e) => e instanceof ConvertError && e.status === 404, member);
    }
  });

  it('fetches an archive once for all the files taken from it', async () => {
    await Promise.all([4, 5, 6].map((n) => converter.convert({ url: zipUrl(FRIEREN_BATCH), member: batchMember(n) })));
    assert.equal(downloads().length, 1);
  });

  it('keeps ASS and SRT results of the same file apart', async () => {
    const source = { url: zipUrl(FRIEREN_BATCH), member: batchMember(5) };
    const srt = await converter.convert(source);
    const ass = await converter.convert(source, { as: 'ass' });
    assert.notEqual(srt.body, ass.body);
    assert.equal(await converter.convert(source), srt);
  });

  it('refuses an address off the allowed hosts, before fetching anything', async () => {
    await assert.rejects(converter.convert({ url: 'https://evil.example/entry/1/download/a.zip', member: 'a.srt' }), (e) => e.status === 403);
    assert.equal(mock.requests.length, 0);
  });

  it('says so when this server was built without archive support', async () => {
    const without = createConverter({ config: mock.config() });
    await assert.rejects(without.convert({ url: zipUrl(FRIEREN_BATCH), member: batchMember(5) }), (e) => e instanceof ConvertError && e.status === 501);
  });
});
