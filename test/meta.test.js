import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startMockUpstream } from '../scripts/mock-upstream.js';
import { createAniList } from '../src/meta/anilist.js';
import { createCinemeta } from '../src/meta/cinemeta.js';
import { createKitsu } from '../src/meta/kitsu.js';

describe('metadata lookups', () => {
  let mock;
  let config;

  before(async () => {
    mock = await startMockUpstream();
    config = mock.config();
  });
  after(() => mock.close());
  beforeEach(() => {
    mock.requests.length = 0;
  });

  describe('Kitsu', () => {
    it('finds the AniList id Kitsu recorded, and remembers it', async () => {
      const kitsu = createKitsu({ config });
      assert.equal(await kitsu.anilistId(46474), 154587);
      assert.equal(await kitsu.anilistId(46474), 154587);
      assert.equal(mock.count('kitsu'), 1);
      const [request] = mock.requests;
      assert.equal(request.path, '/kitsu/anime/46474/mappings');
      assert.equal(request.query['filter[externalSite]'], 'anilist/anime');
      assert.equal(request.headers.accept, 'application/vnd.api+json');
      assert.match(request.headers['user-agent'], /jimaku-sakura-stremio/);
    });

    it('says null when Kitsu has no mapping, or does not know the anime', async () => {
      const kitsu = createKitsu({ config });
      assert.equal(await kitsu.anilistId(999001), null);
      assert.equal(await kitsu.anilistId(12345678), null);
    });

    it('lists every title it knows, once each', async () => {
      const titles = await createKitsu({ config }).titles(46474);
      assert.deepEqual(titles, ['Sousou no Frieren', "Frieren: Beyond Journey's End", '葬送のフリーレン']);
      assert.deepEqual(await createKitsu({ config }).titles(12345678), []);
    });

    it('turns an AniDB id into a Kitsu id', async () => {
      const kitsu = createKitsu({ config });
      assert.equal(await kitsu.kitsuIdFromAnidb(17617), 46474);
      assert.equal(await kitsu.kitsuIdFromAnidb(1), null);
    });

    it('prefers the series to a recap special that shares its AniDB id', async () => {
      assert.equal(await createKitsu({ config }).kitsuIdFromAnidb(23), 1);
    });

    it('lets a real failure through, so it is not mistaken for "no mapping"', async () => {
      const kitsu = createKitsu({ config: mock.config({ KITSU_API_URL: `${mock.origin}/nowhere/` }) });
      // /nowhere/... is a 404 on the mock, which is the same as "not found": null
      assert.equal(await kitsu.anilistId(46474), null);
      const down = createKitsu({ config: mock.config({ KITSU_API_URL: 'http://127.0.0.1:9' }) });
      await assert.rejects(down.anilistId(46474), /network error/);
    });
  });

  describe('AniList', () => {
    it('turns a MyAnimeList id into an AniList id', async () => {
      const anilist = createAniList({ config });
      assert.equal(await anilist.idFromMal(52991), 154587);
      assert.equal(await anilist.idFromMal(52991), 154587);
      assert.equal(mock.count('anilist'), 1, 'remembered');
      const [request] = mock.requests;
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['content-type'], 'application/json');
    });

    it('says null when AniList does not know the id (it answers 404)', async () => {
      assert.equal(await createAniList({ config }).idFromMal(1), null);
    });
  });

  describe('Cinemeta', () => {
    it('gives the name, the TMDB id and whether it is anime', async () => {
      const cinemeta = createCinemeta({ config });
      assert.deepEqual(await cinemeta.meta('series', 'tt22248376'), {
        name: "Frieren: Beyond Journey's End",
        year: '2023–',
        tmdbId: 209867,
        anime: true,
      });
      assert.equal((await cinemeta.meta('movie', 'tt5311514')).tmdbId, 372058);
    });

    it('does not take a Western cartoon, or live action, for anime', async () => {
      const cinemeta = createCinemeta({ config });
      assert.equal((await cinemeta.meta('series', 'tt9990002')).anime, false);
      assert.equal((await cinemeta.meta('series', 'tt9990001')).anime, false);
    });

    it('says null for an id it does not know (an empty meta)', async () => {
      assert.equal(await createCinemeta({ config }).meta('series', 'tt0000404'), null);
    });
  });
});
