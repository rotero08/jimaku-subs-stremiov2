// Kitsu: the id scheme of the popular anime addon, and the bridge from it to AniList.

import { TtlCache } from '../cache.js';
import { getJson, HttpError } from '../http.js';

const DAY = 24 * 3600_000;
const SUBTYPES = ['tv', 'movie', 'ona', 'ova', 'special', 'music'];

export function createKitsu({ config, fetchImpl = globalThis.fetch, now = Date.now }) {
  const base = config.upstream.kitsu;
  const cache = new TtlCache({ maxEntries: 5000, now });

  const get = (path, params = {}) => {
    const query = new URLSearchParams(params);
    return getJson(fetchImpl, `${base}${path}${query.size ? `?${query}` : ''}`, {
      headers: { Accept: 'application/vnd.api+json', 'User-Agent': config.userAgent },
      timeoutMs: config.limits.upstreamTimeoutMs,
    }).catch((error) => {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    });
  };

  return {
    /** The AniList id Kitsu has recorded for a Kitsu anime, or null. */
    anilistId: (kitsuId) =>
      cache.wrap(`anilist:${kitsuId}`, (v) => (v ? 30 * DAY : DAY), async () => {
        const data = await get(`/anime/${kitsuId}/mappings`, { 'filter[externalSite]': 'anilist/anime' });
        const id = Number(data?.data?.[0]?.attributes?.externalId);
        return Number.isInteger(id) && id > 0 ? id : null;
      }),

    /** Every title Kitsu knows for the anime, for matching when there is no AniList id. */
    titles: (kitsuId) =>
      cache.wrap(`titles:${kitsuId}`, 7 * DAY, async () => {
        const data = await get(`/anime/${kitsuId}`, { 'fields[anime]': 'canonicalTitle,titles' });
        const attributes = data?.data?.attributes;
        if (!attributes) return [];
        const all = [attributes.canonicalTitle, ...Object.values(attributes.titles ?? {})].filter((t) => typeof t === 'string' && t);
        return [...new Set(all)];
      }),

    /** The Kitsu id of an AniDB anime, or null. */
    kitsuIdFromAnidb: (anidbId) =>
      cache.wrap(`anidb:${anidbId}`, (v) => (v ? 30 * DAY : DAY), async () => {
        const data = await get('/mappings', {
          'filter[externalSite]': 'anidb',
          'filter[externalId]': String(anidbId),
          include: 'item',
          'fields[anime]': 'canonicalTitle,subtype',
        });
        // Kitsu sometimes ties one AniDB id to a TV series and to a recap special; the series is meant.
        const rank = (item) => {
          const at = SUBTYPES.indexOf(String(item.attributes?.subtype ?? '').toLowerCase());
          return at === -1 ? SUBTYPES.length : at;
        };
        const items = (data?.included ?? []).filter((item) => item.type === 'anime').sort((a, b) => rank(a) - rank(b));
        const id = Number(items[0]?.id);
        return Number.isInteger(id) && id > 0 ? id : null;
      }),
  };
}
