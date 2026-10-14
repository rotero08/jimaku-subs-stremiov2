import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FILES, FRIEREN_BATCH, FRIEREN_BROKEN, FRIEREN_RAR, startMockUpstream } from '../scripts/mock-upstream.js';
import { makeZip } from '../scripts/zip-writer.js';
import { TAIL_BYTES } from '../src/subs/zip.js';
import { createArchiveService } from '../src/subs/archive.js';
import { ConvertError } from '../src/subs/convert.js';

describe('archive service', () => {
  let mock;
  let archives;
  const url = (id, name) => `${mock.origin}/entry/${id}/download/${encodeURIComponent(name)}`;
  const downloads = () => mock.requests.filter((r) => r.service === 'download');
  const service = (env = {}, extra = {}) => createArchiveService({ config: mock.config(env), ...extra });
  const rejectsWith = (promise, status, pattern) =>
    assert.rejects(promise, (error) => error instanceof ConvertError && error.status === status && (!pattern || pattern.test(error.message)), `expected a ConvertError ${status}`);

  // Files that only one test needs, added to entry 103 and taken away again.
  const added = [];
  const serve = (name, body) => {
    FILES[103].push({ name, episode: null, body });
    added.push(name);
    return url(103, name);
  };
  const subtitle = (n) => `${n}\n00:00:01,000 --> 00:00:02,000\nline ${n}\n`;

  before(async () => {
    mock = await startMockUpstream();
  });
  after(async () => {
    await mock.close();
  });
  beforeEach(() => {
    mock.requests.length = 0;
    mock.ranges('on');
    mock.resetBytes();
    archives = service();
    for (const name of added.splice(0)) FILES[103].splice(FILES[103].findIndex((f) => f.name === name), 1);
  });

  it('opens a small archive with one request, and reads its files without another', async () => {
    const archive = await archives.open(url(101, FRIEREN_BATCH));
    assert.equal(downloads().length, 1);
    assert.equal(downloads()[0].headers.range, `bytes=-${TAIL_BYTES}`);
    assert.deepEqual(archive.entries.filter((e) => /\.ass$/.test(e.path) && !e.path.startsWith('__MACOSX')).map((e) => e.path.split('/').pop().replace(/ \[[0-9A-F]{8}\]/, '')), [
      '[SubsPlease] Sousou no Frieren - 04 (1080p).ass',
      '[SubsPlease] Sousou no Frieren - 05 (1080p).ass',
      '[SubsPlease] Sousou no Frieren - 06 (1080p).ass',
    ]);
    const entry = archive.entries.find((e) => / - 05 .*\.ass$/.test(e.path) && !e.path.startsWith('__MACOSX'));
    assert.match((await archives.read(archive, entry)).toString('utf8'), /\[Script Info\]/);
    assert.equal(downloads().length, 1, 'the archive was small enough that its end was all of it');
  });

  it('reads a large archive in pieces: the end of it, then the one file wanted', async () => {
    const big = serve('Big pack.zip', makeZip([{ name: 'Show - 05.srt', data: subtitle(5) }, { name: 'Fonts/huge.otf', data: Buffer.alloc(3 * 1024 * 1024, 9), store: true }, { name: 'Show - 06.srt', data: subtitle(6) }]));
    const archive = await archives.open(big);
    assert.equal(archive.size > 3 * 1024 * 1024, true);
    assert.equal(downloads().length, 1);
    assert.ok(mock.bytesSent() <= TAIL_BYTES, `${mock.bytesSent()} bytes for the directory of a ${archive.size} byte archive`);

    const text = (await archives.read(archive, archive.entries.find((e) => e.path === 'Show - 05.srt'))).toString('utf8');
    assert.equal(text, subtitle(5));
    assert.equal(downloads().length, 2);
    assert.match(downloads()[1].headers.range, /^bytes=\d+-\d+$/);
    assert.ok(mock.bytesSent() < TAIL_BYTES + 4096, `${mock.bytesSent()} bytes in all, for a ${archive.size} byte archive`);
  });

  it('still works when the server ignores Range, if the archive is small enough', async () => {
    mock.ranges('off');
    const archive = await archives.open(url(101, FRIEREN_BATCH));
    const entry = archive.entries.find((e) => / - 06 .*\.ass$/.test(e.path) && !e.path.startsWith('__MACOSX'));
    assert.match((await archives.read(archive, entry)).toString('utf8'), /episode 6/);
    assert.equal(downloads().length, 1);
  });

  it('refuses an archive over the limit when the server sends it whole, and does not try again for a while', async () => {
    mock.ranges('off');
    const big = serve('Whole.zip', makeZip([{ name: 'a.srt', data: subtitle(1) }, { name: 'pad.bin', data: Buffer.alloc(2 * 1024 * 1024, 3), store: true }]));
    const small = service({ MAX_ARCHIVE_BYTES: String(1024 * 1024) });
    await rejectsWith(small.open(big), 413, /too large/);
    await rejectsWith(small.open(big), 413, /too large/);
    assert.equal(downloads().length, 1, 'the refusal is remembered');
  });

  it('asks for the whole file when a server will not answer a suffix range', async () => {
    mock.ranges('suffix-416');
    const tiny = serve('Tiny.zip', makeZip([{ name: 'a.srt', data: subtitle(1) }]));
    const archive = await archives.open(tiny);
    assert.equal(archive.entries.length, 1);
    assert.deepEqual(downloads().map((r) => r.headers.range ?? 'whole'), [`bytes=-${TAIL_BYTES}`, 'whole']);
  });

  it('asks once for archives opened together, and remembers their directory', async () => {
    const address = url(101, FRIEREN_BATCH);
    const [a, b, c] = await Promise.all([archives.open(address), archives.open(address), archives.open(address)]);
    assert.equal(downloads().length, 1);
    assert.equal(a, b);
    assert.equal(b, c);
    await archives.open(address);
    assert.equal(downloads().length, 1);
  });

  it('answers 404 for an archive that is gone, and remembers that', async () => {
    await rejectsWith(archives.open(url(101, 'gone.zip')), 404);
    await rejectsWith(archives.open(url(101, 'gone.zip')), 404);
    assert.equal(downloads().length, 1);
  });

  it('says 422 for a file that is not a ZIP, whatever it pretends', async () => {
    await rejectsWith(archives.open(url(101, FRIEREN_BROKEN)), 422, /ZIP/);
    await rejectsWith(archives.open(url(101, FRIEREN_RAR)), 422, /ZIP/);
  });

  it('does not remember a network failure: the next try asks again', async () => {
    let calls = 0;
    const flaky = createArchiveService({
      config: mock.config(),
      fetchImpl: async () => {
        calls++;
        throw new TypeError('fetch failed');
      },
    });
    await rejectsWith(flaky.open(url(101, FRIEREN_BATCH)), 502);
    await rejectsWith(flaky.open(url(101, FRIEREN_BATCH)), 502);
    assert.equal(calls, 2);
  });

  it('only fetches Jimaku downloads on the allowed hosts, and follows no redirect off them', async () => {
    await rejectsWith(archives.open('https://evil.example/entry/1/download/a.zip'), 403);
    await rejectsWith(archives.open('http://169.254.169.254/entry/1/download/a.zip'), 403);
    await rejectsWith(archives.open(`${mock.origin}/api/entries/1/files`), 400);
    assert.equal(mock.requests.length, 0);
    await rejectsWith(archives.open(url(1, 'redirect-away')), 502, /refused/);
    assert.equal(downloads().length, 1, 'the address it was sent to was never contacted');
  });

  it('cannot read a file that is protected, too large, or in a form it does not know', async () => {
    const odd = serve(
      'Odd.zip',
      makeZip([
        { name: 'locked.srt', data: subtitle(1), encrypted: true },
        { name: 'lzma.srt', data: subtitle(2), method: 14 },
        { name: 'big.srt', data: Buffer.alloc(5000, 0x41), store: true },
        { name: 'fine.srt', data: subtitle(3) },
      ]),
    );
    const small = service({ MAX_SUBTITLE_BYTES: '1000' });
    const archive = await small.open(odd);
    const of = (path) => archive.entries.find((e) => e.path === path);
    await rejectsWith(small.read(archive, of('locked.srt')), 422, /password/);
    await rejectsWith(small.read(archive, of('lzma.srt')), 422, /method 14/);
    await rejectsWith(small.read(archive, of('big.srt')), 413, /too large/);
    assert.equal((await small.read(archive, of('fine.srt'))).toString(), subtitle(3));
  });
});
