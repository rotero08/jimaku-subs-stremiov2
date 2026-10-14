// ZIP archives on Jimaku: open one over HTTP, list what it holds, extract one file.
//
// Subtitles are often uploaded as a ZIP of a whole season, which may also carry fonts, so an
// archive is never downloaded whole when it can be avoided: a ranged request fetches the end of the
// file (where the directory is), and a second one the packed bytes of the single file wanted.
// Servers that ignore Range answer with the whole file, which is then used if it is small enough.
//
// Opened archives are remembered (their directory, not the files), and so are failures, for a
// shorter time, so one broken archive cannot make every lookup pay for it again.

import { TtlCache } from '../cache.js';
import { HttpError, request } from '../http.js';
import { assertDownloadUrl, ConvertError } from './convert.js';
import { extract, memorySource, readDirectory, TAIL_BYTES, ZipError } from './zip.js';

const MINUTE = 60_000;

/** "bytes 100-199/5000" */
function rangeOf(headers) {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers.get('content-range') ?? '');
  return m ? { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) } : null;
}

/** Problems with an archive's contents are the archive's fault (422), not the server's. */
function asConvertError(error) {
  if (error instanceof ZipError) return new ConvertError(error.message, error.code === 'too-large' ? 413 : 422);
  return error;
}

export function createArchiveService({ config, fetchImpl = globalThis.fetch, logger, now = Date.now }) {
  const { upstreamTimeoutMs, maxSubtitleBytes, maxArchiveBytes } = config.limits;
  const directories = new TtlCache({ maxEntries: 300, maxWeight: 2 * maxArchiveBytes, weigh: (archive) => archive.weight, now });
  const failures = new TtlCache({ maxEntries: 300, now });
  const hostAllowed = (url) => {
    try {
      return config.downloadHosts.includes(new URL(url).host.toLowerCase());
    } catch {
      return false;
    }
  };

  async function fetchRange(url, range, maxBytes) {
    try {
      return await request(fetchImpl, url, {
        // identity: byte ranges mean the bytes of the file itself, not of some compressed copy of it
        headers: { 'User-Agent': config.userAgent, 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) },
        timeoutMs: upstreamTimeoutMs + 2000,
        maxBytes,
        allowRedirect: hostAllowed,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      throw new ConvertError(error.status === 413 ? 'that archive is too large' : `could not fetch the archive (${error.message})`, error.status === 413 ? 413 : 502);
    }
  }

  /** A source for `read` over HTTP: pieces of the file by Range, the end of it already in hand. */
  function rangedSource(url, total, tail, tailStart) {
    return {
      size: total,
      async read(start, end) {
        end = Math.min(end, total);
        if (start >= tailStart) return tail.subarray(start - tailStart, end - tailStart);
        const response = await fetchRange(url, `bytes=${start}-${end - 1}`, end - start + 1024);
        const range = rangeOf(response.headers);
        if (response.status !== 206 || range?.start !== start || response.body.length !== range.end - range.start + 1) {
          throw new ConvertError('the server did not send the part of the archive that was asked for', 502);
        }
        return response.body;
      },
    };
  }

  async function load(url) {
    let response = await fetchRange(url, `bytes=-${TAIL_BYTES}`, maxArchiveBytes);
    // A server that finds a suffix longer than the file unsatisfiable: ask for the file itself.
    if (response.status === 416) response = await fetchRange(url, null, maxArchiveBytes);
    if (response.status === 404) throw new ConvertError('that archive no longer exists', 404);

    let source;
    let weight;
    if (response.status === 206) {
      const range = rangeOf(response.headers);
      if (!range || response.body.length !== range.end - range.start + 1 || range.end !== range.total - 1) {
        throw new ConvertError('the server answered a range request oddly', 502);
      }
      source = rangedSource(url, range.total, response.body, range.start);
      weight = response.body.length;
    } else if (response.status === 200) {
      source = memorySource(response.body); // the server ignores Range: this is the whole archive
      weight = response.body.length;
    } else {
      throw new ConvertError(`Jimaku answered ${response.status}`, 502);
    }

    const entries = await readDirectory(source).catch((error) => {
      throw asConvertError(error);
    });
    logger?.debug('opened archive', { files: entries.length, bytes: source.size, whole: response.status === 200 });
    return { url, size: source.size, entries, source, weight: weight + entries.length * 160 };
  }

  return {
    /**
     * Opens an archive: `{ entries, size, ... }`, the entries being the files it holds.
     * @param {string} url   a Jimaku download address
     */
    async open(url) {
      const checked = assertDownloadUrl(url, config.downloadHosts).href;
      const failed = failures.get(checked);
      if (failed) throw failed;
      try {
        return await directories.wrap(checked, 30 * MINUTE, () => load(checked));
      } catch (error) {
        // Remember what will not get better by asking again, but not a network hiccup (502).
        if (error instanceof ConvertError && error.status !== 502) failures.set(checked, error, 10 * MINUTE);
        throw error;
      }
    },

    /** The contents of one file of an opened archive. */
    read: (archive, entry) => extract(archive.source, entry, { maxBytes: maxSubtitleBytes }).catch((error) => {
      throw asConvertError(error);
    }),
  };
}
