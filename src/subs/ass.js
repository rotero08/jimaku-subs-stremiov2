// ASS/SSA subtitles to SRT.
//
// ASS is a typesetting format: styled text, positions, karaoke timing, vector drawings. SRT is
// plain timed text. A good conversion keeps the words, the line breaks and italics, and drops
// everything that is not text, including the many near-duplicate events that effects produce.

const DEFAULT_FORMAT = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

/** "0:01:02.34" -> 62.34 (seconds). */
export function parseTime(stamp) {
  const match = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?\s*$/.exec(stamp);
  if (!match) return null;
  const [, h, m, s, fraction = ''] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + (fraction ? Number(`0.${fraction}`) : 0);
}

/** 62.34 -> "00:01:02,340". Rounded to milliseconds, carrying correctly. */
export function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secs = Math.floor((total % 60_000) / 1000);
  const ms = total % 1000;
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(ms, 3)}`;
}

/** The visible text of one event: tags removed, line breaks kept, italics kept as <i>. */
export function cleanEventText(raw) {
  let out = '';
  let italic = false;
  let drawing = false;

  const setItalic = (on) => {
    if (on === italic) return;
    out += on ? '<i>' : '</i>';
    italic = on;
  };

  // Walk the text as alternating plain stretches and {override blocks}.
  const parts = raw.split(/(\{[^{}]*\})/);
  for (const part of parts) {
    if (part.startsWith('{') && part.endsWith('}')) {
      for (const tag of part.slice(1, -1).split('\\').slice(1)) {
        const italicTag = /^i(\d?)/.exec(tag);
        if (italicTag) setItalic(italicTag[1] === '1');
        const drawingTag = /^p(\d+)/.exec(tag);
        if (drawingTag) drawing = Number(drawingTag[1]) > 0; // \p1 starts vector drawing commands
      }
      continue;
    }
    if (drawing) continue;
    out += part.replace(/\\N/g, '\n').replace(/\\n/g, ' ').replace(/\\h/g, ' ');
  }
  setItalic(false);

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t\u3000]+/g, (gap) => (gap.includes('\u3000') ? '\u3000' : ' ')).trim())
    .filter(Boolean)
    .join('\n');
}

/** Splits "a,b,c,text, with, commas" into at most `count` fields; the last one keeps its commas. */
function splitFields(payload, count) {
  const fields = [];
  let from = 0;
  for (let i = 0; i < count - 1; i++) {
    const comma = payload.indexOf(',', from);
    if (comma < 0) break;
    fields.push(payload.slice(from, comma));
    from = comma + 1;
  }
  fields.push(payload.slice(from));
  return fields;
}

/**
 * @param {string} text
 * @returns {{ start: number, end: number, text: string, layer: number }[]}
 */
export function parseAss(text) {
  const events = [];
  let section = '';
  let format = DEFAULT_FORMAT;

  for (const line of text.replace(/^\ufeff/, '').split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      section = trimmed.slice(1, -1).toLowerCase();
      continue;
    }
    if (section !== 'events') continue;

    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const kind = trimmed.slice(0, colon).toLowerCase();
    const payload = trimmed.slice(colon + 1).replace(/^\s/, '');

    if (kind === 'format') {
      format = payload.split(',').map((name) => name.trim().toLowerCase());
      continue;
    }
    if (kind !== 'dialogue') continue;

    const fields = splitFields(payload, format.length);
    const get = (name) => fields[format.indexOf(name)] ?? '';
    const start = parseTime(get('start'));
    const end = parseTime(get('end'));
    if (start === null || end === null || end <= start) continue;
    // Credits and banners that scroll across the screen are effects, not subtitles.
    if (/^(scroll|banner)/i.test(get('effect').trim())) continue;

    const cleaned = cleanEventText(get('text'));
    if (cleaned) events.push({ start, end, text: cleaned, layer: Number.parseInt(get('layer'), 10) || 0 });
  }
  return events;
}

/** Effects repeat one line as many events (outlines, shadows, karaoke); show it once. */
export function mergeRepeats(events, tolerance = 0.05) {
  const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end || a.layer - b.layer);
  const merged = [];
  for (const event of sorted) {
    const same = merged.findLast((m) => m.text === event.text && event.start <= m.end + tolerance);
    if (same) same.end = Math.max(same.end, event.end);
    else merged.push({ ...event });
  }
  return merged.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Converts an ASS/SSA file's text to SRT. Returns "" when it holds no subtitles. */
export function assToSrt(text) {
  const events = mergeRepeats(parseAss(text));
  return events
    .map((e, i) => `${i + 1}\n${formatTime(e.start)} --> ${formatTime(e.end)}\n${e.text}\n`)
    .join('\n');
}

/** Does this text look like an ASS/SSA file, whatever it is called? */
export function looksLikeAss(text) {
  return /^\s*\ufeff?\[(script info|v4\+? styles|events)\]/im.test(text.slice(0, 2000));
}
