import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TtlCache } from '../src/cache.js';

const clock = (start = 1000) => {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
};

describe('TtlCache', () => {
  it('returns a stored value until it expires', () => {
    const c = clock();
    const cache = new TtlCache({ now: c.now });
    cache.set('a', 1, 100);
    assert.equal(cache.get('a'), 1);
    c.advance(99);
    assert.equal(cache.get('a'), 1);
    c.advance(1);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.size, 0, 'an expired entry is removed when it is read');
  });

  it('drops the least recently used entry when it is full', () => {
    const cache = new TtlCache({ maxEntries: 2 });
    cache.set('a', 1, 1000);
    cache.set('b', 2, 1000);
    cache.get('a'); // a is now the most recent
    cache.set('c', 3, 1000);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('c'), 3);
  });

  it('keeps total weight under its limit and refuses what can never fit', () => {
    const cache = new TtlCache({ maxWeight: 10, weigh: (v) => v.length });
    cache.set('a', 'xxxxxx', 1000);
    cache.set('b', 'yyyyyy', 1000); // 12 > 10: a goes
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), 'yyyyyy');
    cache.set('huge', 'z'.repeat(11), 1000);
    assert.equal(cache.get('huge'), undefined);
    assert.equal(cache.get('b'), 'yyyyyy', 'a value that does not fit does not push others out');
    assert.equal(cache.weight, 6);
  });

  it('replaces a value without double counting its weight', () => {
    const cache = new TtlCache({ weigh: (v) => v.length });
    cache.set('a', 'xxx', 1000);
    cache.set('a', 'yy', 1000);
    assert.equal(cache.weight, 2);
    cache.delete('a');
    assert.equal(cache.weight, 0);
    cache.set('a', 'x', 1000);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.weight, 0);
  });

  it('can hold values that are falsy but defined', () => {
    const cache = new TtlCache();
    for (const [k, v] of [['null', null], ['zero', 0], ['empty', []], ['no', false]]) {
      cache.set(k, v, 1000);
      assert.equal(cache.has(k), true, k);
      assert.deepEqual(cache.get(k), v, k);
    }
  });

  describe('wrap', () => {
    it('loads once for callers that arrive together, and again only after expiry', async () => {
      const c = clock();
      const cache = new TtlCache({ now: c.now });
      let loads = 0;
      const load = async () => {
        loads++;
        await new Promise((r) => setTimeout(r, 10));
        return { n: loads };
      };
      const results = await Promise.all([cache.wrap('k', 100, load), cache.wrap('k', 100, load), cache.wrap('k', 100, load)]);
      assert.equal(loads, 1);
      assert.equal(results[0], results[2], 'the same value is shared');
      await cache.wrap('k', 100, load);
      assert.equal(loads, 1, 'cached');
      c.advance(101);
      assert.deepEqual(await cache.wrap('k', 100, load), { n: 2 });
    });

    it('does not cache a failure and does not poison the key', async () => {
      const cache = new TtlCache();
      let calls = 0;
      const flaky = async () => {
        if (++calls === 1) throw new Error('first time fails');
        return 'ok';
      };
      await assert.rejects(Promise.all([cache.wrap('k', 1000, flaky), cache.wrap('k', 1000, flaky)]), /first time fails/);
      assert.equal(calls, 1, 'the waiting caller shared the failed attempt');
      assert.equal(await cache.wrap('k', 1000, flaky), 'ok');
    });

    it('takes a ttl that depends on the value', async () => {
      const c = clock();
      const cache = new TtlCache({ now: c.now });
      await cache.wrap('empty', (v) => (v.length ? 1000 : 10), async () => []);
      await cache.wrap('full', (v) => (v.length ? 1000 : 10), async () => [1]);
      c.advance(11);
      assert.equal(cache.get('empty'), undefined);
      assert.deepEqual(cache.get('full'), [1]);
    });

    it('caches null, so "not found" is not asked again', async () => {
      const cache = new TtlCache();
      let calls = 0;
      const load = async () => (calls++, null);
      await cache.wrap('k', 1000, load);
      await cache.wrap('k', 1000, load);
      assert.equal(calls, 1);
    });
  });
});
