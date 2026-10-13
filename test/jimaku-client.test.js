import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startMockUpstream, VALID_KEY } from '../scripts/mock-upstream.js';
import { createJimakuClient, InvalidKeyError, RateLimitedError, UpstreamError } from '../src/jimaku/client.js';

describe('Jimaku client', () => {
  let mock;
  let sleeps;
  const make = (options = {}) =>
    createJimakuClient({
      config: mock.config({ JIMAKU_MAX_WAIT_MS: '4000' }),
      sleep: async (ms) => void sleeps.push(ms),
      ...options,
    });

  before(async () => {
    mock = await startMockUpstream();
  });
  after(() => mock.close());
  beforeEach(() => {
    mock.requests.length = 0;
    mock.limitNext(0, 0);
    mock.failNext(500, 0);
    sleeps = [];
  });

  it('asks the way the API documents: key in Authorization, a descriptive User-Agent', async () => {
    const client = make();
    await client.searchByAnilist(154587, VALID_KEY);
    const [request] = mock.requests;
    assert.equal(request.headers.authorization, VALID_KEY);
    assert.match(request.headers['user-agent'], /^jimaku-subs-stremio\/\d+\.\d+\.\d+ \(Stremio addon\)$/);
    assert.equal(request.path, '/jimaku/entries/search');
    assert.deepEqual(request.query, { anilist_id: '154587' });
  });

  it('returns entries in a tidy shape', async () => {
    const [entry] = await make().searchByAnilist(154587, VALID_KEY);
    assert.deepEqual(entry, {
      id: 101,
      name: 'Sousou no Frieren',
      englishName: "Frieren: Beyond Journey's End",
      japaneseName: '葬送のフリーレン',
      anilistId: 154587,
      tmdbId: 'tv:209867',
      movie: false,
      anime: true,
    });
  });

  it('searches by TMDB id and by title, sending only the parameters it has', async () => {
    const client = make();
    assert.equal((await client.searchByTmdb('tv:1429', VALID_KEY)).length, 2);
    assert.deepEqual(mock.requests.at(-1).query, { tmdb_id: 'tv:1429' });

    const found = await client.searchByQuery('frieren', { anime: true }, VALID_KEY);
    assert.deepEqual(found.map((e) => e.id), [101]);
    assert.deepEqual(mock.requests.at(-1).query, { query: 'frieren', anime: 'true' });

    await client.searchByQuery('hanzawa', {}, VALID_KEY);
    assert.deepEqual(mock.requests.at(-1).query, { query: 'hanzawa' });
  });

  it('lists the files of an entry for one episode, and for none', async () => {
    const client = make();
    const two = await client.files(101, 2, VALID_KEY);
    assert.equal(mock.requests.at(-1).query.episode, '2');
    assert.ok(two.every((f) => f.url.includes('/entry/101/download/')));
    assert.deepEqual(Object.keys(two[0]), ['name', 'url', 'size', 'lastModified']);

    const all = await client.files(101, null, VALID_KEY);
    assert.equal('episode' in mock.requests.at(-1).query, false);
    assert.ok(all.length > two.length);
  });

  it('treats an unknown entry as having no files', async () => {
    assert.deepEqual(await make().files(999, 1, VALID_KEY), []);
  });

  it('answers a repeated lookup from memory, whoever asks', async () => {
    const client = make();
    await client.searchByAnilist(154587, VALID_KEY);
    await client.searchByAnilist(154587, VALID_KEY);
    await client.searchByAnilist(154587, 'a-different-key');
    assert.equal(mock.count('jimaku'), 1);
  });

  it('shares one request between lookups made at the same time', async () => {
    const client = make();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => client.searchByAnilist(16498, VALID_KEY)));
    assert.equal(mock.count('jimaku'), 1);
    assert.ok(results.every((r) => r.length === 1));
  });

  it('keeps an answer for hours when it found something, minutes when it found nothing', async () => {
    let t = 1_000_000;
    const client = make({ now: () => t });
    await client.searchByAnilist(154587, VALID_KEY); // found
    await client.searchByAnilist(1, VALID_KEY); // nothing
    mock.requests.length = 0;

    t += 5 * 60_000;
    await client.searchByAnilist(154587, VALID_KEY);
    await client.searchByAnilist(1, VALID_KEY);
    assert.equal(mock.count('jimaku'), 0, 'both still cached after 5 minutes');

    t += 6 * 60_000; // 11 minutes in
    await client.searchByAnilist(154587, VALID_KEY);
    await client.searchByAnilist(1, VALID_KEY);
    assert.deepEqual(mock.requests.map((r) => r.query.anilist_id), ['1'], 'only the empty answer was asked again');

    t += 6 * 3600_000;
    mock.requests.length = 0;
    await client.searchByAnilist(154587, VALID_KEY);
    assert.equal(mock.count('jimaku'), 1);
  });

  it('turns a rejected key into InvalidKeyError and caches nothing for it', async () => {
    const client = make();
    await assert.rejects(client.searchByAnilist(154587, 'wrong-key-000'), InvalidKeyError);
    assert.equal((await client.searchByAnilist(154587, VALID_KEY)).length, 1);
  });

  describe('rate limits', () => {
    it('waits out a short 429 and tries again', async () => {
      mock.limitNext(1, 0.05);
      const entries = await make().searchByAnilist(154587, VALID_KEY);
      assert.equal(entries.length, 1);
      assert.equal(mock.count('jimaku'), 2);
      assert.ok(sleeps.length >= 1 && sleeps[0] <= 60, `slept ${sleeps}`);
    });

    it('gives up on a long 429 instead of making anyone wait', async () => {
      mock.limitNext(1, 30);
      await assert.rejects(make().searchByAnilist(154587, VALID_KEY), (e) => e instanceof RateLimitedError && e.retryAfterMs === 30_000);
      assert.equal(mock.count('jimaku'), 1);
    });

    it('does not ask again while it knows it is blocked', async () => {
      const client = make();
      mock.limitNext(1, 30);
      await assert.rejects(client.searchByAnilist(154587, VALID_KEY), RateLimitedError);
      await assert.rejects(client.searchByAnilist(16498, VALID_KEY), RateLimitedError);
      await assert.rejects(client.files(101, 1, VALID_KEY), RateLimitedError);
      assert.equal(mock.count('jimaku'), 1, 'later calls failed without touching Jimaku');
    });

    it('stops after one retry if the limit is still on', async () => {
      mock.limitNext(2, 0.01);
      await assert.rejects(make().searchByAnilist(154587, VALID_KEY), RateLimitedError);
      assert.equal(mock.count('jimaku'), 2);
    });
  });

  describe('server trouble', () => {
    it('retries once after a 5xx', async () => {
      mock.failNext(503, 1);
      assert.equal((await make().searchByAnilist(154587, VALID_KEY)).length, 1);
      assert.equal(mock.count('jimaku'), 2);
      assert.deepEqual(sleeps, [300]);
    });

    it('reports an UpstreamError when it keeps failing', async () => {
      mock.failNext(500, 2);
      await assert.rejects(make().searchByAnilist(154587, VALID_KEY), (e) => e instanceof UpstreamError && /HTTP 500/.test(e.message));
      assert.equal(mock.count('jimaku'), 2);
    });

    it('does not cache a failure', async () => {
      const client = make();
      mock.failNext(500, 2);
      await assert.rejects(client.searchByAnilist(154587, VALID_KEY));
      assert.equal((await client.searchByAnilist(154587, VALID_KEY)).length, 1);
    });
  });

  describe('checkKey', () => {
    it('says valid, invalid, rate_limited or unreachable', async () => {
      const client = make();
      assert.equal(await client.checkKey(VALID_KEY), 'valid');
      assert.equal(await client.checkKey('wrong-key-000'), 'invalid');
      mock.limitNext(1, 30);
      assert.equal(await client.checkKey(VALID_KEY), 'rate_limited');
      const fresh = make();
      mock.failNext(500, 2);
      assert.equal(await fresh.checkKey(VALID_KEY), 'unreachable');
    });

    it('is not answered from the cache', async () => {
      const client = make();
      await client.checkKey(VALID_KEY);
      await client.checkKey(VALID_KEY);
      assert.equal(mock.count('jimaku'), 2);
    });
  });

  describe('politeness', () => {
    it('spaces its requests by the minimum gap', async () => {
      let t = 0;
      const starts = [];
      const fetchImpl = async () => {
        starts.push(t);
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const config = mock.config({ JIMAKU_MIN_INTERVAL_MS: '250' });
      const client = createJimakuClient({ config, fetchImpl, now: () => t, sleep: async (ms) => void (t += ms) });
      await Promise.all([1, 2, 3, 4].map((id) => client.searchByAnilist(id, VALID_KEY)));
      assert.equal(starts.length, 4);
      for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 250, `gap ${starts[i] - starts[i - 1]}`);
    });
  });
});
