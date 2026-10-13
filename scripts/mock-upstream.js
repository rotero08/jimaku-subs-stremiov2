// A pretend Jimaku, Kitsu, AniList and Cinemeta on one local port, with a few shows' worth of data.
//
// The tests run against it, and `npm run dev:mock` runs the addon against it, so everything can be
// tried without a Jimaku account or a network connection. It is a stand-in, not a copy: it knows
// the parts of each API this addon uses, shaped like the real answers.

import { createServer } from 'node:http';
import { loadConfig } from '../src/config.js';

export const VALID_KEY = 'valid-key-12345';

const FLAGS = (extra = {}) => ({ anime: true, movie: false, adult: false, external: false, unverified: false, ...extra });

export const ENTRIES = [
  { id: 101, name: 'Sousou no Frieren', english_name: "Frieren: Beyond Journey's End", japanese_name: '葬送のフリーレン', anilist_id: 154587, tmdb_id: 'tv:209867', flags: FLAGS() },
  { id: 102, name: 'Kimi no Na wa.', english_name: 'Your Name.', japanese_name: '君の名は。', anilist_id: 21519, tmdb_id: 'movie:372058', flags: FLAGS({ movie: true }) },
  { id: 103, name: 'Shingeki no Kyojin', english_name: 'Attack on Titan', japanese_name: '進撃の巨人', anilist_id: 16498, tmdb_id: 'tv:1429', flags: FLAGS() },
  { id: 104, name: 'Shingeki no Kyojin 2nd Season', english_name: 'Attack on Titan Season 2', japanese_name: '進撃の巨人 Season2', anilist_id: 25777, tmdb_id: 'tv:1429', flags: FLAGS() },
  { id: 105, name: 'Hanzawa Naoki', english_name: null, japanese_name: '半沢直樹', anilist_id: null, tmdb_id: 'tv:61769', flags: FLAGS({ anime: false }) },
];

// ---- subtitle files ---------------------------------------------------------------------------

