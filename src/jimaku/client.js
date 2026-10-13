// The Jimaku API (https://jimaku.cc/api/docs), used politely.
//
// Jimaku allows few requests per window, counted per IP, and every user of this server shares that
// budget. So: calls go through one queue with a minimum gap, answers are cached for everyone (they
// do not depend on who asks), identical lookups in flight share one request, and a 429 is obeyed
// by waiting when the wait is short and giving up cleanly when it is not.

import { TtlCache } from '../cache.js';
import { HttpError, requestJson } from '../http.js';

export class InvalidKeyError extends Error {
  constructor() {
    super('Jimaku rejected the API key');
    this.name = 'InvalidKeyError';
  }
}

export class RateLimitedError extends Error {
  constructor(retryAfterMs) {
    super(`Jimaku rate limit reached; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamError';
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const entryOf = (raw) => ({
  id: raw.id,
  name: raw.name ?? '',
  englishName: raw.english_name ?? null,
  japaneseName: raw.japanese_name ?? null,
  anilistId: raw.anilist_id ?? null,
  tmdbId: raw.tmdb_id ?? null,
  movie: Boolean(raw.flags?.movie),
  anime: Boolean(raw.flags?.anime),
});

const fileOf = (raw) => ({ name: raw.name, url: raw.url, size: raw.size ?? 0, lastModified: raw.last_modified ?? null });

/** How long a 429 says to wait, in ms. */
function retryAfterMs(headers) {
  const after = Number(headers.get('x-ratelimit-reset-after') ?? headers.get('retry-after'));
  return Number.isFinite(after) && after >= 0 ? Math.ceil(after * 1000) : 1000;
}

export function createJimakuClient({
  config,
  fetchImpl = globalThis.fetch,
  logger,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const base = config.upstream.jimaku;
  const { jimakuMinIntervalMs: gap, jimakuMaxWaitMs: maxWait, upstreamTimeoutMs: timeoutMs } = config.limits;
  const cache = new TtlCache({ maxEntries: 3000, now });
  let tail = Promise.resolve();
  let nextAt = 0;
  let blockedUntil = 0;

  /** Runs `task` after every earlier one, at least `gap` ms after the previous request started. */
  function schedule(task) {
    const run = async () => {
      const wait = nextAt - now();
      if (wait > 0) await sleep(wait);
      nextAt = now() + gap;
      return task();
    };
    const result = tail.then(run, run);
    tail = result.catch(() => {});
    return result;
  }

  async function waitForRateLimit() {
    const wait = blockedUntil - now();
    if (wait <= 0) return;
    if (wait > maxWait) throw new RateLimitedError(wait);
    await sleep(wait);
  }

  /** One GET with the key, retried once on a short rate limit or a server hiccup. */
  function call(path, params, apiKey) {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
    const url = `${base}${path}${query.size ? `?${query}` : ''}`;
    return schedule(async () => {
      for (let attempt = 0; ; attempt++) {
        await waitForRateLimit();
        try {
          const { data, headers } = await requestJson(fetchImpl, url, {
            headers: { Authorization: apiKey, 'User-Agent': config.userAgent },
            timeoutMs,
          });
          if (Number(headers.get('x-ratelimit-remaining')) === 0) blockedUntil = now() + retryAfterMs(headers);
          return data;
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          if (error.status === 401 || error.status === 403) throw new InvalidKeyError();
          if (error.status === 404) return null;
          if (error.status === 429) {
            const wait = retryAfterMs(error.headers);
            blockedUntil = now() + wait;
            logger?.warn('jimaku rate limit', { retryAfterMs: wait });
            if (wait > maxWait || attempt > 0) throw new RateLimitedError(wait);
            continue;
          }
          if ((error.status === 0 || error.status >= 500) && attempt === 0) {
            await sleep(300);
            continue;
          }
          throw new UpstreamError(`Jimaku: ${error.message}`);
        }
      }
    });
  }

  // Answers are the same whoever asks, so the cache key leaves the API key out.
  const search = (params, apiKey) =>
    cache.wrap(`search:${JSON.stringify(params)}`, (entries) => (entries.length ? 6 * HOUR : 10 * MINUTE), async () => {
      const data = await call('/entries/search', params, apiKey);
      return Array.isArray(data) ? data.map(entryOf) : [];
    });

  return {
    /** Entries for an AniList id: exact, so at most one. */
    searchByAnilist: (anilistId, apiKey) => search({ anilist_id: anilistId }, apiKey),
    /** Entries for "tv:123" or "movie:456". */
    searchByTmdb: (tmdbId, apiKey) => search({ tmdb_id: tmdbId }, apiKey),
    /** Fuzzy title search; `anime` narrows to anime or to everything else. */
    searchByQuery: (query, { anime } = {}, apiKey) => search({ query, anime }, apiKey),

    /** The files of an entry; `episode` filters (best effort, and ignored for movies). */
    files: (entryId, episode, apiKey) =>
      cache.wrap(`files:${entryId}:${episode ?? ''}`, (files) => (files.length ? 10 * MINUTE : 2 * MINUTE), async () => {
        const data = await call(`/entries/${entryId}/files`, { episode }, apiKey);
        return Array.isArray(data) ? data.map(fileOf) : [];
      }),

    /** Does this key work? Never cached. Resolves to 'valid', 'invalid', 'rate_limited' or 'unreachable'. */
    async checkKey(apiKey) {
      try {
        await call('/entries/search', { anilist_id: 154587 }, apiKey);
        return 'valid';
      } catch (error) {
        if (error instanceof InvalidKeyError) return 'invalid';
        if (error instanceof RateLimitedError) return 'rate_limited';
        return 'unreachable';
      }
    },
  };
}
