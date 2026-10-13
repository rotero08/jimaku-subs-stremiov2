#!/usr/bin/env node
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { publishToCentral } from './stremio/publish.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, format: config.logFormat });
const app = createApp({ config, logger });

const server = createServer(app.handler);
// Stremio and the proxies in front of it hold connections open between requests.
server.keepAliveTimeout = 65_000;
server.requestTimeout = 30_000;

server.listen(config.port, config.host, () => {
  const where = config.baseUrl ?? `http://localhost:${config.port}`;
  logger.info('addon running', { version: config.version, setup: `${where}/configure`, mode: config.serverKey ? 'server key' : 'per-user keys' });

  if (config.publishToCentral) {
    if (!config.baseUrl) logger.warn('PUBLISH_TO_CENTRAL is set but BASE_URL is not, so there is nothing to announce');
    else {
      publishToCentral(`${config.baseUrl}/manifest.json`)
        .then(() => logger.info('published to the Stremio community catalogue'))
        .catch((error) => logger.warn('could not publish to Stremio', { error: error.message }));
    }
  }
});

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info('shutting down', { signal });
  app.close();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
