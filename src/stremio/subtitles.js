// A Stremio subtitles request in, a list of subtitles out.
//
//   1. Work out which Jimaku entry the video is: exact by AniList or TMDB id whenever one can be
//      found, by title only as a last resort.
//   2. Take that entry's files for the episode, keep the ones Stremio can show, order them so the
//      subtitle made for the same release as the video comes first.
//   3. Answer in Stremio's format, with a label for the picker.

import { createHash } from 'node:crypto';
import { InvalidKeyError, RateLimitedError } from '../jimaku/client.js';
import { entriesForSeason, fileKind, filterBySeason, labelFor, rankEntries, releaseSimilarity } from '../jimaku/match.js';
import { toToken } from '../subs/convert.js';
import { parseVideoId } from './ids.js';

const shortHash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 10);
const empty = (cacheMaxAge) => ({ subtitles: [], cacheMaxAge });

/**
 * Turns an entry's files into Stremio subtitle objects, best first.
 *
 * @param {object} options
 * @param {{ id: number }} options.entry
 * @param {{ name: string, url: string }[]} options.files
 * @param {'srt' | 'ass' | 'both'} options.assMode   what to do with ASS files
 * @param {string} options.baseUrl                    this server, for converted files
 * @param {string} [options.videoName]                the file being played, to match its release
 */
export function buildSubtitles({ entry, files, assMode, baseUrl, videoName }) {
  const items = [];
  for (const file of files) {
    const kind = fileKind(file.name);
    if (!['srt', 'vtt', 'ass', 'ssa'].includes(kind)) continue; // archives and anything else
    const id = `jimaku-${entry.id}-${shortHash(file.name)}`;
    const match = releaseSimilarity(videoName, file.name);

    if (kind === 'srt' || kind === 'vtt') {
      items.push({ match, rank: 0, name: file.name, subtitle: { id, url: file.url, lang: 'jpn', label: labelFor(file.name) } });
      continue;
    }
    if (assMode === 'srt' || assMode === 'both') {
      const url = `${baseUrl}/convert/${toToken(file.url)}.srt`;
      items.push({ match, rank: 1, name: file.name, subtitle: { id: `${id}-srt`, url, lang: 'jpn', label: labelFor(file.name, { converted: true }) } });
    }
    if (assMode === 'ass' || assMode === 'both') {
      items.push({ match, rank: 2, name: file.name, subtitle: { id: `${id}-ass`, url: file.url, lang: 'jpn', label: labelFor(file.name) } });
    }
  }
  // Same release first; then plain SRT (no conversion), converted ASS, original ASS; then by name.
  items.sort((a, b) => b.match - a.match || a.rank - b.rank || a.name.localeCompare(b.name, 'en', { numeric: true }));
  return items.map((item) => item.subtitle);
}

