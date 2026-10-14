// A Stremio subtitles request in, a list of subtitles out.
//
//   1. Work out which Jimaku entry the video is: exact by AniList or TMDB id whenever one can be
//      found, by title only as a last resort.
//   2. Take that entry's files for the episode, keep the ones Stremio can show, order them so the
//      subtitle made for the same release as the video comes first.
//   3. When the episode has no such file, look inside the entry's ZIP archives: subtitles are often
//      uploaded as a ZIP of a whole season, and Stremio cannot open those, so this server does.
//   4. Answer in Stremio's format, with a label for the picker.

import { createHash } from 'node:crypto';
import { archiveFit, membersFor } from '../jimaku/episodes.js';
import { InvalidKeyError, RateLimitedError } from '../jimaku/client.js';
import { entriesForSeason, fileKind, filterBySeason, labelFor, rankEntries, releaseGroup, releaseSimilarity } from '../jimaku/match.js';
import { toMemberToken, toToken } from '../subs/convert.js';
import { parseVideoId } from './ids.js';

const shortHash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 10);
const empty = (cacheMaxAge) => ({ subtitles: [], cacheMaxAge });

/**
 * Turns candidate files into Stremio subtitle objects, best first.
 *
 * A candidate is `{ name, idKey, url, token, context? }`: what to call it, what its id is made from,
 * where Stremio can fetch it as it is (null for a file inside a ZIP, which only this server can
 * serve), what /convert/ needs to find it, and any more text that says what release it is from (the
 * name of the ZIP it is in).
 */
function subtitleItems(candidates, { entryId, assMode, baseUrl, videoName }) {
  const items = [];
  for (const candidate of candidates) {
    const kind = fileKind(candidate.name);
    if (!['srt', 'vtt', 'ass', 'ssa'].includes(kind)) continue; // archives and anything else
    const id = `jimaku-${entryId}-${shortHash(candidate.idKey)}`;
    const match = releaseSimilarity(videoName, candidate.context ? `${candidate.name} ${candidate.context}` : candidate.name);
    const served = (extension) => `${baseUrl}/convert/${candidate.token}.${extension}`;
    const item = (rank, suffix, url, label) => items.push({ match, rank, name: candidate.name, subtitle: { id: `${id}${suffix}`, url, lang: 'jpn', label } });

    if (kind === 'srt' || kind === 'vtt') {
      item(0, '', candidate.url ?? served(kind), labelFor(candidate.name));
      continue;
    }
    if (assMode === 'srt' || assMode === 'both') item(1, '-srt', served('srt'), labelFor(candidate.name, { converted: true }));
    if (assMode === 'ass' || assMode === 'both') item(2, '-ass', candidate.url ?? served('ass'), labelFor(candidate.name));
  }
  // Same release first; then plain SRT (no conversion), converted ASS, original ASS; then by name.
  items.sort((a, b) => b.match - a.match || a.rank - b.rank || a.name.localeCompare(b.name, 'en', { numeric: true }));

  // Two files can have the same label ("Fansub · SRT"): number the later ones so the picker can tell them apart.
  const seen = new Map();
  return items.map(({ subtitle }) => {
    const times = (seen.get(subtitle.label) ?? 0) + 1;
    seen.set(subtitle.label, times);
    return times === 1 ? subtitle : { ...subtitle, label: `${subtitle.label} (${times})` };
  });
}

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
  const candidates = files.map((file) => ({ name: file.name, idKey: file.name, url: file.url, token: toToken(file.url) }));
  return subtitleItems(candidates, { entryId: entry.id, assMode, baseUrl, videoName });
}

// Brackets in a name that say what kind of release it is, not who made it.
const NOT_A_GROUP = /^(?:ass|ssa|srt|vtt|zip|batch|complete|bd|bdrip|web|webrip|sub|subs|japanese|jp|ja|jpn|v\d|\d{3,4}p|[0-9a-f]{8})$/i;

