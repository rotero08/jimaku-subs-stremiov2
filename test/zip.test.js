import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { extraField, makeZip } from '../scripts/zip-writer.js';
import { crc32, extract, memorySource, readDirectory, TAIL_BYTES, ZipError } from '../src/subs/zip.js';
import { REAL_ZIP_FILES, REAL_ZIPS } from './fixtures/real-zips.js';

/** A source that remembers what was asked of it. */
function counting(buffer) {
  const inner = memorySource(buffer);
  const reads = [];
  return {
    size: inner.size,
    reads,
    bytes: () => reads.reduce((total, [start, end]) => total + Math.min(end, buffer.length) - start, 0),
    read: (start, end) => (reads.push([start, end]), inner.read(start, end)),
  };
}

const list = async (buffer, limits) => readDirectory(memorySource(buffer), limits);
const text = async (buffer, path) => {
  const source = memorySource(buffer);
  const entry = (await readDirectory(source)).find((e) => e.path === path);
  return (await extract(source, entry)).toString('utf8');
};
const failsWith = (promise, code) => assert.rejects(promise, (error) => error instanceof ZipError && error.code === code, `expected a ZipError "${code}"`);

// "フリーレン.ass" as a Japanese Windows writes it into a ZIP: Shift-JIS, and no UTF-8 flag.
const SJIS_NAME = Buffer.from([0x83, 0x74, 0x83, 0x8a, 0x81, 0x5b, 0x83, 0x8c, 0x83, 0x93, 0x2e, 0x61, 0x73, 0x73]);

describe('crc32', () => {
  it('matches the standard check value', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    assert.equal(crc32(Buffer.alloc(0)), 0);
  });
});

describe('archives made by real tools', () => {
  for (const [tool, buffer] of Object.entries(REAL_ZIPS)) {
    it(`reads what ${tool} wrote`, async () => {
      const source = memorySource(buffer);
      const entries = await readDirectory(source);
      const files = entries.filter((e) => !e.directory);
      assert.deepEqual(files.map((e) => e.path).sort(), Object.keys(REAL_ZIP_FILES).sort());
      for (const entry of files) assert.equal((await extract(source, entry)).toString('utf8'), REAL_ZIP_FILES[entry.path], entry.path);
      assert.ok(entries.every((e) => !e.encrypted && !e.zip64));
    });
  }
});

