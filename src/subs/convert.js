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

/** The token for one file inside a ZIP: the archive's address and the file's path in it. */
export const toMemberToken = (url, member) => Buffer.from(JSON.stringify({ u: url, f: member }), 'utf8').toString('base64url');

/**
 * What a token stands for: a Jimaku file ({ url }) or a file inside a ZIP ({ url, member }).
 * Tokens made before archives were supported are the bare address, and still work.
 */
export function parseToken(token) {
  const text = fromToken(token);
  if (!text.startsWith('{')) return { url: text, member: null };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ConvertError('that address is not valid');
  }
  if (typeof data?.u !== 'string' || typeof data?.f !== 'string' || !data.f || data.f.length > 1024) throw new ConvertError('that address is not valid');
  return { url: data.u, member: data.f };
}

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

/**
 * @param {object} options
 * @param {ReturnType<import('./archive.js').createArchiveService>} [options.archives]   to read files inside ZIPs
 */
export function createConverter({ config, fetchImpl = globalThis.fetch, logger, archives }) {
  const cache = new TtlCache({ maxEntries: 400, maxWeight: 24 * 1024 * 1024, weigh: (v) => v.body.length });
  const hostAllowed = (url) => {
    try {
      return config.downloadHosts.includes(new URL(url).host.toLowerCase());
    } catch {
      return false;
    }
  };

  /** The file's bytes from Jimaku, and its name. */
  async function download(url) {
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
    return { bytes: result.body, name: safeDecode(new URL(url).pathname.split('/').pop()) };
  }

  /** The bytes of one file inside a ZIP, and its name. */
  async function unpack(url, member) {
    if (!archives) throw new ConvertError('archives are not supported here', 501);
    const archive = await archives.open(url);
    const entry = archive.entries.find((candidate) => candidate.path === member && !candidate.directory);
    if (!entry) throw new ConvertError('that file is not in the archive', 404);
    return { bytes: await archives.read(archive, entry), name: member.split('/').pop() };
  }

  /** Decodes a subtitle file and writes it as UTF-8: SRT or VTT, or ASS itself when `keepAss`. */
  function render({ bytes, name }, { keepAss }) {
    const { text, encoding } = decodeSubtitle(bytes);
    const isAss = /\.(ass|ssa)$/i.test(name) || looksLikeAss(text);
    if (keepAss && !isAss) throw new ConvertError('that file is not an ASS file', 422);
    const body = isAss && !keepAss ? assToSrt(text) : text.replace(/\r\n?/g, '\n');
    if (!body.trim()) throw new ConvertError('that file holds no subtitles', 422);

    const vtt = !isAss && /^\s*WEBVTT/.test(body);
    logger?.debug('converted subtitle', { name, encoding, from: isAss ? 'ass' : vtt ? 'vtt' : 'srt', bytes: bytes.length });
    if (keepAss) return { body, contentType: 'text/x-ssa; charset=utf-8', filename: name };
    return {
      body,
      contentType: vtt ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8',
      filename: name.replace(/\.(ass|ssa|srt|vtt)$/i, '') + (vtt ? '.vtt' : '.srt'),
    };
  }

  return {
    /**
     * @param {string | { url: string, member?: string | null }} source   a Jimaku download address, or one and the path of a file inside it
     * @param {{ as?: 'srt' | 'vtt' | 'ass' }} [options]   `ass` returns an ASS file as it is (decoded to UTF-8), the others convert
     */
    async convert(source, { as } = {}) {
      const { url, member = null } = typeof source === 'string' ? { url: source } : source;
      const checked = assertDownloadUrl(url, config.downloadHosts);
      const keepAss = as === 'ass';
      return cache.wrap(`${checked.href}#${member ?? ''}#${keepAss ? 'ass' : ''}`, 6 * 3600_000, async () =>
        render(member === null ? await download(checked.href) : await unpack(checked.href, member), { keepAss }),
      );
    },
  };
}
