// Everything the server reads from the environment, in one place, with defaults.

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const list = (value, fallback) =>
  (value ?? fallback)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const noSlash = (url) => url.replace(/\/+$/, '');

/**
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
  return {
    version: VERSION,
    port: int(env.PORT, 7000),
    host: env.HOST ?? '0.0.0.0',
    // Public address of this server, when it cannot be worked out from the request.
    baseUrl: env.BASE_URL ? noSlash(env.BASE_URL) : null,
    // A key that serves everybody, for a private server: no per-user key is then needed.
    serverKey: env.JIMAKU_API_KEY || null,
    logLevel: env.LOG_LEVEL ?? 'info',
    logFormat: env.LOG_FORMAT ?? (env.NODE_ENV === 'production' ? 'json' : 'pretty'),
    userAgent: env.USER_AGENT ?? `jimaku-sakura-stremio/${VERSION} (Stremio addon)`,
    publishToCentral: env.PUBLISH_TO_CENTRAL === 'true',
    upstream: {
      jimaku: noSlash(env.JIMAKU_API_URL ?? 'https://jimaku.cc/api'),
      kitsu: noSlash(env.KITSU_API_URL ?? 'https://kitsu.io/api/edge'),
      anilist: env.ANILIST_API_URL ?? 'https://graphql.anilist.co',
      cinemeta: noSlash(env.CINEMETA_URL ?? 'https://v3-cinemeta.strem.io'),
    },
    // Subtitle files are only ever fetched from these hosts.
    downloadHosts: list(env.JIMAKU_DOWNLOAD_HOSTS, 'jimaku.cc'),
    limits: {
      upstreamTimeoutMs: int(env.UPSTREAM_TIMEOUT_MS, 6000),
      requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 15000),
      maxSubtitleBytes: int(env.MAX_SUBTITLE_BYTES, 4 * 1024 * 1024),
      // ZIP archives are read in pieces, so this only bounds an archive that a server hands over whole.
      maxArchiveBytes: int(env.MAX_ARCHIVE_BYTES, 32 * 1024 * 1024),
      // Most archives opened to find one episode, per lookup.
      maxArchives: int(env.MAX_ARCHIVES, 3),
      // Jimaku allows few requests per window and shares them across everyone on this server.
      jimakuMinIntervalMs: int(env.JIMAKU_MIN_INTERVAL_MS, 250),
      jimakuMaxWaitMs: int(env.JIMAKU_MAX_WAIT_MS, 4000),
      validatePerMinute: int(env.VALIDATE_PER_MINUTE, 20),
    },
  };
}
