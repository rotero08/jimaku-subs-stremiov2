import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startMockUpstream, VALID_KEY } from '../scripts/mock-upstream.js';
import { createJimakuClient } from '../src/jimaku/client.js';
import { silentLogger } from '../src/logger.js';
import { createAniList } from '../src/meta/anilist.js';
import { createCinemeta } from '../src/meta/cinemeta.js';
import { createKitsu } from '../src/meta/kitsu.js';
import { buildSubtitles, createSubtitleService } from '../src/stremio/subtitles.js';
import { fromToken } from '../src/subs/convert.js';

const BASE = 'https://addon.example';
const entry = { id: 7 };
const files = [
  { name: '[SubsPlease] Show - 05 (1080p) [A1B2C3D4].ass', url: 'https://jimaku.cc/entry/7/download/a.ass' },
  { name: '[Erai-raws] Show - 05 [1080p].srt', url: 'https://jimaku.cc/entry/7/download/b.srt' },
  { name: 'Show - 05.vtt', url: 'https://jimaku.cc/entry/7/download/c.vtt' },
  { name: 'Show - 05.zip', url: 'https://jimaku.cc/entry/7/download/d.zip' },
  { name: 'notes.txt', url: 'https://jimaku.cc/entry/7/download/e.txt' },
];

describe('buildSubtitles', () => {
  const build = (extra = {}) => buildSubtitles({ entry, files, assMode: 'srt', baseUrl: BASE, ...extra });

  it('keeps the formats Stremio can show and drops archives and the rest', () => {
    const urls = build().map((s) => s.url);
    assert.equal(urls.length, 3);
    assert.ok(!urls.some((u) => /\.(zip|txt)$/.test(u)));
  });

  it('sends SRT and VTT straight from Jimaku, and ASS through the converter', () => {
    const subs = build();
    assert.ok(subs.some((s) => s.url === 'https://jimaku.cc/entry/7/download/b.srt'));
    assert.ok(subs.some((s) => s.url === 'https://jimaku.cc/entry/7/download/c.vtt'));
    const converted = subs.find((s) => s.url.startsWith(`${BASE}/convert/`));
    assert.match(converted.url, /^https:\/\/addon\.example\/convert\/[A-Za-z0-9_-]+\.srt$/);
    assert.equal(fromToken(converted.url.slice(`${BASE}/convert/`.length).replace(/\.srt$/, '')), files[0].url);
  });

  it('offers the original ASS when asked, or both', () => {
    const ass = build({ assMode: 'ass' });
    assert.equal(ass.length, 3);
    assert.ok(ass.some((s) => s.url === files[0].url));
    assert.ok(!ass.some((s) => s.url.includes('/convert/')));

    const both = build({ assMode: 'both' });
    assert.equal(both.length, 4);
    assert.ok(both.some((s) => s.url === files[0].url) && both.some((s) => s.url.includes('/convert/')));
  });

  it('fills in what Stremio needs: unique ids, Japanese, a label', () => {
    const subs = build({ assMode: 'both' });
    assert.equal(new Set(subs.map((s) => s.id)).size, subs.length);
    for (const s of subs) {
      assert.equal(s.lang, 'jpn');
      assert.ok(s.label.length > 0 && s.label.length < 60);
      assert.match(s.id, /^jimaku-7-[0-9a-f]{10}(-srt|-ass)?$/);
    }
    assert.ok(subs.some((s) => s.label === 'SubsPlease · 1080p · ASS→SRT'));
  });

  it('gives the same ids on every call, so Stremio can remember a choice', () => {
    assert.deepEqual(build().map((s) => s.id), build().map((s) => s.id));
  });

  it('puts the subtitle made for the video being played first', () => {
    const first = (videoName) => build({ videoName })[0];
    assert.match(first('[SubsPlease] Show - 05 (1080p) [A1B2C3D4].mkv').label, /^SubsPlease/);
    assert.match(first('[Erai-raws] Show - 05 [1080p][HEVC].mkv').label, /^Erai-raws/);
  });

  it('prefers plain SRT and VTT, then converted ASS, when nothing tells the releases apart', () => {
    assert.deepEqual(
      build().map((s) => s.label),
      ['Erai-raws · 1080p · SRT', 'Show - 05 · VTT', 'SubsPlease · 1080p · ASS→SRT'],
    );
  });
});