describe('listing an archive', () => {
  it('lists files and folders, stored and deflated, with their sizes', async () => {
    const zip = makeZip([
      { name: 'folder/', data: '' },
      { name: 'folder/a.srt', data: 'hello hello hello hello hello hello' },
      { name: 'b.txt', data: 'stored', store: true },
    ]);
    const entries = await list(zip);
    assert.deepEqual(entries.map((e) => [e.path, e.directory, e.method, e.size]), [
      ['folder/', true, 0, 0],
      ['folder/a.srt', false, 8, 35],
      ['b.txt', false, 0, 6],
    ]);
    assert.equal(await text(zip, 'folder/a.srt'), 'hello hello hello hello hello hello');
    assert.equal(await text(zip, 'b.txt'), 'stored');
  });

  it('knows an empty archive, and an empty file', async () => {
    assert.deepEqual(await list(makeZip([])), []);
    assert.equal(await text(makeZip([{ name: 'empty.srt', data: '' }]), 'empty.srt'), '');
  });

  it('reads UTF-8 names, with or without Japanese', async () => {
    const zip = makeZip([{ name: '字幕/[Group] フリーレン - 05.ass', data: 'x' }, { name: 'plain.ass', data: 'y' }]);
    assert.deepEqual((await list(zip)).map((e) => e.path), ['字幕/[Group] フリーレン - 05.ass', 'plain.ass']);
  });

  it('reads Shift-JIS names that carry no flag, as Japanese Windows writes them', async () => {
    const zip = makeZip([{ name: SJIS_NAME, data: 'x' }, { name: Buffer.concat([Buffer.from('dir/'), SJIS_NAME]), data: 'y' }]);
    assert.deepEqual((await list(zip)).map((e) => e.path), ['フリーレン.ass', 'dir/フリーレン.ass']);
  });

  it('reads UTF-8 names that carry no flag, as most Macs and Linux tools write them', async () => {
    const zip = makeZip([{ name: Buffer.from('字幕/第05話.srt'), data: 'x' }]);
    assert.deepEqual((await list(zip)).map((e) => e.path), ['字幕/第05話.srt']);
  });

  it('prefers an Info-ZIP Unicode Path over the name in the header', async () => {
    const zip = makeZip([{ name: Buffer.from('?.ass'), unicodeName: 'フリーレン.ass', data: 'x' }]);
    assert.deepEqual((await list(zip)).map((e) => e.path), ['フリーレン.ass']);
  });

  it('turns "\\" into "/", drops a leading "./", and treats an empty name as a folder', async () => {
    const zip = makeZip([{ name: Buffer.from('dir\\sub\\a.srt'), data: 'x' }, { name: './b.srt', data: 'y' }, { name: './', data: '' }]);
    const entries = await list(zip);
    assert.deepEqual(entries.map((e) => [e.path, e.directory]), [['dir/sub/a.srt', false], ['b.srt', false], ['', true]]);
  });

  it('strips control characters from names', async () => {
    const zip = makeZip([{ name: Buffer.from('a\u0000b\nc.srt'), data: 'x' }]);
    assert.deepEqual((await list(zip)).map((e) => e.path), ['abc.srt']);
  });

  it('finds the directory past an archive comment, even one that looks like an end record', async () => {
    assert.equal((await list(makeZip([{ name: 'a.txt', data: 'x' }], { comment: 'made by hand' }))).length, 1);
    const tricky = makeZip([{ name: 'a.txt', data: 'x' }], { comment: `PK\u0005\u0006${'\u0000'.repeat(18)}fake` });
    assert.deepEqual((await list(tricky)).map((e) => e.path), ['a.txt']);
    const longest = makeZip([{ name: 'a.txt', data: 'x' }], { comment: 'c'.repeat(65535) });
    assert.equal((await list(longest)).length, 1);
  });

  it('follows offsets through a stub written in front (a self-extracting archive)', async () => {
    const zip = makeZip([{ name: 'a.txt', data: 'hello' }], { prefix: Buffer.from('MZ stub '.repeat(100)) });
    assert.equal(await text(zip, 'a.txt'), 'hello');
  });

  it('reads a directory bigger than the piece taken from the end first', async () => {
    const files = Array.from({ length: 2500 }, (_, i) => ({ name: `Season 1/[SubsPlease] A Rather Long Show Title - ${String(i).padStart(4, '0')} (1080p) [ABCD1234].ass`, data: `line ${i}` }));
    const zip = makeZip(files);
    const source = counting(zip);
    const entries = await readDirectory(source);
    assert.equal(entries.length, 2500);
    assert.ok(source.reads.length >= 2, 'the end first, then the whole directory');
    assert.equal(await text(zip, files[1234].name), 'line 1234');
  });

  it('reads only the end of a large archive, and one file of it', async () => {
    const zip = makeZip([
      { name: 'wanted.srt', data: 'the one file we want\n'.repeat(50) },
      { name: 'Fonts/big.otf', data: Buffer.alloc(3 * 1024 * 1024, 5), store: true },
      { name: 'other.srt', data: 'not wanted' },
    ]);
    const source = counting(zip);
    const entries = await readDirectory(source);
    assert.equal(source.bytes(), TAIL_BYTES, `the directory costs ${source.bytes()} bytes, not the ${zip.length} of the archive`);
    const before = source.bytes();
    const data = await extract(source, entries.find((e) => e.path === 'wanted.srt'));
    assert.match(data.toString(), /^the one file we want/);
    assert.ok(source.bytes() - before < 4096, `one small file costs ${source.bytes() - before} bytes`);
  });

  it('extracts a file whose own header carries more extra data than the directory says', async () => {
    const small = makeZip([{ name: 'a.txt', data: 'hello world', localExtra: extraField(0xcafe, Buffer.alloc(100)) }]);
    const big = makeZip([{ name: 'a.txt', data: 'hello world', localExtra: extraField(0xcafe, Buffer.alloc(5000)) }]);
    assert.equal(await text(small, 'a.txt'), 'hello world');
    assert.equal(await text(big, 'a.txt'), 'hello world');
  });

  it('extracts files whose sizes come after the data', async () => {
    const zip = makeZip([{ name: 'a.ass', data: 'streamed '.repeat(30), descriptor: true }, { name: 'b.ass', data: 'stored', descriptor: true, store: true }]);
    assert.equal(await text(zip, 'a.ass'), 'streamed '.repeat(30));
    assert.equal(await text(zip, 'b.ass'), 'stored');
  });
});

