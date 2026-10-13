// How the settings travel inside the addon's address, shared by the setup page and (through the
// tests) checked against the server's reader in src/stremio/userConfig.js.

const DEFAULTS = { assMode: 'srt', maxSubtitles: 10 };

/** Printable ASCII without spaces, 8 to 256 characters: the shape of a Jimaku API key. */
export const validKey = (value) => /^[\x21-\x7e]{8,256}$/.test(value);

/** base64url of a small JSON object; defaults are left out to keep the address short. */
export function encode(settings) {
  const body = { jimakuApiKey: settings.jimakuApiKey };
  if (settings.assMode !== DEFAULTS.assMode) body.assMode = settings.assMode;
  if (settings.maxSubtitles !== DEFAULTS.maxSubtitles) body.maxSubtitles = settings.maxSubtitles;
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The reverse, for the page Stremio opens from its "Configure" button; null when unreadable. */
export function decode(segment) {
  try {
    const normal = decodeURIComponent(segment).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normal + '='.repeat((4 - (normal.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const json = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof json?.jimakuApiKey !== 'string') return null;
    return {
      jimakuApiKey: json.jimakuApiKey,
      assMode: ['srt', 'ass', 'both'].includes(json.assMode) ? json.assMode : DEFAULTS.assMode,
      maxSubtitles: Number.isInteger(json.maxSubtitles) ? json.maxSubtitles : DEFAULTS.maxSubtitles,
    };
  } catch {
    return null;
  }
}