describe('subtitle service', () => {
  let mock;
  let service;
  const config = () => mock.config();
  const user = (extra = {}) => ({ jimakuApiKey: VALID_KEY, assMode: 'srt', maxSubtitles: 10, ...extra });

  const ask = (type, id, options = {}) => service.getSubtitles({ type, id, user: user(), baseUrl: BASE, ...options });
  const names = (result) => result.subtitles.map((s) => s.label);
  const jimakuCalls = () => mock.requests.filter((r) => r.service === 'jimaku');

  before(async () => {
    mock = await startMockUpstream();
  });
  after(() => mock.close());
  beforeEach(() => {
    // a fresh service per test: no memory of earlier answers
    const c = config();
    mock.requests.length = 0;
    mock.limitNext(0, 0);
    mock.failNext(500, 0);
    service = createSubtitleService({
      config: c,
      jimaku: createJimakuClient({ config: c, sleep: async () => {} }),
      kitsu: createKitsu({ config: c }),
      anilist: createAniList({ config: c }),
      cinemeta: createCinemeta({ config: c }),
      logger: silentLogger,
    });
  });

  describe('anime ids', () => {
    it('Kitsu: maps to AniList and lists that episode’s files', async () => {
      const result = await ask('anime', 'kitsu:46474:2');
      assert.equal(result.subtitles.length, 3);
      assert.ok(result.subtitles.every((s) => s.id.startsWith('jimaku-101-')));
      assert.equal(result.cacheMaxAge, 900);
      assert.deepEqual(jimakuCalls().map((r) => r.path), ['/jimaku/entries/search', '/jimaku/entries/101/files']);
      assert.equal(jimakuCalls()[0].query.anilist_id, '154587');
      assert.equal(jimakuCalls()[1].query.episode, '2');
    });

    it('AniList, MAL and AniDB ids reach the same entry', async () => {
      const labels = names(await ask('anime', 'kitsu:46474:2'));
      assert.deepEqual(names(await ask('anime', 'anilist:154587:2')), labels);
      assert.deepEqual(names(await ask('anime', 'mal:52991:2')), labels);
      assert.deepEqual(names(await ask('anime', 'anidb:17617:2')), labels);
    });

    it('does not search by title when the id is exact, even when the entry has nothing yet', async () => {
      const result = await ask('anime', 'kitsu:46474:99');
      assert.equal(result.subtitles.length, 0, 'the .zip is not a subtitle, and no other file names episode 99');
      assert.ok(!jimakuCalls().some((r) => r.query.query), 'no title search');
    });

    it('falls back to the title when Kitsu has no AniList id, and takes only the close match', async () => {
      const result = await ask('anime', 'kitsu:999001:5');
      assert.deepEqual(result.subtitles.map((s) => s.id.split('-')[1]), ['103'], 'not the 2nd Season entry');
      assert.ok(jimakuCalls().filter((r) => r.query.query).length <= 2);
    });

    it('says nothing is there for a title Jimaku does not have, and remembers for ten minutes', async () => {
      const result = await ask('anime', 'kitsu:999002:1');
      assert.deepEqual(result, { subtitles: [], cacheMaxAge: 600 });
    });

    it('does not mistake an unknown AniDB or MAL id for something else', async () => {
      assert.deepEqual(await ask('anime', 'anidb:1:1'), { subtitles: [], cacheMaxAge: 600 });
      assert.deepEqual(await ask('anime', 'mal:1:1'), { subtitles: [], cacheMaxAge: 600 });
    });
  });

  describe('IMDb ids', () => {
    it('a series: Cinemeta gives the TMDB id, TMDB finds the entry', async () => {
      const result = await ask('series', 'tt22248376:1:2');
      assert.equal(result.subtitles.length, 3);
      assert.ok(result.subtitles.every((s) => s.id.startsWith('jimaku-101-')));
      assert.equal(jimakuCalls()[0].query.tmdb_id, 'tv:209867');
    });

    it('a movie: asks for movie:ID and ignores any episode', async () => {
      const result = await ask('movie', 'tt5311514');
      assert.equal(jimakuCalls()[0].query.tmdb_id, 'movie:372058');
      assert.equal('episode' in jimakuCalls()[1].query, false);
      assert.ok(result.subtitles.length >= 2);
      assert.ok(result.subtitles.every((s) => s.id.startsWith('jimaku-102-')));
    });

    it('a show kept as one entry per season: takes the season that was asked for', async () => {
      const s2 = await ask('series', 'tt2560140:2:5');
      assert.deepEqual([...new Set(s2.subtitles.map((s) => s.id.split('-')[1]))], ['104']);
      const s1 = await ask('series', 'tt2560140:1:5');
      assert.deepEqual([...new Set(s1.subtitles.map((s) => s.id.split('-')[1]))], ['103']);
    });

    it('a season Jimaku has no entry for gives nothing, not another season’s subtitles', async () => {
      mock.requests.length = 0;
      const result = await ask('series', 'tt2560140:4:5');
      assert.deepEqual(result.subtitles, []);
      assert.ok(!jimakuCalls().some((r) => r.query.query), 'and no title search that could turn up the wrong one');
      assert.ok(!jimakuCalls().some((r) => r.path.endsWith('/files')));
    });

    it('a single entry holding several seasons: filters its files by season', async () => {
      const s1 = await ask('series', 'tt9990001:1:3');
      assert.deepEqual(names(s1).map((l) => l.replace(/ ·.*/, '')), ['Hanzawa Naoki S01E03']);
      const s2 = await ask('series', 'tt9990001:2:3');
      assert.deepEqual(names(s2).map((l) => l.replace(/ ·.*/, '')), ['Hanzawa Naoki S02E03']);
    });

    it('a title Cinemeta does not know gives nothing', async () => {
      assert.deepEqual(await ask('series', 'tt0000404:1:1'), { subtitles: [], cacheMaxAge: 600 });
    });

    it('a cartoon that is not on Jimaku gives nothing', async () => {
      assert.deepEqual(await ask('series', 'tt9990002:1:1'), { subtitles: [], cacheMaxAge: 600 });
    });
  });

  describe('settings and requests', () => {
    it('honours assMode and the limit', async () => {
      const both = await ask('anime', 'kitsu:46474:2', { user: user({ assMode: 'both' }) });
      assert.equal(both.subtitles.length, 4);
      const two = await ask('anime', 'kitsu:46474:2', { user: user({ maxSubtitles: 2 }) });
      assert.equal(two.subtitles.length, 2);
    });

    it('uses the file name Stremio sends to put the matching release first', async () => {
      const result = await ask('anime', 'kitsu:46474:2', { extra: { filename: '[SubsPlease] Sousou no Frieren - 02 (1080p) [A1B2C3D4].mkv' } });
      assert.match(result.subtitles[0].label, /^SubsPlease/);
      const other = await ask('anime', 'kitsu:46474:2', { extra: { filename: '[Erai-raws] Sousou no Frieren - 02 [1080p][Multiple Subtitle].mkv' } });
      assert.match(other.subtitles[0].label, /^Erai-raws/);
    });

    it('uses the server’s own key when the visitor has none, and nothing when there is no key at all', async () => {
      const c = { ...config(), serverKey: VALID_KEY };
      const withKey = createSubtitleService({ config: c, jimaku: createJimakuClient({ config: c, sleep: async () => {} }), kitsu: createKitsu({ config: c }), anilist: createAniList({ config: c }), cinemeta: createCinemeta({ config: c }), logger: silentLogger });
      assert.equal((await withKey.getSubtitles({ type: 'anime', id: 'kitsu:46474:2', user: null, baseUrl: BASE })).subtitles.length, 3);

      mock.requests.length = 0;
      assert.deepEqual(await service.getSubtitles({ type: 'anime', id: 'kitsu:46474:2', user: null, baseUrl: BASE }), { subtitles: [], cacheMaxAge: 60 });
      assert.equal(mock.requests.length, 0);
    });

    it('ignores ids it does not handle, without calling anyone', async () => {
      assert.deepEqual(await ask('series', 'yt_id:abc:1'), { subtitles: [], cacheMaxAge: 3600 });
      assert.deepEqual(await ask('channel', 'whatever'), { subtitles: [], cacheMaxAge: 3600 });
      assert.equal(mock.requests.length, 0);
    });
  });

  describe('when things go wrong', () => {
    it('a rejected key gives an empty list for two minutes', async () => {
      assert.deepEqual(await ask('anime', 'kitsu:46474:2', { user: user({ jimakuApiKey: 'wrong-key-000' }) }), { subtitles: [], cacheMaxAge: 120 });
    });

    it('a rate limit gives an empty list and a short wait', async () => {
      mock.limitNext(1, 30);
      const result = await ask('anime', 'kitsu:46474:2');
      assert.deepEqual(result.subtitles, []);
      assert.equal(result.cacheMaxAge, 30);
    });

    it('a Jimaku outage gives an empty list for half a minute', async () => {
      mock.failNext(500, 2);
      assert.deepEqual(await ask('anime', 'kitsu:46474:2'), { subtitles: [], cacheMaxAge: 30 });
    });

    it('a metadata outage gives an empty list too', async () => {
      const c = mock.config({ KITSU_API_URL: 'http://127.0.0.1:9' });
      const broken = createSubtitleService({ config: c, jimaku: createJimakuClient({ config: c, sleep: async () => {} }), kitsu: createKitsu({ config: c }), anilist: createAniList({ config: c }), cinemeta: createCinemeta({ config: c }), logger: silentLogger });
      assert.deepEqual(await broken.getSubtitles({ type: 'anime', id: 'kitsu:46474:2', user: user(), baseUrl: BASE }), { subtitles: [], cacheMaxAge: 30 });
    });
  });
});
