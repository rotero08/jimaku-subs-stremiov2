import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeSubtitle } from '../src/subs/encoding.js';

const JP = 'こんにちは、世界。今日はいい天気ですね。字幕のテストです。';

describe('decodeSubtitle', () => {
  it('reads plain UTF-8', () => {
    assert.deepEqual(decodeSubtitle(Buffer.from(JP, 'utf8')), { text: JP, encoding: 'utf-8' });
  });

  it('strips a UTF-8 byte-order mark', () => {
    const { text } = decodeSubtitle(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JP)]));
    assert.equal(text, JP);
  });

  it('reads UTF-16 in both byte orders from the mark', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JP, 'utf16le')]);
    assert.equal(decodeSubtitle(le).text, JP);
    const be = Buffer.from(Buffer.from(JP, 'utf16le').swap16());
    assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).text, JP);
  });

  it('detects Shift-JIS, which is not valid UTF-8', () => {
    const bytes = Buffer.from([
      0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd, 0x81, 0x41, 0x90, 0xa2, 0x8a, 0x45, 0x81, 0x42,
    ]); // こんにちは、世界。
    const { text, encoding } = decodeSubtitle(bytes);
    assert.equal(text, 'こんにちは、世界。');
    assert.equal(encoding, 'shift_jis');
  });

  it('detects EUC-JP', () => {
    const bytes = Buffer.from([0xa4, 0xb3, 0xa4, 0xf3, 0xa4, 0xcb, 0xa4, 0xc1, 0xa4, 0xcf, 0xa1, 0xa2, 0xc0, 0xa4, 0xb3, 0xa6, 0xa1, 0xa3]); // こんにちは、世界。
    const { text, encoding } = decodeSubtitle(bytes);
    assert.equal(text, 'こんにちは、世界。');
    assert.equal(encoding, 'euc-jp');
  });

  it('copes with empty input', () => {
    assert.equal(decodeSubtitle(Buffer.alloc(0)).text, '');
  });
});
