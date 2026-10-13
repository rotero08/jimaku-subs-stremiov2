// Deciding which Jimaku entry and which files are the right ones.
//
// Exact ids (AniList, TMDB) settle the entry when they can. When they cannot, titles are
// compared; and whatever the route, the *files* of an entry are filtered by season and ordered by
// how closely their release resembles the video being played, because a subtitle made for the
// same release is the one that is in sync.

// ---------------------------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------------------------

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'no', 'wa', 'ga', 'to', 'in', 'on', 'season', 'part']);
const HAN_KANA = /[぀-ヿ㐀-鿿]/;

/** Lower-case, accents and punctuation removed, one space between words. */
export function normalizeTitle(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/\(\s*\d{4}\s*\)/g, ' ') // "(2023)"
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokens(normalized) {
  const out = new Set();
  for (const word of normalized.split(' ')) {
    if (!word || STOPWORDS.has(word)) continue;
    if (HAN_KANA.test(word)) {
      // Japanese has no spaces: compare overlapping pairs of characters.
      const chars = [...word];
      if (chars.length === 1) out.add(word);
      for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
    } else out.add(word);
  }
  return out;
}

/** 0 (nothing in common) to 1 (the same title). */
export function titleSimilarity(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const tx = tokens(x);
  const ty = tokens(y);
  if (!tx.size || !ty.size) return 0;
  let shared = 0;
  for (const t of tx) if (ty.has(t)) shared++;
  const dice = (2 * shared) / (tx.size + ty.size);
  // A short title inside a longer one ("Frieren" in "Sousou no Frieren") is a strong hint too.
  const containment = shared / Math.min(tx.size, ty.size);
  return Math.max(dice, tx.size === 1 || ty.size === 1 ? containment * 0.8 : containment * 0.7);
}

const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5 };

/** The season a title says it is ("2nd Season", "Season 3", "S2", "第2期", "II"), or null. */
export function seasonHint(name) {
  const text = String(name ?? '');
  let m;
  if ((m = /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i.exec(text))) return Number(m[1]);
  if ((m = /\bseason\s*(\d{1,2})\b/i.exec(text))) return Number(m[1]);
  if ((m = /第?\s*(\d{1,2})\s*期/.exec(text))) return Number(m[1]);
  if ((m = /シーズン\s*(\d{1,2})/.exec(text))) return Number(m[1]);
  if ((m = /\bs(\d{1,2})\b/i.exec(text))) return Number(m[1]);
  if ((m = /\b(ii|iii|iv|v)\s*$/i.exec(text.trim()))) return ROMAN[m[1].toLowerCase()];
  if ((m = /\S\s([2-9])\s*$/.exec(text.trim()))) return Number(m[1]);
  return null;
}

/**
 * Scores a Jimaku entry against the titles we know for the thing being played (0..1.2).
 * @param {{ name: string, englishName?: string | null, japaneseName?: string | null }} entry
 * @param {string[]} titles
 * @param {{ season?: number | null }} [wanted]
 */
export function scoreEntry(entry, titles, { season = null } = {}) {
  const names = [entry.name, entry.englishName, entry.japaneseName].filter(Boolean);
  let best = 0;
  for (const name of names) for (const title of titles) best = Math.max(best, titleSimilarity(name, title));
  if (best === 0) return 0;

  const hints = names.map(seasonHint).filter((h) => h !== null);
  const hint = hints.length ? hints[0] : null;
  if (season && season > 1) {
    if (hint === season) best += 0.15;
    else if (hint !== null) best -= 0.35;
    else best -= 0.1;
  } else if (hint !== null && hint > 1) {
    best -= 0.35; // we want the first season and this entry names a later one
  }
  return best;
}

/** The entries that plausibly are the wanted title, best first. */
export function rankEntries(entries, titles, options = {}) {
  const threshold = options.threshold ?? 0.6;
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, titles, options) }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

/**
 * Of several entries that share one TMDB show (Jimaku keeps one per season), the ones that can be
 * `season`. An entry that names no season is taken for the first, which is how AniList titles it.
 * A lone entry is kept whatever it says: it covers the whole show, and its files get filtered.
 */
