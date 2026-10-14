// Reading ZIP archives with no dependency: list the files in one, and extract one of them.
//
// A ZIP file ends with a directory that says where every file starts and how it is packed, so the
// reader looks at the end first and then asks only for what it needs. That is why it works on a
// "source" that can be read in pieces (a Buffer, or an HTTP Range request) rather than on a whole
// file in memory: a season of subtitles may sit in an archive that also holds fonts.
//
// Archives come from strangers, so nothing is trusted: sizes are checked before anything is
// allocated or inflated, counts are capped, and whatever this does not support (ZIP64, split
// archives, encryption, methods other than stored and deflate) is reported, never guessed at.

import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  /** @param {'not-zip' | 'unsupported' | 'corrupt' | 'too-large'} code */
  constructor(message, code = 'corrupt') {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

const SIGNATURE = { end: 0x06054b50, central: 0x02014b50, local: 0x04034b50 };
const END_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;

/** How much of the end of a file to read first: the end record (22 bytes plus a comment) and, usually, the whole directory. */
export const TAIL_BYTES = 128 * 1024;

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

/**
 * A source is `{ size, read(start, end) }` where `read` resolves to the bytes from `start` up to
 * (not including) `end`, or fewer when the file ends first.
 * @param {Buffer} buffer
 */
export const memorySource = (buffer) => ({
  size: buffer.length,
  read: async (start, end) => buffer.subarray(Math.max(0, start), Math.min(end, buffer.length)),
});

// ---------------------------------------------------------------------------------------------
// Checksums and names
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32 as ZIP files use it. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const looseUtf8 = new TextDecoder('utf-8');
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const strictShiftJis = new TextDecoder('shift_jis', { fatal: true });

/** The UTF-8 name an "Info-ZIP Unicode Path" extra field carries, if it belongs to this name. */
function unicodePathOf(extra, rawName) {
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (at + 4 + length > extra.length) break;
    if (id === 0x7075 && length >= 5 && extra[at + 4] === 1 && extra.readUInt32LE(at + 5) === crc32(rawName)) {
      return looseUtf8.decode(extra.subarray(at + 9, at + 4 + length));
    }
    at += 4 + length;
  }
  return null;
}

/**
 * Names are UTF-8 when the archive says so. Otherwise they are in whatever the author's computer
 * used: on a Japanese Windows that is Shift-JIS, on a Mac or Linux usually UTF-8 without the flag.
 */
function decodeName(raw, flags, unicodePath) {
  let text;
  if (flags & 0x800) text = looseUtf8.decode(raw);
  else if (unicodePath) text = unicodePath;
  else if (raw.every((byte) => byte < 0x80)) text = raw.toString('latin1');
  else {
    try {
      text = strictUtf8.decode(raw);
    } catch {
      try {
        text = strictShiftJis.decode(raw);
      } catch {
        text = raw.toString('latin1');
      }
    }
  }
  // Some Windows tools write "\" between folders. This runs after decoding, because in Shift-JIS a
  // second byte of 0x5C is part of a character (表, ソ), not a separator.
  return text.replace(/\\/g, '/').replace(/\p{Cc}/gu, '').replace(/^(?:\.?\/)+/, '');
}

// ---------------------------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} ZipEntry
 * @property {number} index
 * @property {string} path            folders separated by "/"
 * @property {boolean} directory
 * @property {boolean} encrypted
 * @property {boolean} zip64          sizes or offset too large for this reader
 * @property {number} method          0 stored, 8 deflate
 * @property {number} size            uncompressed
 * @property {number} compressedSize
 * @property {number} crc32
 * @property {number} offset          where its local header starts
 * @property {number} headerBytes     length of its name and extra data in the directory
 */

/**
 * Lists the files of an archive.
 * @param {{ size: number, read: (start: number, end: number) => Promise<Buffer> }} source
 * @returns {Promise<ZipEntry[]>}
 */
