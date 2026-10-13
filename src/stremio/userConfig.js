// The settings of one user, carried inside the addon's address:  /<config>/manifest.json
// <config> is base64 (standard or URL-safe, padded or not) of a small JSON object. The first
// version used {"jimakuApiKey": "...", "omdbApiKey": "..."}; those links keep working.

export const ASS_MODES = ['srt', 'ass', 'both'];
export const DEFAULTS = { assMode: 'srt', maxSubtitles: 10 };
export const MAX_SEGMENT_LENGTH = 2048;

const KEY_PATTERN = /^[\x21-\x7e]{8,256}$/; // printable ASCII, no spaces

/** @returns {string} the path segment for these settings */
export function encodeConfig({ jimakuApiKey, assMode = DEFAULTS.assMode, maxSubtitles = DEFAULTS.maxSubtitles }) {
  const body = { jimakuApiKey };
  if (assMode !== DEFAULTS.assMode) body.assMode = assMode;
  if (maxSubtitles !== DEFAULTS.maxSubtitles) body.maxSubtitles = maxSubtitles;
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

/**
 * @param {string} segment
 * @returns {{ jimakuApiKey: string, assMode: string, maxSubtitles: number } | null}
 */
export function decodeConfig(segment) {
  if (typeof segment !== 'string' || segment.length < 8 || segment.length > MAX_SEGMENT_LENGTH) return null;
  let json;
  try {
    const normal = decodeURIComponent(segment).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/]+$/.test(normal)) return null;
    json = JSON.parse(Buffer.from(normal, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;

  const key = typeof json.jimakuApiKey === 'string' ? json.jimakuApiKey.trim() : '';
  if (!KEY_PATTERN.test(key)) return null;
  const maxSubtitles = Number.isInteger(json.maxSubtitles) ? Math.min(30, Math.max(1, json.maxSubtitles)) : DEFAULTS.maxSubtitles;
  return {
    jimakuApiKey: key,
    assMode: ASS_MODES.includes(json.assMode) ? json.assMode : DEFAULTS.assMode,
    maxSubtitles,
  };
}

/** A short, non-reversible tag for logs and addon ids; never the key itself. */
export const configTag = (segment) => String(segment).slice(0, 8);
