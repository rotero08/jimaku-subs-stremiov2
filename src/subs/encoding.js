// Subtitle files come in whatever encoding their author's editor used. Japanese ones are often
// Shift-JIS, sometimes UTF-16; Stremio expects UTF-8, so files are decoded here and served as UTF-8.

const CANDIDATES = ['shift_jis', 'euc-jp', 'gb18030', 'big5', 'euc-kr', 'windows-1252'];

function decode(label, bytes, fatal = false) {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * How plausible a decoding is as Japanese. The same bytes decode to *some* valid text in several
 * encodings, so counting ideographs is not enough: wrong guesses produce rare kanji and half-width
 * katakana, while real Japanese is full of hiragana and katakana.
 */
function plausibility(text) {
  const count = (pattern) => (text.match(pattern) ?? []).length;
  const kana = count(/[\u3041-\u3096\u30a1-\u30fa\u30fc]/g);
  const kanji = count(/[\u4e00-\u9fff]/g);
  const punctuation = count(/[\u3001\u3002\u300c\u300d\u300e\u300f\uff01\uff1f]/g);
  const halfwidthKatakana = count(/[\uff61-\uff9f]/g); // almost always mojibake in a subtitle
  const broken = count(/\ufffd/g);
  const structure = /Dialogue:|-->|\[Script Info\]/.test(text) ? 5 : 0;
  return kana * 3 + kanji + punctuation - halfwidthKatakana * 2 - broken * 10 + structure;
}

/**
 * Turns the bytes of a subtitle file into text.
 * @param {Uint8Array} bytes
 * @returns {{ text: string, encoding: string }}
 */
export function decodeSubtitle(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decode('utf-8', bytes.subarray(3)), encoding: 'utf-8' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decode('utf-16le', bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decode('utf-16be', bytes.subarray(2)), encoding: 'utf-16be' };
  }
  const utf8 = decode('utf-8', bytes, true);
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8' };

  let best = { text: decode('utf-8', bytes) ?? '', encoding: 'utf-8', score: -Infinity };
  for (const label of CANDIDATES) {
    const text = decode(label, bytes);
    if (text === null) continue;
    const score = plausibility(text);
    if (score > best.score) best = { text, encoding: label, score };
  }
  return { text: best.text, encoding: best.encoding };
}
