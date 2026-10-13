import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  entriesForSeason,
  fileKind,
  fileSeason,
  filterBySeason,
  labelFor,
  normalizeTitle,
  rankEntries,
  releaseGroup,
  releaseSimilarity,
  scoreEntry,
  seasonHint,
  titleSimilarity,
} from '../src/jimaku/match.js';

describe('titles', () => {
  it('normalises case, accents, punctuation and years', () => {
    assert.equal(normalizeTitle("Frieren: Beyond Journey’s End (2023)"), 'frieren beyond journey s end');
    assert.equal(normalizeTitle('Pokémon & Friends'), 'pokemon and friends');
  });

  it('scores identical titles 1 and unrelated titles 0', () => {
    assert.equal(titleSimilarity('Sousou no Frieren', 'sousou no frieren!'), 1);
    assert.equal(titleSimilarity('Sousou no Frieren', 'One Piece'), 0);
    assert.equal(titleSimilarity('', 'x'), 0);
  });

  it('recognises a short title inside a longer one', () => {
    assert.ok(titleSimilarity('Frieren', 'Sousou no Frieren') >= 0.7);
    assert.ok(titleSimilarity('Frieren: Beyond Journey’s End', 'Sousou no Frieren') < 0.6);
  });

  it('compares Japanese titles by character pairs', () => {
    assert.equal(titleSimilarity('葬送のフリーレン', '葬送のフリーレン'), 1);
    assert.ok(titleSimilarity('葬送のフリーレン', '葬送のフリーレン 第2期') > 0.6);
    assert.equal(titleSimilarity('葬送のフリーレン', '鬼滅の刃'), 0);
  });
});

describe('season hints in titles', () => {
  it('reads the usual ways of saying it', () => {
    const cases = {
      'Re:Zero 2nd Season': 2,
      'Overlord Season 4': 4,
      'Mob Psycho 100 II': 2,
      'Konosuba S3': 3,
      '葬送のフリーレン 第2期': 2,
      'Gintama 3': 3,
      'Mob Psycho 100': null,
      'Sousou no Frieren': null,
      'Fate/stay night [Unlimited Blade Works]': null,
    };
    for (const [name, season] of Object.entries(cases)) assert.equal(seasonHint(name), season, name);
  });
});

describe('ranking entries', () => {
  const entries = [
    { id: 1, name: 'Sousou no Frieren', englishName: 'Frieren: Beyond Journey’s End', japaneseName: '葬送のフリーレン' },
    { id: 2, name: 'Sousou no Frieren 2nd Season', englishName: 'Frieren: Beyond Journey’s End Season 2', japaneseName: '葬送のフリーレン 第2期' },
    { id: 3, name: 'Shingeki no Kyojin', englishName: 'Attack on Titan' },
  ];

  it('finds the entry by any of its names', () => {
    for (const title of ['Sousou no Frieren', 'Frieren: Beyond Journey’s End', '葬送のフリーレン']) {
      assert.equal(rankEntries(entries, [title], { season: 1 })[0].entry.id, 1, title);
    }
  });

  it('prefers the entry that matches the season asked for', () => {
    assert.equal(rankEntries(entries, ['Sousou no Frieren'], { season: 2 })[0].entry.id, 2);
    assert.equal(rankEntries(entries, ['Sousou no Frieren'], { season: 1 })[0].entry.id, 1);
  });

  it('returns nothing when no title is close enough', () => {
    assert.deepEqual(rankEntries(entries, ['Totally Different Show']), []);
    assert.equal(scoreEntry(entries[2], ['Sousou no Frieren']), 0);
  });
});

describe('files', () => {
  it('classifies by extension', () => {
    assert.equal(fileKind('a.jp.ass'), 'ass');
    assert.equal(fileKind('A.SRT'), 'srt');
    assert.equal(fileKind('batch.zip'), 'archive');
    assert.equal(fileKind('cover.jpg'), 'other');
    assert.equal(fileKind('noextension'), 'other');
  });

  it('reads the season a file name states', () => {
    assert.equal(fileSeason('Show.S02E05.1080p.ass'), 2);
    assert.equal(fileSeason('Show 3x07.srt'), 3);
    assert.equal(fileSeason('Show Season 4 - 05.srt'), 4);
    assert.equal(fileSeason('[Group] Show - 05 [1080p].ass'), null);
  });

  it('drops files of other seasons and keeps the undecided ones', () => {
    const files = [{ name: 'Show.S01E05.ass' }, { name: 'Show.S02E05.ass' }, { name: 'Show - 05.ass' }];
    assert.deepEqual(filterBySeason(files, 2).map((f) => f.name), ['Show.S02E05.ass', 'Show - 05.ass']);
    assert.equal(filterBySeason(files, null).length, 3);
  });

  it('finds the release group, skipping resolutions and hashes', () => {
    assert.equal(releaseGroup('[SubsPlease] Frieren - 05 (1080p) [ABCD1234].mkv'), 'SubsPlease');
    assert.equal(releaseGroup('[1080p] Show.mkv'), null);
    assert.equal(releaseGroup('[ABCD1234] Show.mkv'), null);
    assert.equal(releaseGroup('Frieren - 05.mkv'), null);
  });

  it('rates how alike two releases are', () => {
    const video = '[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1234].mkv';
    const same = releaseSimilarity(video, '[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1234].ja.ass');
    const sameGroup = releaseSimilarity(video, '[SubsPlease] Sousou no Frieren - 05 (720p).ass');
    const other = releaseSimilarity(video, '[Erai-raws] Sousou no Frieren - 05 [720p].srt');
    assert.ok(same > sameGroup && sameGroup > other, `${same} ${sameGroup} ${other}`);
    assert.equal(releaseSimilarity('', 'x.srt'), 0);
  });

  it('writes a short label for the picker', () => {
    assert.equal(labelFor('[SubsPlease] Frieren - 05 (1080p).ja.srt'), 'SubsPlease · 1080p · SRT');
    assert.equal(labelFor('[SubsPlease] Frieren - 05 (1080p).ass', { converted: true }), 'SubsPlease · 1080p · ASS→SRT');
    assert.equal(labelFor('Frieren - 05.ass'), 'Frieren - 05 · ASS');
    assert.ok(labelFor(`${'Very long title '.repeat(10)}.srt`).length < 60);
  });
});

describe('entriesForSeason', () => {
  const entry = (id, name, englishName = null) => ({ id, name, englishName, japaneseName: null });
  const attack = [entry(1, 'Shingeki no Kyojin', 'Attack on Titan'), entry(2, 'Shingeki no Kyojin 2nd Season', 'Attack on Titan Season 2'), entry(3, 'Shingeki no Kyojin Season 3')];
  const ids = (list) => list.map((e) => e.id);

  it('picks the entry that names the season', () => {
    assert.deepEqual(ids(entriesForSeason(attack, 2)), [2]);
    assert.deepEqual(ids(entriesForSeason(attack, 3)), [3]);
  });

  it('takes an entry that names no season for the first', () => {
    assert.deepEqual(ids(entriesForSeason(attack, 1)), [1]);
  });

  it('returns nothing when no entry is that season, rather than a wrong one', () => {
    assert.deepEqual(entriesForSeason(attack, 4), []);
  });

  it('keeps a lone entry whatever season is asked: it covers the whole show', () => {
    const lone = [entry(9, 'Hanzawa Naoki')];
    assert.deepEqual(entriesForSeason(lone, 2), lone);
    assert.deepEqual(entriesForSeason([], 2), []);
  });

  it('keeps everything when no season is known', () => {
    assert.deepEqual(entriesForSeason(attack, null), attack);
  });
});
