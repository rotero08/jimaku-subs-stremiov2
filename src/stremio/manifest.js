import { ID_PREFIXES, TYPES } from './ids.js';
import { configTag } from './userConfig.js';

export const ADDON_ID = 'community.jimakusub.v2';

/**
 * @param {object} options
 * @param {string} options.version
 * @param {string} options.baseUrl    public address of this server, no trailing slash
 * @param {string} [options.config]   the user's config path segment, when there is one
 * @param {boolean} options.ready     can it serve subtitles as installed (a user key or a server key)?
 */
export function buildManifest({ version, baseUrl, config, ready }) {
  return {
    // The id of an installed copy depends on its settings, as in the first version, so addons
    // installed back then keep matching their stored manifest.
    id: config ? `${ADDON_ID}.${configTag(config)}` : ADDON_ID,
    version,
    name: 'Jimaku Subtitles',
    description:
      'Japanese subtitles for anime and Japanese media from the Jimaku.cc community. ' +
      'Works with Kitsu, MAL, AniList and IMDb-based catalogs; ASS subtitles can be converted to SRT.',
    logo: `${baseUrl}/logo.png`,
    icon: `${baseUrl}/icon.png`,
    resources: ['subtitles'],
    types: TYPES,
    idPrefixes: ID_PREFIXES,
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: !ready,
    },
    // Registration with the Stremio Addons community list (stremio-addons.net).
    stremioAddonsConfig: {
      issuer: 'https://stremio-addons.net',
      signature:
        'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0.._lqf7gOkdIFimbAlTD8g7Q.eVQYjktZnC1FWlOybUQqJR3-AX2DfU4HtCWiVSN6ZqzE_e9wBkPbtynEQ9Xhxl6bj6Jj38Sc2-RTRfdRyrm2w9w128IzJvKE6LIouFhSO1qXB6_mH5uMPy1TzMduOLsh.C1khxFtQh5Y38gfAEa11_A',
    },
  };
}
