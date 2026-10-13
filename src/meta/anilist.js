// AniList's public GraphQL API, used for one thing: turning a MyAnimeList id into an AniList id.

import { TtlCache } from '../cache.js';
import { HttpError, requestJson } from '../http.js';

const QUERY = 'query ($mal: Int) { Media(idMal: $mal, type: ANIME) { id } }';

export function createAniList({ config, fetchImpl = globalThis.fetch, now = Date.now }) {
  const cache = new TtlCache({ maxEntries: 5000, now });
  return {
    idFromMal: (malId) =>
      cache.wrap(`mal:${malId}`, (v) => (v ? 30 * 24 * 3600_000 : 24 * 3600_000), async () => {
        try {
          const { data } = await requestJson(fetchImpl, config.upstream.anilist, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': config.userAgent },
            body: JSON.stringify({ query: QUERY, variables: { mal: Number(malId) } }),
            timeoutMs: config.limits.upstreamTimeoutMs,
          });
          const id = Number(data?.data?.Media?.id);
          return Number.isInteger(id) && id > 0 ? id : null;
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) return null; // AniList answers "not found" as 404
          throw error;
        }
      }),
  };
}
