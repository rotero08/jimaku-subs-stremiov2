// Working out which episode a subtitle file is for, from its name.
//
// For the files Jimaku lists, its own episode filter does this. The files inside a ZIP have no such
// help: only their names, and the name of the archive, say what they are. Names are free text, so
// this reads them from the most explicit form ("S02E05", "第5話") to the most conventional
// ("Show - 05"), and it would rather say nothing than guess: a subtitle for the wrong episode is
// worse than none.

import { fileSeason, seasonHint } from './match.js';

const RESOLUTIONS = new Set([360, 480, 540, 576, 720, 1080, 1440, 2160, 4320]);

// A number is not an episode when it is a resolution or a year (nobody's series has an episode 2024).
const plausible = (n) => Number.isInteger(n) && n >= 0 && n < 5000 && !RESOLUTIONS.has(n) && !(n >= 1950 && n <= 2099);

const START = '(?<![A-Za-z0-9])';
const END = '(?![A-Za-z0-9])';
const pattern = (source, flags = 'i') => new RegExp(source, flags);

const SEASON_EPISODE = pattern(`${START}S(\\d{1,2})[ ._-]?E(?:P)?(\\d{1,4})(?:v\\d+)?(?:(?:[ ._]?-[ ._]?E?|E)(\\d{1,4}))?${END}`);
const CROSS = pattern(`${START}(\\d{1,2})x(\\d{2,3})${END}`);
const EPISODE_WORD = pattern(`${START}(?:episodes?|eps?|e)[ .]?(\\d{1,4})(?:v\\d+)?(?:[ ]?-[ ]?(?:episodes?|eps?|e)?[ .]?(\\d{1,4}))?${END}`);
const KANJI = pattern('第\\s?(\\d{1,4})\\s?[話话回集]', 'u');
const KANJI_SHORT = pattern(`${START}(\\d{1,4})\\s?話`, 'u');
const HASH = pattern(`#\\s?(\\d{1,4})${END}`);
const RANGE = pattern(`${START}(\\d{1,4})\\s?[-~〜–]\\s?(\\d{1,4})${END}`, 'iu');
const DASHED = pattern(`(?<=\\s)-\\s(\\d{1,4})(?:v\\d+)?(?![A-Za-z0-9.])`);
const DASHED_TWO = pattern(`(?<=\\s)-\\s(\\d{2,4})(?:v\\d+)?(?![A-Za-z0-9.])`);
const BRACKETED = pattern('\\[(\\d{1,4})(?:v\\d+)?\\]');
const TRAILING = pattern('(?<!\\b(?:part|season|vol|volume|disc|cour|no)\\.?\\s?)(?:^|(?<!\\d)\\.|\\s|-)(\\d{1,4})(?:v\\d+)?$');
const LEADING = pattern('^(\\d{1,3})(?:v\\d+)?(?:\\s-\\s|\\.(?=[^\\d\\s]))');

/** The name without its extension, language tag and CRC, with full-width characters made ordinary. */
function tidy(name) {
  return String(name ?? '')
    .normalize('NFKC')
    .replace(/\.(?:zip|rar|7z|srt|ass|ssa|vtt|txt)$/i, '') // only known extensions: "Show 05.5" keeps its ".5"
    .replace(/\.(?:ja|jp|jpn|jap|en|eng)$/i, '')
    .replace(/_+/g, ' ')
    .replace(/[[(]\s*[0-9a-f]{8}\s*[\])]/gi, ' ') // a CRC in brackets: [A1B2C3D4]
    .replace(/\s+/g, ' ')
    .trim();
}

const numbers = (...values) => values.map((v) => (v === undefined ? null : Number(v)));

/** A single episode, or a range when the second number follows the first (E05-E06, 01-12). */
function episodeOrRange(season, first, second) {
  const [a, b] = numbers(first, second);
  if (!plausible(a)) return null;
  if (b !== null && plausible(b) && b > a && b - a <= 600) return { season, episode: null, range: [a, b] };
  return { season, episode: a, range: null };
}

const NONE = Object.freeze({ season: null, episode: null, range: null });

/** The unmistakable forms: S02E05, 2x05, E05, Episode 5, 第5話, #05, and ranges such as 01-12. */
function explicit(text) {
  let m;
  if ((m = SEASON_EPISODE.exec(text))) {
    const found = episodeOrRange(Number(m[1]), m[2], m[3]);
    if (found) return found;
  }
  if ((m = CROSS.exec(text)) && Number(m[1]) <= 30) {
    const found = episodeOrRange(Number(m[1]), m[2]);
    if (found) return found;
  }
  if ((m = EPISODE_WORD.exec(text))) {
    const found = episodeOrRange(null, m[1], m[2]);
    if (found) return found;
  }
  for (const form of [KANJI, KANJI_SHORT, HASH]) {
    if ((m = form.exec(text))) {
      const found = episodeOrRange(null, m[1]);
      if (found) return found;
    }
  }
  if ((m = RANGE.exec(text))) {
    const found = episodeOrRange(null, m[1], m[2]);
    if (found?.range) return found;
  }
  return null;
}

