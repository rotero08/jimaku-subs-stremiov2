import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger, redactPath } from '../src/logger.js';
import { encodeConfig } from '../src/stremio/userConfig.js';

const capture = () => {
  const lines = [];
  return { lines, stream: { write: (chunk) => lines.push(chunk) } };
};

describe('redactPath', () => {
  const KEY = 'SuperSecretJimakuKey123';
  const segment = encodeConfig({ jimakuApiKey: KEY });

  it('hides the settings segment, wherever the request was going', () => {
    for (const tail of ['/manifest.json', '/configure', '/subtitles/series/kitsu:46474:5.json', '/anything/else', '']) {
      const out = redactPath(`/${segment}${tail}`);
      assert.equal(out, `/<config>${tail}`);
      assert.ok(!out.includes(segment) && !out.includes(KEY));
    }
  });

  it('leaves the ordinary routes alone', () => {
    for (const path of ['/', '/health', '/manifest.json', '/configure', '/logo.png', '/convert/aHR0cDovL2V4YW1wbGU.srt', '/subtitles/movie/tt5311514.json']) {
      assert.equal(redactPath(path), path);
    }
  });

  it('copes with percent-encoded padding', () => {
    assert.equal(redactPath('/eyJqaW1ha3VBcGlLZXkiOiJhYmMifQ%3D%3D/manifest.json'), '/<config>/manifest.json');
  });
});

describe('createLogger', () => {
  it('writes one JSON object per line in json format', () => {
    const { lines, stream } = capture();
    createLogger({ level: 'info', format: 'json', stream }).info('hello', { a: 1 });
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.msg, 'hello');
    assert.equal(entry.level, 'info');
    assert.equal(entry.a, 1);
    assert.ok(lines[0].endsWith('\n'));
  });

  it('writes a readable line in pretty format', () => {
    const { lines, stream } = capture();
    createLogger({ format: 'pretty', stream }).warn('careful', { path: '/x', ms: 4 });
    assert.match(lines[0], /^\d\d:\d\d:\d\d WARN {2}careful {2}path=\/x ms=4\n$/);
  });

  it('drops what is below its level', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'warn', format: 'json', stream });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    assert.deepEqual(lines.map((l) => JSON.parse(l).msg), ['w', 'e']);
  });

  it('is silent when asked', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'silent', stream });
    log.error('nothing');
    assert.equal(lines.length, 0);
  });

  it('falls back to info for an unknown level', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'loud', format: 'json', stream });
    log.debug('d');
    log.info('i');
    assert.equal(lines.length, 1);
  });
});
