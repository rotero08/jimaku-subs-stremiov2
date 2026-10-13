import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assToSrt, cleanEventText, formatTime, looksLikeAss, mergeRepeats, parseAss, parseTime } from '../src/subs/ass.js';

const HEADER = `[Script Info]
Title: Test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

describe('times', () => {
  it('reads H:MM:SS.cc and variants', () => {
    assert.equal(parseTime('0:00:01.50'), 1.5);
    assert.equal(parseTime('1:02:03.04'), 3723.04);
    assert.equal(parseTime('0:00:00.123'), 0.123);
    assert.equal(parseTime('0:00:07'), 7);
    assert.equal(parseTime('nonsense'), null);
  });

  it('writes SRT times with correct carrying', () => {
    assert.equal(formatTime(0), '00:00:00,000');
    assert.equal(formatTime(62.34), '00:01:02,340');
    assert.equal(formatTime(3725.9996), '01:02:06,000'); // rounds up across the second
    assert.equal(formatTime(-3), '00:00:00,000');
  });
});

describe('event text', () => {
  it('removes override tags and keeps the words', () => {
    assert.equal(cleanEventText('{\\an8\\pos(100,50)\\fad(100,100)}Hello'), 'Hello');
  });

  it('turns \\N into a line break and \\h into a space', () => {
    assert.equal(cleanEventText('one\\Ntwo\\hthree'), 'one\ntwo three');
  });

  it('keeps italics as <i> and closes them', () => {
    assert.equal(cleanEventText('{\\i1}whispered{\\i0} aloud'), '<i>whispered</i> aloud');
    assert.equal(cleanEventText('{\\i1}never closed'), '<i>never closed</i>');
  });

  it('drops vector drawings completely', () => {
    assert.equal(cleanEventText('{\\p1}m 0 0 l 100 0 100 100{\\p0}'), '');
    assert.equal(cleanEventText('before{\\p1}m 0 0 l 1 1{\\p0}after'), 'beforeafter');
  });

  it('flattens karaoke syllables into the line', () => {
    assert.equal(cleanEventText('{\\k20}こ{\\k30}ん{\\kf40}に{\\k20}ちは'), 'こんにちは');
  });

  it('trims and collapses spacing, keeping the ideographic space', () => {
    assert.equal(cleanEventText('  a   b  \\N   c  '), 'a b\nc');
    assert.equal(cleanEventText('あ\u3000い'), 'あ\u3000い');
  });
});

describe('parsing', () => {
  it('reads dialogue and keeps commas inside the text', () => {
    const events = parseAss(`${HEADER}Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Well, well, well.\n`);
    assert.deepEqual(events, [{ start: 1, end: 3, text: 'Well, well, well.', layer: 0 }]);
  });

  it('follows a different column order', () => {
    const file = `[Events]\nFormat: Start, End, Text, Style\nDialogue: 0:00:05.00,0:00:06.00,Hi there,Default\n`;
    // "Text" is not last here, so it must still be found by name.
    const [event] = parseAss(file);
    assert.equal(event.start, 5);
    assert.equal(event.text, 'Hi there');
  });

  it('uses the standard columns when there is no Format line', () => {
    const [event] = parseAss('[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Standard\n');
    assert.equal(event.text, 'Standard');
  });

  it('ignores comments, other sections, bad times and zero-length events', () => {
    const file = `${HEADER}Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,note
Dialogue: 0,bad,0:00:02.00,Default,,0,0,0,,x
Dialogue: 0,0:00:02.00,0:00:02.00,Default,,0,0,0,,instant
Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,kept
`;
    assert.deepEqual(parseAss(file).map((e) => e.text), ['kept']);
  });

  it('skips scrolling credits', () => {
    const file = `${HEADER}Dialogue: 0,0:00:01.00,0:00:09.00,Default,,0,0,0,Scroll up;0;400;5,Credits\n`;
    assert.deepEqual(parseAss(file), []);
  });

  it('handles Windows line ends and a byte-order mark', () => {
    const file = `\ufeff${HEADER.replace(/\n/g, '\r\n')}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi\r\n`;
    assert.equal(parseAss(file)[0].text, 'Hi');
  });
});

describe('merging effect repeats', () => {
  it('shows one line once, however many layers repeat it', () => {
    const file = `${HEADER}Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Same line
Dialogue: 1,0:00:01.00,0:00:03.00,Default,,0,0,0,,Same line
Dialogue: 2,0:00:01.00,0:00:03.00,Default,,0,0,0,,Same line
`;
    assert.equal(assToSrt(file), '1\n00:00:01,000 --> 00:00:03,000\nSame line\n');
  });

  it('joins karaoke slices that follow each other', () => {
    const merged = mergeRepeats([
      { start: 1, end: 1.5, text: 'La la', layer: 0 },
      { start: 1.5, end: 2, text: 'La la', layer: 0 },
      { start: 2, end: 2.5, text: 'La la', layer: 0 },
    ]);
    assert.deepEqual(merged, [{ start: 1, end: 2.5, text: 'La la', layer: 0 }]);
  });

  it('does not join the same words said again later', () => {
    const merged = mergeRepeats([
      { start: 1, end: 2, text: 'はい', layer: 0 },
      { start: 5, end: 6, text: 'はい', layer: 0 },
    ]);
    assert.equal(merged.length, 2);
  });

  it('keeps different lines that share a time', () => {
    const file = `${HEADER}Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}Top
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Bottom
`;
    assert.equal(assToSrt(file).match(/-->/g).length, 2);
  });
});

describe('whole files', () => {
  it('converts in order and numbers the cues', () => {
    const file = `${HEADER}Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,Second
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,First
`;
    assert.equal(
      assToSrt(file),
      '1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n2\n00:00:05,000 --> 00:00:06,000\nSecond\n',
    );
  });

  it('gives an empty string when nothing is left', () => {
    assert.equal(assToSrt(`${HEADER}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\p1}m 0 0 l 5 5\n`), '');
    assert.equal(assToSrt('not a subtitle file'), '');
  });

  it('recognises an ASS file by its content', () => {
    assert.ok(looksLikeAss(HEADER));
    assert.ok(looksLikeAss('\ufeff[Script Info]\nTitle: x'));
    assert.ok(!looksLikeAss('1\n00:00:01,000 --> 00:00:02,000\nHi\n'));
  });
});
