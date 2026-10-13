// The ids Stremio sends for the video being played.
//
//   tt0111161                  an IMDb movie
//   tt22248376:1:5             an IMDb series: season 1, episode 5
//   kitsu:46474:5              the Kitsu addon: anime 46474, episode 5 (of that Kitsu entry)
//   mal:52991:5, anilist:154587:5, anidb:17617:5   the same idea with other databases

export const ID_PREFIXES = ['tt', 'kitsu', 'mal', 'anilist', 'anidb'];
export const TYPES = ['movie', 'series', 'anime'];

const toInt = (value) => {
  if (!/^\d{1,9}$/.test(value ?? '')) return null;
  return Number.parseInt(value, 10);
};

/**
 * @param {string} type  movie, series or anime
 * @param {string} rawId
 * @returns {{ kind: 'imdb' | 'kitsu' | 'mal' | 'anilist' | 'anidb', id: string | number,
 *             season: number | null, episode: number | null, movie: boolean } | null}
 */
export function parseVideoId(type, rawId) {
  const parts = String(rawId ?? '').split(':');
  const movie = type === 'movie';

  if (/^tt\d{1,10}$/.test(parts[0])) {
    return { kind: 'imdb', id: parts[0], season: movie ? null : toInt(parts[1]), episode: movie ? null : toInt(parts[2]), movie };
  }
  const kind = parts[0];
  if (['kitsu', 'mal', 'anilist', 'anidb'].includes(kind)) {
    const id = toInt(parts[1]);
    if (id === null || id === 0) return null;
    return { kind, id, season: null, episode: movie ? null : toInt(parts[2]), movie };
  }
  return null;
}
