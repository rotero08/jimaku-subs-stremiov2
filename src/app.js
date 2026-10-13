// The HTTP side: routes, headers, limits. No framework: it is a handful of GET routes.
//
//   GET  /                              the setup page          GET /health
//   GET  /manifest.json                 not-yet-configured       GET /icon.png, /logo.png, ...
//   GET  /:config/manifest.json         the user's addon         GET /convert/:token.srt
//   GET  /:config/configure             the setup page, filled   POST /api/validate
//   GET  /:config/subtitles/:type/:id[/:extra].json              GET /subtitles/:type/:id[/:extra].json

import { readdirSync, readFileSync } from 'node:fs';
import { createJimakuClient } from './jimaku/client.js';
import { silentLogger, redactPath } from './logger.js';
import { createAniList } from './meta/anilist.js';
import { createCinemeta } from './meta/cinemeta.js';
import { createKitsu } from './meta/kitsu.js';
import { buildManifest } from './stremio/manifest.js';
import { createSubtitleService } from './stremio/subtitles.js';
import { decodeConfig } from './stremio/userConfig.js';
import { ConvertError, createConverter, fromToken } from './subs/convert.js';

const PUBLIC = new URL('../public/', import.meta.url);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// The setup page loads nothing from anywhere else, runs no inline script and sets no inline style.
const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function loadAssets() {
  const assets = new Map();
  for (const name of readdirSync(PUBLIC)) {
    const ext = name.slice(name.lastIndexOf('.'));
    if (TYPES[ext]) assets.set(name, { body: readFileSync(new URL(name, PUBLIC)), type: TYPES[ext] });
  }
  return assets;
}

const isPrivateAddress = (ip = '') => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i.test(ip);

/** The visitor's address: the forwarded one only when the connection comes from a local proxy. */
export function clientIp(req) {
  const peer = req.socket?.remoteAddress ?? 'unknown';
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded && isPrivateAddress(peer) ? forwarded : peer;
}

function createRateLimiter({ perMinute, now = Date.now }) {
  const windows = new Map();
  const timer = setInterval(() => {
    const cutoff = now() - 60_000;
    for (const [ip, w] of windows) if (w.start < cutoff) windows.delete(ip);
  }, 60_000);
  timer.unref();
  return {
    allow(ip) {
      const t = now();
      const w = windows.get(ip);
      if (!w || t - w.start >= 60_000) {
        windows.set(ip, { start: t, count: 1 });
        return true;
      }
      return ++w.count <= perMinute;
    },
    stop: () => clearInterval(timer),
  };
}