export function createSubtitleService({ config, jimaku, kitsu, anilist, cinemeta, logger }) {
  const byAnilistId = async (anilistId, key) =>
    (await jimaku.searchByAnilist(anilistId, key)).map((entry) => ({ entry, via: 'anilist' }));

  /** Last resort: search by title (two searches at most, because they are rate limited). */
  async function byTitles(titles, { season, anime }, key) {
    const unique = [...new Set(titles.filter(Boolean))];
    for (const title of unique.slice(0, 2)) {
      const found = await jimaku.searchByQuery(title, { anime }, key);
      const ranked = rankEntries(found, unique, { season });
      // Close runners-up only: "Show" must not drag in "Show 2nd Season" when it was not asked for.
      const close = ranked.filter(({ score }) => score >= ranked[0].score - 0.2);
      if (close.length) return close.slice(0, 2).map(({ entry }) => ({ entry, via: 'title' }));
    }
    return [];
  }

  async function fromKitsu(kitsuId, key) {
    const anilistId = await kitsu.anilistId(kitsuId);
    // With a mapping the answer is exact, even when it is "no entry yet": a title search could
    // only find some other season.
    if (anilistId) return byAnilistId(anilistId, key);
    return byTitles(await kitsu.titles(kitsuId), { season: null, anime: true }, key);
  }

  async function fromImdb(parsed, key) {
    const meta = await cinemeta.meta(parsed.movie ? 'movie' : 'series', parsed.id);
    if (!meta) return [];
    if (meta.tmdbId) {
      const found = await jimaku.searchByTmdb(`${parsed.movie ? 'movie' : 'tv'}:${meta.tmdbId}`, key);
      const chosen = entriesForSeason(found, parsed.season);
      if (chosen.length) return chosen.map((entry) => ({ entry, via: 'tmdb' }));
      // TMDB knows the show but Jimaku has no entry for this season: a title search would only
      // turn up the same entries, and a subtitle from another season is worse than none.
      if (found.length) return [];
    }
    return byTitles([meta.name], { season: parsed.season, anime: meta.anime ? true : undefined }, key);
  }

  async function findEntries(parsed, key) {
    switch (parsed.kind) {
      case 'anilist':
        return byAnilistId(parsed.id, key);
      case 'mal': {
        const anilistId = await anilist.idFromMal(parsed.id);
        return anilistId ? byAnilistId(anilistId, key) : [];
      }
      case 'kitsu':
        return fromKitsu(parsed.id, key);
      case 'anidb': {
        const kitsuId = await kitsu.kitsuIdFromAnidb(parsed.id);
        return kitsuId ? fromKitsu(kitsuId, key) : [];
      }
      case 'imdb':
        return fromImdb(parsed, key);
      default:
        return [];
    }
  }

  /**
   * @param {object} request
   * @param {string} request.type
   * @param {string} request.id
   * @param {Record<string, string>} [request.extra]   videoHash, videoSize, filename
   * @param {{ jimakuApiKey: string, assMode: string, maxSubtitles: number } | null} [request.user]
   * @param {string} request.baseUrl
   * @returns {Promise<{ subtitles: object[], cacheMaxAge: number }>}
   */
  async function getSubtitles({ type, id, extra = {}, user = null, baseUrl }) {
    const parsed = parseVideoId(type, id);
    if (!parsed) return empty(3600);
    const key = user?.jimakuApiKey ?? config.serverKey;
    if (!key) return empty(60);
    const assMode = user?.assMode ?? 'srt';
    const limit = user?.maxSubtitles ?? 10;

    try {
      const candidates = (await findEntries(parsed, key)).slice(0, 2);
      if (!candidates.length) {
        logger?.info('no Jimaku entry', { kind: parsed.kind, id: String(parsed.id) });
        return empty(600);
      }

      const subtitles = [];
      for (const { entry, via } of candidates) {
        const episode = entry.movie || parsed.movie ? null : parsed.episode;
        let files = await jimaku.files(entry.id, episode, key);
        // A TMDB or title match covers a whole show; an AniList entry is already one season.
        if (via !== 'anilist') files = filterBySeason(files, parsed.season);
        subtitles.push(...buildSubtitles({ entry, files, assMode, baseUrl, videoName: extra.filename }));
      }
      const unique = [...new Map(subtitles.map((s) => [s.id, s])).values()].slice(0, limit);
      logger?.info('subtitles found', { kind: parsed.kind, id: String(parsed.id), episode: parsed.episode, count: unique.length });
      return { subtitles: unique, cacheMaxAge: unique.length ? 900 : 120 };
    } catch (error) {
      if (error instanceof InvalidKeyError) {
        logger?.warn('Jimaku rejected a key');
        return empty(120);
      }
      if (error instanceof RateLimitedError) return empty(Math.min(60, Math.max(5, Math.ceil(error.retryAfterMs / 1000))));
      logger?.error('subtitle lookup failed', { error: error.message });
      return empty(30);
    }
  }

  return { getSubtitles };
}
