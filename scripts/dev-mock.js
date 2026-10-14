#!/usr/bin/env node
// Runs the addon against the pretend Jimaku, Kitsu, AniList and Cinemeta of mock-upstream.js, so
// the setup page and the whole subtitle flow can be tried with no Jimaku account and no network.
//
//   npm run dev:mock            then open http://localhost:7000/configure
//
// Any API key of 8+ characters works, except one that starts with "bad" (to see a rejected key).

import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { encodeConfig } from '../src/stremio/userConfig.js';
import { startMockUpstream } from './mock-upstream.js';

const mock = await startMockUpstream({ acceptKey: (key) => key.length >= 8 && !key.startsWith('bad') });
const config = mock.config({ PORT: process.env.PORT ?? '7000', HOST: process.env.HOST ?? '127.0.0.1' });
const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info', format: 'pretty' });
const app = createApp({ config, logger });

const server = createServer(app.handler);
server.listen(config.port, config.host, () => {
  const origin = `http://localhost:${config.port}`;
  const demo = encodeConfig({ jimakuApiKey: 'demo-key-12345' });
  console.log(`
Jimaku Subs Sakura in demo mode: nothing here touches the real Jimaku.

  Setup page    ${origin}/configure
  Addon         ${origin}/${demo}/manifest.json
  Try it        curl '${origin}/${demo}/subtitles/series/kitsu:46474:2.json'
                curl '${origin}/${demo}/subtitles/movie/tt5311514.json'
                curl '${origin}/${demo}/subtitles/series/kitsu:46474:5.json'    (episode 5 is only inside ZIP files)

  Any API key of 8+ characters works, except one starting with "bad".
  Known demo titles: Frieren (kitsu:46474, tt22248376), Your Name. (tt5311514), Attack on Titan (tt2560140).
  Only inside ZIP files: Frieren episodes 4 to 6, and the film anilist:99106 (as a movie).
`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    app.close();
    server.close();
    await mock.close();
    process.exit(0);
  });
}