describe('archives that are not what they should be', () => {
  it('says "not a ZIP" for anything else', async () => {
    await failsWith(list(Buffer.from('hello')), 'not-zip');
    await failsWith(list(Buffer.alloc(1000, 0x41)), 'not-zip');
    await failsWith(list(Buffer.from('PK\u0003\u0004 cut short')), 'not-zip');
    await failsWith(list(Buffer.from('Rar!\u001a\u0007\u0001\u0000'.repeat(10))), 'not-zip');
  });

  it('says "not a ZIP" for an archive cut off before its end', async () => {
    const zip = makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: 'hello again' }]);
    await failsWith(list(zip.subarray(0, zip.length - 30)), 'not-zip');
  });

  const patched = (change) => {
    const zip = makeZip([{ name: 'a.txt', data: 'hello' }]);
    change(zip, zip.length - 22); // where the end record starts
    return zip;
  };

  it('declines ZIP64 and split archives, and says so', async () => {
    await failsWith(list(patched((zip, end) => zip.writeUInt16LE(0xffff, end + 10))), 'unsupported');
    await failsWith(list(patched((zip, end) => zip.writeUInt32LE(0xffffffff, end + 16))), 'unsupported');
    await failsWith(list(patched((zip, end) => zip.writeUInt16LE(1, end + 4))), 'unsupported');
  });

  it('notices a damaged directory', async () => {
    await failsWith(list(patched((zip, end) => zip.writeUInt32LE(0, zip.readUInt32LE(end + 16)))), 'corrupt');
    await failsWith(list(patched((zip, end) => zip.writeUInt32LE(zip.length + 1000, end + 16))), 'corrupt');
    // An entry claiming a longer name than the directory has room for.
    await failsWith(list(patched((zip, end) => zip.writeUInt16LE(60000, zip.readUInt32LE(end + 16) + 28))), 'corrupt');
  });

  it('refuses a directory with too many files or too large before reading it', async () => {
    const zip = makeZip(Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.srt`, data: 'x' })));
    await failsWith(list(zip, { maxEntries: 5 }), 'too-large');
    await failsWith(list(zip, { maxDirectoryBytes: 100 }), 'too-large');
    const source = counting(patched((buffer, end) => buffer.writeUInt32LE(0x7fffffff, end + 12)));
    await failsWith(readDirectory(source), 'too-large');
    assert.ok(source.bytes() <= TAIL_BYTES, 'only the end of the file was read');
  });
});

describe('extracting a file', () => {
  const only = async (zip, limits) => {
    const source = counting(zip);
    const [entry] = await readDirectory(source);
    return { source, entry, result: () => extract(source, entry, limits) };
  };

  it('declines what it cannot read: encrypted files, other compression, folders', async () => {
    const encrypted = await only(makeZip([{ name: 'a.ass', data: 'secret', encrypted: true }]));
    await failsWith(encrypted.result(), 'unsupported');
    const lzma = await only(makeZip([{ name: 'a.ass', data: 'x', method: 14 }]));
    await failsWith(lzma.result(), 'unsupported');
    const folder = await only(makeZip([{ name: 'dir/', data: '' }]));
    await failsWith(folder.result(), 'unsupported');
  });

  it('refuses a file too large, without reading any of it', async () => {
    const zip = makeZip([{ name: 'a.srt', data: Buffer.alloc(200_000, 0x41), store: true }]);
    const big = await only(zip, { maxBytes: 100_000 });
    const before = big.source.reads.length;
    await failsWith(big.result(), 'too-large');
    assert.equal(big.source.reads.length, before);
  });

  it('is not fooled by an archive that lies about the size of a file (a zip bomb)', async () => {
    // 20 MB of zeros packs to a few KB; the archive claims 100 bytes.
    const bomb = await only(makeZip([{ name: 'a.srt', data: Buffer.alloc(20 * 1024 * 1024), size: 100, crc: 0 }]));
    await failsWith(bomb.result(), 'corrupt');
    // And one that claims a huge size is refused before inflating.
    const claims = await only(makeZip([{ name: 'a.srt', data: 'tiny', size: 0x7fffffff }]));
    await failsWith(claims.result(), 'too-large');
  });

  it('notices a wrong checksum and a wrong size', async () => {
    await failsWith((await only(makeZip([{ name: 'a.srt', data: 'hello', crc: 12345 }]))).result(), 'corrupt');
    await failsWith((await only(makeZip([{ name: 'a.srt', data: 'hello', size: 3 }]))).result(), 'corrupt');
    await failsWith((await only(makeZip([{ name: 'a.srt', data: 'hello', size: 7, store: true }]))).result(), 'corrupt');
  });

  it('notices data that is not deflate, and a header that is not there', async () => {
    const garbage = makeZip([{ name: 'a.srt', data: 'hello world', method: 8, packed: Buffer.from('hello world') }]); // claims deflate, holds plain text
    await failsWith((await only(garbage)).result(), 'corrupt');
    const zip = makeZip([{ name: 'a.srt', data: 'hello world' }]);
    const { entry } = await only(zip);
    await failsWith(extract(memorySource(zip), { ...entry, offset: 3 }), 'corrupt');
  });

  it('notices an archive that ends inside a file', async () => {
    const zip = makeZip([{ name: 'a.srt', data: 'hello world, hello world, hello world', store: true }]);
    const { entry } = await only(zip);
    await failsWith(extract(memorySource(zip.subarray(0, entry.offset + 40)), entry), 'corrupt');
  });

  it('accepts a stored file with a raw deflate stream that is exactly as big as claimed', async () => {
    const packed = deflateRawSync(Buffer.from('abc'.repeat(100)));
    assert.ok(packed.length < 300);
    assert.equal(await text(makeZip([{ name: 'a.txt', data: 'abc'.repeat(100) }]), 'a.txt'), 'abc'.repeat(100));
  });
});