/** Who made an archive: the leading [group], or else the first bracket that is not a format or a resolution. */
function groupOfArchive(name) {
  const leading = releaseGroup(name);
  if (leading) return leading;
  for (const [, tag] of name.matchAll(/\[([^\]]{2,30})\]/g)) if (!NOT_A_GROUP.test(tag.trim())) return tag.trim();
  return null;
}

/**
 * The same for files found inside ZIP archives: all of them are served by this server, by the
 * archive's address and their path in it, and all are ordered together, whichever archive they came from.
 *
 * @param {object} options
 * @param {{ id: number }} options.entry
 * @param {{ archive: { name: string, url: string }, members: { path: string }[] }[]} options.found   each ZIP as Jimaku lists it, and the files in it to offer
 */
export function buildArchiveSubtitles({ entry, found, assMode, baseUrl, videoName }) {
  const candidates = found.flatMap(({ archive, members }) => {
    const group = groupOfArchive(archive.name);
    return members.map((member) => {
      const base = member.path.split('/').pop();
      // The files of a batch often leave out the release group that the archive is named for.
      return {
        name: group && !releaseGroup(base) ? `[${group}] ${base}` : base,
        idKey: `${archive.name}/${member.path}`,
        url: null,
        token: toMemberToken(archive.url, member.path),
        context: archive.name.replace(/\.zip$/i, ''),
      };
    });
  });
  return subtitleItems(candidates, { entryId: entry.id, assMode, baseUrl, videoName });
}

export function createSubtitleService({ config, jimaku, kitsu, anilist, cinemeta, archives = null, logger }) {
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
   * Subtitles for an episode that Jimaku has only inside ZIP files. Jimaku's episode filter may leave
   * archives out of `files` (a batch is not "episode 5"), so when none came with them the entry's whole
   * list is asked for. Archives whose names rule the episode out are not opened, and no more than a
   * few are: each one costs a request or two to the file host.
   */
  async function fromArchives({ entry, via, files, episode, movie, season, key, assMode, baseUrl, videoName }) {
    if (!archives || (!movie && episode === null)) return [];
    const isZip = (file) => /\.zip$/i.test(file.name);
    let zips = files.filter(isZip);
    if (!zips.length && !movie) {
      const everything = await jimaku.files(entry.id, null, key);
      zips = (via === 'anilist' ? everything : filterBySeason(everything, season)).filter(isZip);
    }

    // An AniList entry is one season already, so its files' seasons are not held against it.
    const wanted = { episode, season: via === 'anilist' ? null : season, movie };
    const chosen = zips
      .map((file) => ({ file, fit: archiveFit(file.name, wanted), match: releaseSimilarity(videoName, file.name) }))
      .filter(({ fit }) => fit > 0)
      .sort((a, b) => b.fit - a.fit || b.match - a.match || a.file.name.localeCompare(b.file.name, 'en', { numeric: true }))
      .slice(0, config.limits.maxArchives);

    const found = await Promise.all(
      chosen.map(async ({ file }) => {
        try {
          const archive = await archives.open(file.url);
          return { archive: file, members: membersFor(archive.entries, { ...wanted, archiveName: file.name }) };
        } catch (error) {
          logger?.info('could not use an archive', { entry: entry.id, error: error.message });
          return null;
        }
      }),
    );
    return buildArchiveSubtitles({ entry, found: found.filter(Boolean), assMode, baseUrl, videoName });
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
        const movie = Boolean(entry.movie || parsed.movie);
        const episode = movie ? null : parsed.episode;
        let files = await jimaku.files(entry.id, episode, key);
        // A TMDB or title match covers a whole show; an AniList entry is already one season.
        if (via !== 'anilist') files = filterBySeason(files, parsed.season);
        const options = { entry, assMode, baseUrl, videoName: extra.filename };
        let found = buildSubtitles({ ...options, files });
        // Nothing Stremio can open for this episode: it may be in a ZIP.
        if (!found.length) found = await fromArchives({ ...options, via, files, episode, movie, season: parsed.season, key });
        subtitles.push(...found);
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