export function entriesForSeason(entries, season) {
  if (!season || entries.length <= 1) return entries;
  const hintOf = (entry) => [entry.name, entry.englishName, entry.japaneseName].map(seasonHint).find((h) => h !== null) ?? null;
  const named = entries.filter((entry) => hintOf(entry) === season);
  if (named.length) return named;
  return season === 1 ? entries.filter((entry) => hintOf(entry) === null) : [];
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/** 'srt' | 'vtt' | 'ass' | 'ssa' | 'archive' | 'other' */
export function fileKind(name) {
  const ext = /\.([a-z0-9]{2,4})$/i.exec(String(name))?.[1].toLowerCase();
  if (['srt', 'vtt', 'ass', 'ssa'].includes(ext)) return ext;
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
  return 'other';
}

/** The season a file name states (S02E05, 2x05, "Season 2"), or null when it does not say. */
export function fileSeason(name) {
  const text = String(name ?? '');
  let m;
  if ((m = /\bS(\d{1,2})[ ._-]?E\d{1,4}/i.exec(text))) return Number(m[1]);
  if ((m = /\bseason[ ._-]?(\d{1,2})\b/i.exec(text))) return Number(m[1]);
  if ((m = /\b(\d{1,2})x\d{2,3}\b/.exec(text))) return Number(m[1]);
  if ((m = /\b(\d{1,2})(?:st|nd|rd|th)[ ._-]season\b/i.exec(text))) return Number(m[1]);
  return null;
}

/**
 * Keeps the files that can belong to `season`. A file that names another season is dropped; one
 * that names none is kept (many entries number episodes without saying which season).
 */
export function filterBySeason(files, season) {
  if (!season) return files;
  return files.filter((file) => {
    const stated = fileSeason(file.name);
    return stated === null || stated === season;
  });
}

const RELEASE_NOISE = new Set(['jp', 'ja', 'jpn', 'jap', 'srt', 'ass', 'ssa', 'vtt', 'sub', 'subs', 'mkv', 'mp4', 'avi']);
const QUALITY = /^(?:\d{3,4}p|x26[45]|h26[45]|hevc|av1|bd|bdrip|bluray|web|webrip|webdl|hdtv|dvd|dvdrip|aac|flac|10bit|8bit)$/;

/** The release group: the first [bracketed] name, ignoring resolutions and hashes. */
export function releaseGroup(name) {
  const m = /^\s*\[([^\]]{2,40})\]/.exec(String(name));
  if (!m) return null;
  const group = m[1].trim();
  return /^(?:\d{3,4}p|[0-9a-f]{8})$/i.test(group) ? null : group;
}

/** The distinct words of a release name, in lower case, without extensions and language tags. */
export function releaseTokens(name) {
  const stripped = String(name).replace(/\.[a-z0-9]{2,4}$/i, '');
  return new Set(
    stripped
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1 && !RELEASE_NOISE.has(t)),
  );
}

/** 0..1: how alike two release names are (same group, same resolution and source, same title words). */
export function releaseSimilarity(videoName, fileName) {
  if (!videoName) return 0;
  const a = releaseTokens(videoName);
  const b = releaseTokens(fileName);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  let sharedQuality = 0;
  for (const t of a) {
    if (!b.has(t)) continue;
    shared++;
    if (QUALITY.test(t)) sharedQuality++;
  }
  const jaccard = shared / (a.size + b.size - shared);
  const group = releaseGroup(videoName)?.toLowerCase();
  const sameGroup = group !== undefined && group === releaseGroup(fileName)?.toLowerCase();
  // Weights add up to 1, so an identical release always outranks one that only shares a group.
  return 0.6 * jaccard + (sameGroup ? 0.25 : 0) + 0.15 * (Math.min(sharedQuality, 3) / 3);
}

/** A short label for Stremio's subtitle picker: "SubsPlease · 1080p · ASS→SRT". */
export function labelFor(name, { converted = false } = {}) {
  const kind = fileKind(name);
  const group = releaseGroup(name);
  const resolution = /\b(\d{3,4}p)\b/i.exec(name)?.[1];
  let base = group;
  if (!base) {
    base = String(name)
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/\.(?:jp|ja|jpn)$/i, '')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (base.length > 34) base = `${base.slice(0, 33).trimEnd()}…`;
  }
  const format = kind === 'ass' || kind === 'ssa' ? (converted ? 'ASS→SRT' : kind.toUpperCase()) : kind.toUpperCase();
  return [base, resolution, format].filter(Boolean).join(' · ');
}