const safeDecode = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function readBody(req, limit = 2048) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createApp({ config, fetchImpl = globalThis.fetch, logger = silentLogger }) {
  const jimaku = createJimakuClient({ config, fetchImpl, logger });
  const kitsu = createKitsu({ config, fetchImpl });
  const anilist = createAniList({ config, fetchImpl });
  const cinemeta = createCinemeta({ config, fetchImpl });
  const subtitles = createSubtitleService({ config, jimaku, kitsu, anilist, cinemeta, logger });
  const converter = createConverter({ config, fetchImpl, logger });
  const assets = loadAssets();
  const limiter = createRateLimiter({ perMinute: config.limits.validatePerMinute });

  /**
   * This server's public address: configured, or taken from how the request arrived. A proxy that
   * says nothing about https is assumed to have terminated it unless the host is a local one, since
   * Stremio only installs a remote addon over https anyway.
   */
  function baseUrlOf(req) {
    if (config.baseUrl) return config.baseUrl;
    const first = (value) => String(value ?? '').split(',')[0].trim();
    const host = first(req.headers['x-forwarded-host'] ?? req.headers.host);
    // Only a plausible host name goes into the links we hand out.
    const safeHost = /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? host : `localhost:${config.port}`;
    const name = safeHost.replace(/:\d+$/, '').toLowerCase();
    const local = name === 'localhost' || name.endsWith('.local') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name);
    const proto = first(req.headers['x-forwarded-proto']) || (req.socket.encrypted || !local ? 'https' : 'http');
    return `${proto === 'https' ? 'https' : 'http'}://${safeHost}`;
  }

  function send(req, res, status, body, headers = {}) {
    res.writeHead(status, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Host, X-Forwarded-Host, X-Forwarded-Proto',
      ...headers,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const json = (req, res, status, data, headers = {}) =>
    send(req, res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', ...headers });

  const notFound = (req, res) => json(req, res, 404, { error: 'Not found' }, { 'Cache-Control': 'no-store' });

  function asset(req, res, name, extra = {}) {
    const file = assets.get(name);
    if (!file) return notFound(req, res);
    return send(req, res, 200, file.body, { 'Content-Type': file.type, 'Cache-Control': 'public, max-age=3600', ...extra });
  }

  const page = (req, res) =>
    asset(req, res, 'configure.html', {
      'Content-Security-Policy': PAGE_CSP,
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-cache',
    });

  function manifest(req, res, segment) {
    const user = segment ? decodeConfig(segment) : null;
    if (segment && !user) return json(req, res, 400, { error: 'The settings in this address are not valid. Open the setup page again.' });
    const body = buildManifest({
      version: config.version,
      baseUrl: baseUrlOf(req),
      config: user ? segment : undefined,
      ready: Boolean(user || config.serverKey),
    });
    return json(req, res, 200, body, { 'Cache-Control': 'public, max-age=300' });
  }

  /** `raw` is [type, id[, extra]] exactly as sent (still percent-encoded); the last one ends in ".json". */
  async function subtitlesRoute(req, res, segment, raw) {
    const last = raw.length;
    const stripped = raw.map((part, i) => (i === last - 1 ? part.replace(/\.json$/, '') : part));
    const [type, id] = [stripped[0], stripped[1]].map(safeDecode);
    // The extra is a query string (videoHash=..&filename=..): URLSearchParams decodes each value
    // once, after splitting, so a file name that holds "&" or "+" survives.
    const extra = Object.fromEntries(new URLSearchParams(last >= 3 ? stripped[2] : ''));

    const user = segment ? decodeConfig(segment) : null;
    if (segment && !user) logger.warn('subtitles requested with an invalid config');
    const result = await withTimeout(
      subtitles.getSubtitles({ type, id, extra, user, baseUrl: baseUrlOf(req) }),
      config.limits.requestTimeoutMs,
      { subtitles: [], cacheMaxAge: 15 },
    );
    const age = result.cacheMaxAge;
    return json(req, res, 200, { subtitles: result.subtitles }, {
      'Cache-Control': age >= 600 ? `public, max-age=${age}, stale-while-revalidate=3600, stale-if-error=86400` : `public, max-age=${age}`,
    });
  }

  async function convertRoute(req, res, name) {
    try {
      const url = fromToken(name.replace(/\.srt$/, ''));
      const result = await converter.convert(url);
      return send(req, res, 200, result.body, {
        'Content-Type': result.contentType,
        'Cache-Control': 'public, max-age=3600',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
      });
    } catch (error) {
      if (error instanceof ConvertError) return json(req, res, error.status, { error: error.message }, { 'Cache-Control': 'no-store' });
      throw error;
    }
  }

  async function validateRoute(req, res) {
    if (!limiter.allow(clientIp(req))) return json(req, res, 429, { status: 'rate_limited' }, { 'Retry-After': '60' });
    let key;
    try {
      key = String(JSON.parse(await readBody(req)).jimakuApiKey ?? '').trim();
    } catch (error) {
      return json(req, res, error.status ?? 400, { error: 'send a JSON body like {"jimakuApiKey": "..."}' });
    }
    if (!/^[\x21-\x7e]{8,256}$/.test(key)) return json(req, res, 200, { status: 'invalid' }, { 'Cache-Control': 'no-store' });
    return json(req, res, 200, { status: await jimaku.checkKey(key) }, { 'Cache-Control': 'no-store' });
  }

  const STATIC = new Set(['icon.png', 'logo.png', 'configure.css', 'configure.js', 'codec.js']);

  async function route(req, res, url) {
    if (req.method === 'OPTIONS') return send(req, res, 204, undefined, { 'Access-Control-Max-Age': '86400' });

    const rawParts = url.pathname.split('/').filter(Boolean);
    const parts = rawParts.map(safeDecode);
    const isRead = req.method === 'GET' || req.method === 'HEAD';

    if (req.method === 'POST' && parts.join('/') === 'api/validate') return validateRoute(req, res);
    if (!isRead) return json(req, res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD, POST, OPTIONS' });

    const [first, second, ...rest] = parts;
    if (parts.length === 0 || (parts.length === 1 && first === 'configure')) return page(req, res);
    if (parts.length === 1 && first === 'health') {
      return json(req, res, 200, { status: 'ok', version: config.version, uptime: Math.round(process.uptime()) }, { 'Cache-Control': 'no-store' });
    }
    if (parts.length === 1 && first === 'manifest.json') return manifest(req, res, null);
    if (parts.length === 1 && STATIC.has(first)) return asset(req, res, first);
    if (parts.length === 1 && first === 'favicon.ico') return asset(req, res, 'logo.png');
    if (first === 'convert' && parts.length === 2) return convertRoute(req, res, second);
    if (first === 'subtitles' && parts.length >= 3 && parts.length <= 4) return subtitlesRoute(req, res, null, rawParts.slice(1));

    // Everything else starts with the user's settings.
    if (second === 'manifest.json' && parts.length === 2) return manifest(req, res, first);
    if (second === 'configure' && parts.length === 2) return page(req, res);
    if (second === 'subtitles' && rest.length >= 2 && rest.length <= 3) return subtitlesRoute(req, res, first, rawParts.slice(2));
    return notFound(req, res);
  }

  async function handler(req, res) {
    const started = process.hrtime.bigint();
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const quiet = res.statusCode < 400 && /^\/(health|static|icon|logo|favicon|configure\.)/.test(url.pathname);
      logger[quiet ? 'debug' : 'info']('request', { method: req.method, path: redactPath(url.pathname), status: res.statusCode, ms: Math.round(ms) });
    });
    try {
      await route(req, res, url);
    } catch (error) {
      logger.error('unhandled error', { path: redactPath(url.pathname), error: error.message });
      if (!res.headersSent) json(req, res, error.status ?? 500, { error: error.status === 413 ? 'Request too large' : 'Something went wrong' });
      else res.end();
    }
  }

  return { handler, services: { jimaku, kitsu, anilist, cinemeta, subtitles, converter }, close: () => limiter.stop() };
}