const ASS_HEAD = `[Script Info]
Title: Mock
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans JP,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,10,10,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const LINES = [
  ['0:00:01.00', '0:00:03.50', '{\\an8}おはよう、フリーレン。'],
  ['0:00:04.00', '0:00:06.20', '{\\i1}…そうだね。{\\i0}\\N旅を続けよう。'],
  ['0:00:07.00', '0:00:09.00', 'ありがとう。'],
];

export const assFile = (tag = '') =>
  Buffer.from(ASS_HEAD + LINES.map(([a, b, text]) => `Dialogue: 0,${a},${b},Default,,0,0,0,,${text}${tag}\n`).join(''), 'utf8');

export const srtFile = () =>
  Buffer.from('1\n00:00:01,000 --> 00:00:03,500\nおはよう、フリーレン。\n\n2\n00:00:04,000 --> 00:00:06,200\n…そうだね。\n旅を続けよう。\n', 'utf8');

/** "こんにちは、世界。" as Shift-JIS, inside an SRT: what an old fansub might ship. */
export const sjisSrt = () =>
  Buffer.concat([
    Buffer.from('1\r\n00:00:01,000 --> 00:00:03,000\r\n'),
    Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd, 0x81, 0x41, 0x90, 0xa2, 0x8a, 0x45, 0x81, 0x42]),
    Buffer.from('\r\n'),
  ]);

const file = (name, episode, body) => ({ name, episode, body });

const episodeFiles = (id, show, episodes) =>
  episodes.flatMap((n) => {
    const nn = String(n).padStart(2, '0');
    return [
      file(`[SubsPlease] ${show} - ${nn} (1080p) [A1B2C3D4].ass`, n, assFile()),
      file(`[Erai-raws] ${show} - ${nn} [1080p][Multiple Subtitle].srt`, n, srtFile()),
      file(`${show} - ${nn}.ja.srt`, n, sjisSrt()),
    ];
  });

export const FILES = {
  101: [...episodeFiles(101, 'Sousou no Frieren', [1, 2, 3]), file('Sousou no Frieren - All episodes.zip', null, Buffer.from('PK\u0003\u0004'))],
  102: [file('Kimi no Na wa. (2016) [BD 1080p].srt', null, srtFile()), file('Kimi no Na wa. (2016) [BD 1080p].ass', null, assFile())],
  103: [file('Shingeki no Kyojin - 05.srt', 5, srtFile())],
  104: [file('Attack on Titan S02E05.srt', 5, srtFile())],
  105: [file('Hanzawa Naoki S01E03.srt', 3, srtFile()), file('Hanzawa Naoki S02E03.srt', 3, srtFile())],
};

// ---- Kitsu, AniList, Cinemeta -----------------------------------------------------------------

const KITSU_ANIME = {
  46474: { canonicalTitle: 'Sousou no Frieren', titles: { en: "Frieren: Beyond Journey's End", en_jp: 'Sousou no Frieren', ja_jp: '葬送のフリーレン' }, anilist: 154587 },
  // Kitsu knows this one but has recorded no AniList id: the addon has to search by title.
  999001: { canonicalTitle: 'Shingeki no Kyojin', titles: { en: 'Attack on Titan', en_jp: 'Shingeki no Kyojin' }, anilist: null },
  999002: { canonicalTitle: 'A Show Nobody Subtitled', titles: { en_jp: 'A Show Nobody Subtitled' }, anilist: null },
};
// Kitsu can tie one AniDB id to several items; here, a recap special listed before the series.
const ANIDB_TO_KITSU = {
  17617: [{ id: 46474, subtype: 'TV' }],
  23: [{ id: 3424, subtype: 'special' }, { id: 1, subtype: 'TV' }],
};
const MAL_TO_ANILIST = { 52991: 154587, 32281: 21519 };

const CINEMETA = {
  'series/tt22248376': { name: "Frieren: Beyond Journey's End", year: '2023–', moviedb_id: 209867, genres: ['Animation', 'Adventure', 'Drama'], country: 'Japan' },
  'movie/tt5311514': { name: 'Your Name.', year: '2016', moviedb_id: 372058, genres: ['Animation', 'Drama', 'Romance'], country: 'Japan' },
  'series/tt2560140': { name: 'Attack on Titan', year: '2013–2023', moviedb_id: 1429, genres: ['Animation', 'Action', 'Drama'], country: 'Japan' },
  'series/tt9990001': { name: 'Hanzawa Naoki', year: '2013', moviedb_id: 61769, genres: ['Drama'], country: 'Japan' },
  'series/tt9990002': { name: 'A Western Cartoon', year: '2020', moviedb_id: 4242, genres: ['Animation', 'Comedy'], country: 'USA' },
};

// ---- the server -------------------------------------------------------------------------------

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const norm = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function searchEntries(q) {
  let list = ENTRIES;
  if (q.has('anilist_id')) list = list.filter((e) => String(e.anilist_id) === q.get('anilist_id'));
  if (q.has('tmdb_id')) list = list.filter((e) => e.tmdb_id === q.get('tmdb_id'));
  if (q.has('query')) {
    const needle = norm(q.get('query'));
    list = list.filter((e) => [e.name, e.english_name, e.japanese_name].some((n) => n && norm(n).includes(needle)));
  }
  if (q.has('anime')) list = list.filter((e) => String(e.flags.anime) === q.get('anime'));
  return list;
}

/**
 * @param {object} [options]
 * @param {(key: string) => boolean} [options.acceptKey]   which Jimaku keys work (default: only VALID_KEY)
 * @param {number} [options.port]                          0 picks a free one
 */
export async function startMockUpstream({ acceptKey = (key) => key === VALID_KEY, port = 0 } = {}) {
  const requests = [];
  const state = { limit: 0, retryAfter: 0, fail: 0, failStatus: 500, delayMs: 0 };
  let origin = '';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const path = url.pathname;
    const service = path.startsWith('/jimaku/') ? 'jimaku' : path.startsWith('/kitsu/') ? 'kitsu' : path.startsWith('/anilist') ? 'anilist' : path.startsWith('/cinemeta/') ? 'cinemeta' : 'download';
    requests.push({ service, method: req.method, path, query: Object.fromEntries(url.searchParams), headers: req.headers });
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));

    // ---- Jimaku
    if (service === 'jimaku') {
      const key = req.headers.authorization ?? '';
      if (!acceptKey(key)) return json(res, 401, { error: 'Unauthorized', code: 401 });
      if (state.limit > 0) {
        state.limit--;
        return json(res, 429, { error: 'You are being rate limited.', code: 429 }, { 'x-ratelimit-limit': '25', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': String(state.retryAfter), 'retry-after': String(state.retryAfter) });
      }
      if (state.fail > 0) {
        state.fail--;
        return json(res, state.failStatus, { error: 'boom' });
      }
      const headers = { 'x-ratelimit-limit': '25', 'x-ratelimit-remaining': '20', 'x-ratelimit-reset-after': '5' };
      if (path === '/jimaku/entries/search') return json(res, 200, searchEntries(url.searchParams), headers);
      const files = /^\/jimaku\/entries\/(\d+)\/files$/.exec(path);
      if (files) {
        const id = Number(files[1]);
        if (!FILES[id]) return json(res, 404, { error: 'Entry not found', code: 404 }, headers);
        const episode = url.searchParams.get('episode');
        const list = FILES[id].filter((f) => episode === null || f.episode === null || String(f.episode) === episode);
        return json(res, 200, list.map((f) => ({ name: f.name, url: `${origin}/entry/${id}/download/${encodeURIComponent(f.name)}`, size: f.body.length, last_modified: '2024-01-01T00:00:00Z' })), headers);
      }
      return json(res, 404, { error: 'No such route', code: 404 });
    }

    // ---- Kitsu
    if (service === 'kitsu') {
      let m;
      if ((m = /^\/kitsu\/anime\/(\d+)\/mappings$/.exec(path))) {
        const anime = KITSU_ANIME[m[1]];
        return json(res, 200, { data: anime?.anilist ? [{ type: 'mappings', attributes: { externalSite: 'anilist/anime', externalId: String(anime.anilist) } }] : [] });
      }
      if ((m = /^\/kitsu\/anime\/(\d+)$/.exec(path))) {
        const anime = KITSU_ANIME[m[1]];
        if (!anime) return json(res, 404, { errors: [{ title: 'The requested record could not be found', status: '404' }] });
        return json(res, 200, { data: { id: m[1], type: 'anime', attributes: { canonicalTitle: anime.canonicalTitle, titles: anime.titles } } });
      }
      if (path === '/kitsu/mappings') {
        const items = ANIDB_TO_KITSU[url.searchParams.get('filter[externalId]')] ?? [];
        return json(res, 200, { data: [], included: items.map((i) => ({ id: String(i.id), type: 'anime', attributes: { canonicalTitle: 'x', subtype: i.subtype } })) });
      }
      return json(res, 404, { errors: [] });
    }

    // ---- AniList (GraphQL, one query)
    if (service === 'anilist') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const id = MAL_TO_ANILIST[body.variables?.mal];
      if (!id) return json(res, 404, { data: { Media: null }, errors: [{ message: 'Not Found.', status: 404 }] });
      return json(res, 200, { data: { Media: { id } } });
    }

    // ---- Cinemeta
    if (service === 'cinemeta') {
      const m = /^\/cinemeta\/meta\/(\w+)\/(tt\d+)\.json$/.exec(path);
      const meta = m && CINEMETA[`${m[1]}/${m[2]}`];
      return meta ? json(res, 200, { meta: { id: m[2], type: m[1], ...meta } }) : json(res, 200, { meta: {} });
    }

    // ---- file downloads, plus the awkward cases the converter has to survive
    const dl = /^\/entry\/(\d+)\/download\/(.+)$/.exec(path);
    if (dl) {
      let name = dl[2];
      try {
        name = decodeURIComponent(name);
      } catch {
        // keep the raw text: one test downloads a file whose name holds a stray "%"
      }
      if (name === 'redirect-away') return void (res.writeHead(302, { Location: 'http://169.254.169.254/entry/1/download/secret.srt' }), res.end());
      if (name === 'redirect-inside') return void (res.writeHead(302, { Location: `${origin}/entry/101/download/${encodeURIComponent(FILES[101][1].name)}` }), res.end());
      if (name === 'redirect-loop') return void (res.writeHead(302, { Location: `${origin}/entry/1/download/redirect-loop` }), res.end());
      if (name === 'huge.srt') return void (res.writeHead(200, { 'Content-Type': 'text/plain' }), res.end(Buffer.alloc(5 * 1024 * 1024, 0x41)));
      if (name === 'empty.srt') return void (res.writeHead(200), res.end(''));
      if (name === 'broken-name%.srt') return void (res.writeHead(200), res.end(srtFile()));
      const found = (FILES[Number(dl[1])] ?? []).find((f) => f.name === name);
      if (!found) return void (res.writeHead(404, { 'Content-Type': 'text/plain' }), res.end('not found'));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return void res.end(found.body);
    }
    return json(res, 404, { error: 'unknown route' });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    host: `127.0.0.1:${address.port}`,
    requests,
    count: (service) => requests.filter((r) => r.service === service).length,
    /** The next `count` Jimaku calls answer 429, asking for a wait of `retryAfterSeconds`. */
    limitNext(count, retryAfterSeconds) {
      state.limit = count;
      state.retryAfter = retryAfterSeconds;
    },
    /** The next `count` Jimaku calls fail with `status`. */
    failNext(status, count = 1) {
      state.fail = count;
      state.failStatus = status;
    },
    delay(ms) {
      state.delayMs = ms;
    },
    /** A config that sends every upstream call here and allows downloads from here. */
    config(env = {}) {
      return loadConfig({
        JIMAKU_API_URL: `${origin}/jimaku`,
        KITSU_API_URL: `${origin}/kitsu`,
        ANILIST_API_URL: `${origin}/anilist`,
        CINEMETA_URL: `${origin}/cinemeta`,
        JIMAKU_DOWNLOAD_HOSTS: `${address.address}:${address.port}`,
        JIMAKU_MIN_INTERVAL_MS: '0',
        UPSTREAM_TIMEOUT_MS: '2000',
        ...env,
      });
    },
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))),
  };
}
