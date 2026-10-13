// Cinemeta, Stremio's own metadata addon: free, no key, and it knows the TMDB id of IMDb titles.
// That replaces the OMDb key the first version asked every user to get.

import { TtlCache } from '../cache.js';
import { getJson, HttpError } from '../http.js';

export function createCinemeta({ config, fetchImpl = globalThis.fetch, now = Date.now }) {
  const cache = new TtlCache({ maxEntries: 5000, now });
  return {
    /**
     * @param {'movie' | 'series'} type
     * @param {string} imdbId
     * @returns {Promise<{ name: string, year: string | null, tmdbId: number | null, anime: boolean } | null>}
     */
    meta: (type, imdbId) =>
      cache.wrap(`${type}:${imdbId}`, (v) => (v ? 24 * 3600_000 : 3600_000), async () => {
        let data;
        try {
          data = await getJson(fetchImpl, `${config.upstream.cinemeta}/meta/${type}/${imdbId}.json`, {
            headers: { 'User-Agent': config.userAgent },
            timeoutMs: config.limits.upstreamTimeoutMs,
          });
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) return null;
          throw error;
        }
        const meta = data?.meta;
        if (!meta?.name) return null;
        const genres = (meta.genres ?? []).map((g) => String(g).toLowerCase());
        const country = String(meta.country ?? '').toLowerCase();
        const tmdbId = Number(meta.moviedb_id);
        return {
          name: meta.name,
          year: meta.year ?? meta.releaseInfo ?? null,
          tmdbId: Number.isInteger(tmdbId) && tmdbId > 0 ? tmdbId : null,
          anime: genres.includes('anime') || (genres.includes('animation') && country.includes('japan')),
        };
      }),
  };
}
