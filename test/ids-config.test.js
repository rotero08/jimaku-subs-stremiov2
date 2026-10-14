import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseVideoId } from '../src/stremio/ids.js';
import { buildManifest } from '../src/stremio/manifest.js';
import { decodeConfig, encodeConfig } from '../src/stremio/userConfig.js';

describe('parseVideoId', () => {
  it('reads IMDb movies and series', () => {
    assert.deepEqual(parseVideoId('movie', 'tt5311514'), { kind: 'imdb', id: 'tt5311514', season: null, episode: null, movie: true });
    assert.deepEqual(parseVideoId('series', 'tt22248376:2:5'), { kind: 'imdb', id: 'tt22248376', season: 2, episode: 5, movie: false });
    assert.deepEqual(parseVideoId('series', 'tt22248376'), { kind: 'imdb', id: 'tt22248376', season: null, episode: null, movie: false });
  });

  it('ignores a season and episode on a movie', () => {
    assert.equal(parseVideoId('movie', 'tt5311514:1:1').season, null);
  });

  it('reads the anime id schemes', () => {
    assert.deepEqual(parseVideoId('anime', 'kitsu:46474:5'), { kind: 'kitsu', id: 46474, season: null, episode: 5, movie: false });
    assert.deepEqual(parseVideoId('series', 'mal:52991:12'), { kind: 'mal', id: 52991, season: null, episode: 12, movie: false });
    assert.equal(parseVideoId('anime', 'anilist:154587:1').kind, 'anilist');
    assert.equal(parseVideoId('anime', 'anidb:17617:3').kind, 'anidb');
    assert.equal(parseVideoId('movie', 'kitsu:12').episode, null);
  });

  it('refuses everything else', () => {
    for (const id of ['', 'yt_id:abc', 'kitsu:', 'kitsu:abc:1', 'kitsu:0', 'tt', 'ttabc', 'kitsu:99999999999']) {
      assert.equal(parseVideoId('series', id), null, id);
    }
    assert.equal(parseVideoId('series', undefined), null);
  });

  it('turns a non-numeric episode into "unknown"', () => {
    assert.equal(parseVideoId('anime', 'kitsu:46474:x').episode, null);
  });
});

describe('user config', () => {
  const KEY = 'abcDEF123456_-.xyz';

  it('round-trips and omits defaults from the link', () => {
    const segment = encodeConfig({ jimakuApiKey: KEY });
    assert.deepEqual(JSON.parse(Buffer.from(segment, 'base64url')), { jimakuApiKey: KEY });
    assert.deepEqual(decodeConfig(segment), { jimakuApiKey: KEY, assMode: 'srt', maxSubtitles: 10 });
    const custom = decodeConfig(encodeConfig({ jimakuApiKey: KEY, assMode: 'both', maxSubtitles: 4 }));
    assert.deepEqual(custom, { jimakuApiKey: KEY, assMode: 'both', maxSubtitles: 4 });
  });

  it('still reads links made by the first version (standard base64, padding, an OMDb key)', () => {
    const legacy = Buffer.from(JSON.stringify({ jimakuApiKey: KEY, omdbApiKey: 'abc123' })).toString('base64');
    assert.equal(decodeConfig(legacy).jimakuApiKey, KEY);
    assert.equal(decodeConfig(encodeURIComponent(legacy)).jimakuApiKey, KEY);
  });

  it('clamps and falls back on unknown values', () => {
    const odd = Buffer.from(JSON.stringify({ jimakuApiKey: KEY, assMode: 'weird', maxSubtitles: 999 })).toString('base64url');
    assert.deepEqual(decodeConfig(odd), { jimakuApiKey: KEY, assMode: 'srt', maxSubtitles: 30 });
  });

  it('rejects anything that is not a plausible config', () => {
    const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
    for (const bad of ['', 'short', '!!!!!!!!!!!!', b64('not json at all'), b64({}), b64({ jimakuApiKey: '' }), b64({ jimakuApiKey: 'has space in it here' }), b64({ jimakuApiKey: 'short' }), b64([KEY]), 'x'.repeat(3000)]) {
      assert.equal(decodeConfig(bad), null, bad.slice(0, 30));
    }
    assert.equal(decodeConfig(undefined), null);
  });
});

describe('manifest', () => {
  const base = { version: '3.0.0', baseUrl: 'https://addon.example' };

  it('declares the types and id schemes it can serve', () => {
    const m = buildManifest({ ...base, ready: true });
    assert.deepEqual(m.resources, ['subtitles']);
    assert.deepEqual(m.types, ['movie', 'series', 'anime']);
    assert.deepEqual(m.idPrefixes, ['tt', 'kitsu', 'mal', 'anilist', 'anidb']);
    assert.deepEqual(m.catalogs, []);
    assert.equal(m.logo, 'https://addon.example/logo.png');
  });

  it('asks for configuration until it can work', () => {
    assert.equal(buildManifest({ ...base, ready: false }).behaviorHints.configurationRequired, true);
    assert.equal(buildManifest({ ...base, ready: true }).behaviorHints.configurationRequired, false);
    assert.equal(buildManifest({ ...base, ready: false }).behaviorHints.configurable, true);
  });

  it('keeps an installed copy matching its first-version id', () => {
    assert.equal(buildManifest({ ...base, ready: true }).id, 'community.jimakukaiyo');
    assert.equal(buildManifest({ ...base, ready: true, config: 'eyJqaW1ha3VBcGlLZXki' }).id, 'community.jimakukaiyo.eyJqaW1h');
  });
});