export async function readDirectory(source, { maxEntries = 20_000, maxDirectoryBytes = 4 * 1024 * 1024 } = {}) {
  const { size } = source;
  if (size < END_SIZE) throw new ZipError('that is too small to be a ZIP file', 'not-zip');

  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = await source.read(tailStart, size);

  // The end record is the last thing in the file, followed only by its comment, which may itself
  // hold bytes that look like an end record: so one whose comment runs exactly to the end of the
  // file is preferred, and one with something after its comment is a last resort.
  const findEnd = (exact) => {
    for (let i = tail.length - END_SIZE; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== SIGNATURE.end) continue;
      const after = tail.length - (i + END_SIZE);
      const comment = tail.readUInt16LE(i + 20);
      if (exact ? comment === after : comment <= after) return i;
    }
    return -1;
  };
  let at = findEnd(true);
  if (at < 0) at = findEnd(false);
  if (at < 0) throw new ZipError('that is not a ZIP file (no directory at its end)', 'not-zip');

  const disk = tail.readUInt16LE(at + 4);
  const directoryDisk = tail.readUInt16LE(at + 6);
  const onThisDisk = tail.readUInt16LE(at + 8);
  const total = tail.readUInt16LE(at + 10);
  const directorySize = tail.readUInt32LE(at + 12);
  const directoryOffset = tail.readUInt32LE(at + 16);

  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported', 'unsupported');
  if (disk !== 0 || directoryDisk !== 0 || onThisDisk !== total) throw new ZipError('split archives are not supported', 'unsupported');
  if (total > maxEntries) throw new ZipError(`the archive holds more than ${maxEntries} files`, 'too-large');
  if (directorySize > maxDirectoryBytes) throw new ZipError('the archive directory is too large', 'too-large');
  if (total === 0) return [];

  // The directory normally ends where the end record begins. Something written in front of the
  // archive (a self-extracting stub) shifts every offset by the same amount.
  let directory = null;
  let shift = 0;
  for (const candidate of [directoryOffset, tailStart + at - directorySize]) {
    if (candidate < directoryOffset || candidate + directorySize > size) continue; // a stub only ever pushes it later
    const bytes = candidate >= tailStart ? tail.subarray(candidate - tailStart, candidate - tailStart + directorySize) : await source.read(candidate, candidate + directorySize);
    if (bytes.length === directorySize && directorySize >= 4 && bytes.readUInt32LE(0) === SIGNATURE.central) {
      directory = bytes;
      shift = candidate - directoryOffset;
      break;
    }
  }
  if (!directory) throw new ZipError('the archive directory is damaged');

  const entries = [];
  let cursor = 0;
  for (let index = 0; index < total; index++) {
    if (cursor + CENTRAL_SIZE > directory.length || directory.readUInt32LE(cursor) !== SIGNATURE.central) throw new ZipError('the archive directory is damaged');
    const flags = directory.readUInt16LE(cursor + 8);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const next = cursor + CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (next > directory.length) throw new ZipError('the archive directory is damaged');

    const rawName = directory.subarray(cursor + CENTRAL_SIZE, cursor + CENTRAL_SIZE + nameLength);
    const extra = directory.subarray(cursor + CENTRAL_SIZE + nameLength, cursor + CENTRAL_SIZE + nameLength + extraLength);
    const path = decodeName(rawName, flags, unicodePathOf(extra, rawName));
    const compressedSize = directory.readUInt32LE(cursor + 20);
    const uncompressedSize = directory.readUInt32LE(cursor + 24);
    const offset = directory.readUInt32LE(cursor + 42);

    entries.push({
      index,
      path,
      directory: path === '' || path.endsWith('/'),
      encrypted: Boolean(flags & 0x41), // bit 0 password, bit 6 strong encryption
      zip64: compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || offset === 0xffffffff,
      method: directory.readUInt16LE(cursor + 10),
      size: uncompressedSize,
      compressedSize,
      crc32: directory.readUInt32LE(cursor + 16),
      offset: offset + shift,
      headerBytes: nameLength + extraLength,
    });
    cursor = next;
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------------------------

/**
 * The contents of one file of an archive.
 * @param {{ size: number, read: (start: number, end: number) => Promise<Buffer> }} source
 * @param {ZipEntry} entry
 * @param {{ maxBytes?: number }} [limits]   the most the file may hold, packed or not
 */
export async function extract(source, entry, { maxBytes = 4 * 1024 * 1024 } = {}) {
  if (entry.directory) throw new ZipError('that is a folder, not a file', 'unsupported');
  if (entry.encrypted) throw new ZipError('that file is password protected', 'unsupported');
  if (entry.zip64) throw new ZipError('ZIP64 files are not supported', 'unsupported');
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError(`compression method ${entry.method} is not supported`, 'unsupported');
  // Both numbers come from the archive, so they are checked before anything is read or allocated.
  if (entry.size > maxBytes || entry.compressedSize > maxBytes + 1024) throw new ZipError('that file is too large', 'too-large');
  if (entry.size === 0) return Buffer.alloc(0);

  // The copy of the name and extra data in the file's own header may differ in length from the
  // directory's, so ask for some slack and fetch again in the unusual case that it was not enough.
  let block = await source.read(entry.offset, entry.offset + LOCAL_SIZE + entry.headerBytes + 1024 + entry.compressedSize);
  if (block.length < LOCAL_SIZE || block.readUInt32LE(0) !== SIGNATURE.local) throw new ZipError('the file header is damaged');
  const dataStart = LOCAL_SIZE + block.readUInt16LE(26) + block.readUInt16LE(28);
  if (block.length < dataStart + entry.compressedSize) block = await source.read(entry.offset, entry.offset + dataStart + entry.compressedSize);
  if (block.length < dataStart + entry.compressedSize) throw new ZipError('the archive ends in the middle of a file');

  const packed = block.subarray(dataStart, dataStart + entry.compressedSize);
  let data;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw new ZipError('a stored file whose sizes disagree');
    data = packed;
  } else {
    try {
      // The limit stops an archive that lies about its size from filling memory.
      data = inflateRawSync(packed, { maxOutputLength: entry.size });
    } catch {
      throw new ZipError('the file could not be decompressed');
    }
  }
  if (data.length !== entry.size) throw new ZipError('the file is not the size the archive says');
  if (entry.crc32 !== 0 && crc32(data) !== entry.crc32) throw new ZipError('the file failed its checksum');
  return data;
}
