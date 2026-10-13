#!/usr/bin/env node
// Announce a deployed addon to Stremio's community catalogue:
//   npm run publish-to-stremio -- https://your-addon.example/manifest.json
//
// It is a separate step (the first version did it on every start in production, which put every
// self-hosted copy in the public list) and uses the address you give it, never a built-in one.

import { publishToCentral } from '../src/stremio/publish.js';

const url = process.argv[2];
if (!url || !/^https:\/\/.+\/manifest\.json$/.test(url)) {
  console.error('Usage: npm run publish-to-stremio -- https://your-addon.example/manifest.json');
  console.error('Use the unconfigured manifest address (no settings in the path): everyone installs from it.');
  process.exit(2);
}
try {
  await publishToCentral(url);
  console.log(`Published ${url}`);
} catch (error) {
  console.error(`Could not publish: ${error.message}`);
  process.exit(1);
}
