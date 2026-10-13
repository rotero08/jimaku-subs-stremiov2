// Fetching a subtitle file from Jimaku and serving it as UTF-8 SRT (converting ASS on the way).
//
// The address to fetch arrives in a URL that anyone can call, so it is checked hard: only the
// configured hosts, only Jimaku's download path, and every redirect is checked again.

import { TtlCache } from '../cache.js';
import { request } from '../http.js';
import { assToSrt, looksLikeAss } from './ass.js';
import { decodeSubtitle } from './encoding.js';

export class ConvertError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ConvertError';
    this.status = status;
  }
}

const DOWNLOAD_PATH = /^\/entry\/\d+\/download\/[^/]+$/;

const safeDecode = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

export const toToken = (url) => Buffer.from(url, 'utf8').toString('base64url');
export const fromToken = (token) => Buffer.from(token, 'base64url').toString('utf8');

/** Throws unless `value` is a Jimaku download address on an allowed host. */
export function assertDownloadUrl(value, allowedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConvertError('that is not a valid address');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ConvertError('that address is not allowed');
  if (!allowedHosts.includes(url.host.toLowerCase())) throw new ConvertError('that host is not allowed', 403);
  if (!DOWNLOAD_PATH.test(url.pathname)) throw new ConvertError('that is not a Jimaku download address');
  // "..%2f..%2fadmin" is one path segment to the pattern above, but a slash once Jimaku decodes it.
  const name = safeDecode(url.pathname.split('/').pop());
  if (name.includes('/') || name.includes('\\') || [...name].some((c) => c < ' ') || name === '.' || name === '..') {
    throw new ConvertError('that is not a Jimaku download address');
  }
  return url;
}

export function createConverter({ config, fetchImpl = globalThis.fetch, logger }) {
  const cache = new TtlCache({ maxEntries: 400, maxWeight: 24 * 1024 * 1024, weigh: (v) => v.body.length });
  const hostAllowed = (url) => {
    try {
      return config.downloadHosts.includes(new URL(url).host.toLowerCase());
    } catch {
      return false;
    }
  };

  async function load(url) {
    const result = await request(fetchImpl, url, {
      headers: { 'User-Agent': config.userAgent },
      timeoutMs: config.limits.upstreamTimeoutMs + 2000,
      maxBytes: config.limits.maxSubtitleBytes,
      allowRedirect: hostAllowed,
    }).catch((error) => {
      throw new ConvertError(error.status === 413 ? 'that file is too large' : `could not fetch the file (${error.message})`, error.status === 413 ? 413 : 502);
    });
    if (result.status === 404) throw new ConvertError('that file no longer exists', 404);
    if (result.status !== 200) throw new ConvertError(`Jimaku answered ${result.status}`, 502);

    const { text, encoding } = decodeSubtitle(result.body);
    const name = safeDecode(new URL(url).pathname.split('/').pop());
    const isAss = /\.(ass|ssa)$/i.test(name) || looksLikeAss(text);
    const body = isAss ? assToSrt(text) : text.replace(/\r\n?/g, '\n');
    if (!body.trim()) throw new ConvertError('that file holds no subtitles', 422);

    const vtt = !isAss && /^\s*WEBVTT/.test(body);
    logger?.debug('converted subtitle', { name, encoding, from: isAss ? 'ass' : vtt ? 'vtt' : 'srt', bytes: result.body.length });
    return {
      body,
      contentType: vtt ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8',
      filename: name.replace(/\.(ass|ssa|srt|vtt)$/i, '') + (vtt ? '.vtt' : '.srt'),
    };
  }

  return {
    async convert(url) {
      const checked = assertDownloadUrl(url, config.downloadHosts);
      return cache.wrap(checked.href, 6 * 3600_000, () => load(checked.href));
    },
  };
}
