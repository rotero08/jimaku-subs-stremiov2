// The setup page builds the addon's address; the server reads it. They must agree.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decode, encode, validKey } from '../public/codec.js';
import { decodeConfig, encodeConfig } from '../src/stremio/userConfig.js';

const KEYS = ['abcdefgh', 'Aa1_-.~!#$%&()*+,/:;<=>?@[]^`{|}', 'x'.repeat(256), 'plain-ASCII-key-123'];
const SETTINGS = [
  {},
  { assMode: 'both' },
  { assMode: 'ass', maxSubtitles: 3 },
  { maxSubtitles: 20 },
];

describe('the page and the server agree on the address', () => {
  it('the server reads what the page writes', () => {
    for (const jimakuApiKey of KEYS) {
      for (const extra of SETTINGS) {
        const settings = { jimakuApiKey, assMode: 'srt', maxSubtitles: 10, ...extra };
        assert.deepEqual(decodeConfig(encode(settings)), settings, JSON.stringify(settings).slice(0, 80));
      }
    }
  });

  it('the page reads what the server writes', () => {
    for (const jimakuApiKey of KEYS) {
      for (const extra of SETTINGS) {
        const settings = { jimakuApiKey, assMode: 'srt', maxSubtitles: 10, ...extra };
        assert.deepEqual(decode(encodeConfig(settings)), settings);
      }
    }
  });

  it('write the very same address', () => {
    for (const jimakuApiKey of KEYS) {
      for (const extra of SETTINGS) {
        const settings = { jimakuApiKey, ...extra };
        assert.equal(encode({ assMode: 'srt', maxSubtitles: 10, ...settings }), encodeConfig(settings));
      }
    }
  });

  it('use only characters that are safe in a path', () => {
    for (const jimakuApiKey of KEYS) assert.match(encode({ jimakuApiKey, assMode: 'both', maxSubtitles: 10 }), /^[A-Za-z0-9_-]+$/);
  });

  it('accept the same keys', () => {
    const samples = ['', 'short', 'sevench', 'eightchr', 'with space1', 'tab\there12', 'x'.repeat(256), 'x'.repeat(257), 'ключ-ключ-ключ', 'ok-key_1234.~', 'new\nline-12345'];
    for (const key of samples) {
      assert.equal(validKey(key), decodeConfig(encodeConfig({ jimakuApiKey: key })) !== null, JSON.stringify(key));
    }
  });

  it('the page gives up quietly on an address it cannot read', () => {
    for (const bad of ['', '%', '!!!', 'bm90IGpzb24', Buffer.from('{"other":1}').toString('base64url')]) assert.equal(decode(bad), null, bad);
  });
});
