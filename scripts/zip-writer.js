// A small ZIP writer, for the tests and for the pretend Jimaku's archives.
//
// Besides ordinary archives it can write the odd ones a reader has to survive: names in Shift-JIS
// without the UTF-8 flag, an Info-ZIP "Unicode path", sizes after the data (a data descriptor),
// a comment, a stub in front of the archive, a local header with more extra data than the
// directory's, and entries whose checksum or size is wrong.

import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../src/subs/zip.js';

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

/** One extra-data field, as a header carries them: an id, a length and the data. */
export const extraField = (id, data) => Buffer.concat([u16(id), u16(data.length), data]);

/** An Info-ZIP "Unicode Path" extra field: the real name in UTF-8, tied to the header name by its CRC. */
function unicodePathField(headerName, unicodeName) {
  const name = Buffer.from(unicodeName, 'utf8');
  return Buffer.concat([u16(0x7075), u16(5 + name.length), Buffer.from([1]), u32(crc32(headerName)), name]);
}

/**
 * @typedef {object} ZipFile
 * @property {string | Buffer} name          a string is written as UTF-8 (flagged when it is not ASCII); a Buffer is written as is
 * @property {string | Buffer} [data]
 * @property {boolean} [store]               no compression
 * @property {boolean} [descriptor]          sizes and checksum after the data, as streaming writers do
 * @property {boolean} [encrypted]           sets the flag only; the data is not encrypted
 * @property {string} [unicodeName]          adds a Unicode Path field carrying this name
 * @property {number} [method]               to claim a method this reader does not know
 * @property {Buffer} [packed]               the bytes to write as the file's data, whatever the method says
 * @property {number} [crc]                  to write a wrong checksum
 * @property {number} [size]                 to write a wrong uncompressed size
 * @property {Buffer} [localExtra]           extra data in the file's own header only
 */

/**
 * @param {ZipFile[]} files
 * @param {{ comment?: string, prefix?: Buffer }} [options]
 * @returns {Buffer}
 */
export function makeZip(files, { comment = '', prefix = Buffer.alloc(0) } = {}) {
  const parts = [prefix];
  let offset = prefix.length;
  const directory = [];

  for (const file of files) {
    const nameBytes = Buffer.isBuffer(file.name) ? file.name : Buffer.from(file.name, 'utf8');
    const flagged = typeof file.name === 'string' && /\P{ASCII}/u.test(file.name);
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data ?? '', 'utf8');
    const method = file.method ?? (file.store || data.length === 0 ? 0 : 8);
    const packed = file.packed ?? (method === 8 ? deflateRawSync(data) : data);
    const crc = file.crc ?? crc32(data);
    const size = file.size ?? data.length;
    const flags = (flagged ? 0x800 : 0) | (file.descriptor ? 8 : 0) | (file.encrypted ? 1 : 0);
    const extra = file.unicodeName ? unicodePathField(nameBytes, file.unicodeName) : Buffer.alloc(0);
    const localExtra = Buffer.concat([extra, file.localExtra ?? Buffer.alloc(0)]);
    const time = u16(0x6000);
    const date = u16(((2024 - 1980) << 9) | (1 << 5) | 1);

    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), time, date,
      u32(file.descriptor ? 0 : crc), u32(file.descriptor ? 0 : packed.length), u32(file.descriptor ? 0 : size),
      u16(nameBytes.length), u16(localExtra.length), nameBytes, localExtra,
    ]);
    const descriptor = file.descriptor ? Buffer.concat([u32(0x08074b50), u32(crc), u32(packed.length), u32(size)]) : Buffer.alloc(0);
    parts.push(local, packed, descriptor);

    directory.push(
      Buffer.concat([
        u32(0x02014b50), u16(0x031e), u16(20), u16(flags), u16(method), time, date,
        u32(crc), u32(packed.length), u32(size),
        u16(nameBytes.length), u16(extra.length), u16(0), u16(0), u16(0),
        u32(typeof file.name === 'string' && file.name.endsWith('/') ? 0x10 : 0),
        u32(offset - prefix.length), nameBytes, extra,
      ]),
    );
    offset += local.length + packed.length + descriptor.length;
  }

  const central = Buffer.concat(directory);
  const note = Buffer.from(comment, 'utf8');
  parts.push(
    central,
    Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(central.length), u32(offset - prefix.length), u16(note.length), note]),
  );
  return Buffer.concat(parts);
}