/**
 * What a file name says about its place in a series.
 * @param {string} name
 * @param {{ strict?: boolean }} [options]   strict keeps to the unmistakable forms (for the names of folders)
 * @returns {{ season: number | null, episode: number | null, range: [number, number] | null }}
 */
export function readEpisode(name, { strict = false } = {}) {
  const text = tidy(name);
  const found = explicit(text);
  if (found) return found;
  if (strict) return NONE;

  // The conventional forms: "Show - 05", "Show [05]", "Show 05", "05 - Title".
  let m;
  for (const form of [DASHED, BRACKETED]) {
    if ((m = form.exec(text))) {
      const found = episodeOrRange(null, m[1]);
      if (found) return found;
    }
  }
  const bare = text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  for (const form of [TRAILING, LEADING]) {
    if ((m = form.exec(bare))) {
      const found = episodeOrRange(null, m[1]);
      if (found) return found;
    }
  }
  return NONE;
}

/**
 * What the name of an archive says: the unmistakable forms, and "Show - 05" with at least two
 * digits ("Show - 2" may be a season, and an archive is only opened when its name allows it).
 */
export function readArchiveName(name) {
  const text = tidy(name);
  const found = explicit(text);
  if (found) return found;
  const m = DASHED_TWO.exec(text);
  return (m && episodeOrRange(null, m[1])) || NONE;
}

// ---------------------------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------------------------

/**
 * Could an archive with this name hold the wanted episode? 0 no, 1 perhaps, 2 its range covers it,
 * 3 it is named for that very episode. Only what the name states is used to say no.
 * @param {string} name
 * @param {{ episode?: number | null, season?: number | null, movie?: boolean }} wanted
 */
export function archiveFit(name, { episode = null, season = null, movie = false } = {}) {
  const stripped = String(name).replace(/\.[a-z0-9]{2,4}$/i, '');
  const info = readArchiveName(stripped);
  const stated = info.season ?? fileSeason(stripped) ?? seasonHint(stripped);
  if (season && stated !== null && stated !== season) return 0;
  if (movie || episode === null) return 1;
  if (info.range) return episode >= info.range[0] && episode <= info.range[1] ? 2 : 0;
  if (info.episode !== null) return info.episode === episode ? 3 : 0;
  return 1;
}

const SUBTITLE = /\.(?:srt|vtt|ass|ssa)$/i;
const JUNK = /(?:^|\/)(?:__MACOSX\/|\._|\.DS_Store$)/;

/** A subtitle file Stremio can be given, as opposed to a folder, a font, a note or something packed in a way we cannot read. */
export const isSubtitleMember = (entry) =>
  !entry.directory && !entry.encrypted && !entry.zip64 && (entry.method === 0 || entry.method === 8) && SUBTITLE.test(entry.path) && !JUNK.test(entry.path);

/**
 * The subtitle files in an archive that are for the wanted episode; for a movie, all of them.
 * An episode comes from the file's name, else the folder it is in, else (for a lone file) the
 * archive's name. A file that names another season is left out; one that names none is kept.
 * @param {{ path: string }[]} entries
 * @param {{ episode?: number | null, season?: number | null, movie?: boolean, archiveName?: string }} wanted
 */
export function membersFor(entries, { episode = null, season = null, movie = false, archiveName = '' } = {}) {
  const subtitles = entries.filter(isSubtitleMember);
  if (movie) return subtitles;
  if (episode === null) return [];

  const archive = readArchiveName(archiveName);
  return subtitles.filter((entry) => {
    const parts = entry.path.split('/');
    let info = readEpisode(parts.at(-1));
    // A folder per episode ("Season 1/05/subs.ass") counts when it says so unmistakably or is just a number.
    for (let i = parts.length - 2; i >= 0 && info.episode === null && !info.range; i--) {
      info = readEpisode(parts[i], { strict: true });
      if (info.episode === null && !info.range && /^\d{1,3}$/.test(parts[i])) info = { season: null, episode: Number(parts[i]), range: null };
    }
    if (info.episode === null && !info.range && subtitles.length === 1) info = archive;

    const covers = info.range ? episode >= info.range[0] && episode <= info.range[1] : info.episode === episode;
    if (!covers) return false;
    const stated = info.season ?? fileSeason(entry.path);
    return !season || stated === null || stated === season;
  });
}
