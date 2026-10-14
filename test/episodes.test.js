import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { archiveFit, isSubtitleMember, membersFor, readEpisode } from '../src/jimaku/episodes.js';

const entry = (path, extra = {}) => ({ path, directory: false, encrypted: false, zip64: false, method: 8, size: 100, compressedSize: 50, ...extra });

describe('readEpisode', () => {
  const single = (name, episode, season = null) => assert.deepEqual(readEpisode(name), { season, episode, range: null }, name);
  const nothing = (name) => assert.deepEqual(readEpisode(name), { season: null, episode: null, range: null }, name);

  it('reads the fansub convention "Title - 05"', () => {
    single('[SubsPlease] Sousou no Frieren - 05 (1080p) [A1B2C3D4].ass', 5);
    single('[Erai-raws] Sousou no Frieren - 05 [1080p][Multiple Subtitle].srt', 5);
    single('Sousou no Frieren - 05.ja.srt', 5);
    single('[Group] Show - 12v2 [BD 1080p].ass', 12);
    single('[Group] Show - 105 [1080p].ass', 105);
    single('One Piece - 1085.ass', 1085);
    single('[Group] Show - 00.ass', 0);
    single('[Group] Show - 05 - The Title of It.ass', 5);
    single('Show_-_05_(1080p).ass', 5);
  });

  it('reads S02E05 and 2x05, with the season', () => {
    single('Attack on Titan S02E05.srt', 5, 2);
    single('Show.Name.S01E05.1080p.WEB-DL.JA.srt', 5, 1);
    single('Show S1 E5.srt', 5, 1);
    single('Show S01E12v2.ass', 12, 1);
    single('Show 2x05.srt', 5, 2);
    assert.deepEqual(readEpisode('Show S01E05-E06.ass'), { season: 1, episode: null, range: [5, 6] });
    assert.deepEqual(readEpisode('Show S01E05E06.ass'), { season: 1, episode: null, range: [5, 6] });
  });

  it('reads E05, EP05, Episode 5', () => {
    single('Show E05.srt', 5);
    single('Show EP05.srt', 5);
    single('Show Ep. 5.srt', 5);
    single('Show Episode 5.ass', 5);
    single('Episode 12 - Title.ass', 12);
    single('Show Season 2 Episode 3.ass', 3);
  });

  it('reads 第5話 and #05, with full-width digits', () => {
    single('葬送のフリーレン 第5話.ass', 5);
    single('葬送のフリーレン 第05話.ass', 5);
    single('葬送のフリーレン 第５話.ass', 5);
    single('葬送のフリーレン 5話.ass', 5);
    single('Show #05.ass', 5);
  });

  it('reads a bare number: "05.ass", "Show 05", "[05]", "05 - Title"', () => {
    single('05.ass', 5);
    single('5.srt', 5);
    single('Show 05.srt', 5);
    single('Show.05.srt', 5);
    single('Show 05 [1080p].ass', 5);
    single('Show [05].ass', 5);
    single('05 - The Title.ass', 5);
    single('Mob Psycho 100 05.ass', 5);
    single('Mob Psycho 100 - 05.ass', 5);
    single('86 - Eighty Six - 05.ass', 5);
  });

  it('reads ranges', () => {
    assert.deepEqual(readEpisode('[Group] Show - 01-12 [BD 1080p].zip'), { season: null, episode: null, range: [1, 12] });
    assert.deepEqual(readEpisode('Show 01~28 Complete.zip'), { season: null, episode: null, range: [1, 28] });
    assert.deepEqual(readEpisode('Show Episodes 04-06 [ASS].zip'), { season: null, episode: null, range: [4, 6] });
    assert.deepEqual(readEpisode('Show E01-E12.zip'), { season: null, episode: null, range: [1, 12] });
  });

  it('does not take resolutions, years, hashes and codecs for episodes', () => {
    nothing('Kimi no Na wa. (2016) [BD 1080p].srt');
    nothing('Show 1080p.ass');
    nothing('Show [720p] [x264 10bit] [A1B2C3D4].ass');
    nothing('Show 2023.ass');
    nothing('Show - 2023.ass');
    nothing('Show (2023) 1920x1080.ass');
    nothing('Show BD E-AC3 5.1.ass');
    nothing('Sousou no Frieren - All episodes.zip');
    nothing('notes.txt');
    nothing('');
  });

  it('does not take a season, a part or a fraction for an episode', () => {
    nothing('Show Season 2.zip');
    nothing('Show Part 2.ass');
    nothing('Show 2nd Season.ass');
    nothing('Show - 05.5.ass');
    nothing('Show Vol 3.srt');
  });

  it('is strict about the names of archives and folders', () => {
    const strict = (name) => readEpisode(name, { strict: true });
    assert.equal(strict('Frieren - 2').episode, null, '"- 2" could as well be a season in a name of an archive');
    assert.equal(strict('Show 05').episode, null);
    assert.equal(strict('Show S01E05').episode, 5);
    assert.deepEqual(strict('Show 01-12').range, [1, 12]);
  });
});

describe('archiveFit', () => {
  it('says no only when the name says the episode or season is another', () => {
    assert.equal(archiveFit('[Group] Show - 13-24 [BD].zip', { episode: 5 }), 0);
    assert.equal(archiveFit('Show S02 Complete.zip', { episode: 5, season: 1 }), 0);
    assert.equal(archiveFit('Show E07.zip', { episode: 5 }), 0);
  });

  it('prefers an archive named for the episode, then one whose range covers it', () => {
    assert.equal(archiveFit('Show - 05.zip', { episode: 5 }), 3);
    assert.equal(archiveFit('Show 01-12.zip', { episode: 5 }), 2);
    assert.equal(archiveFit('Show Complete.zip', { episode: 5 }), 1);
    assert.equal(archiveFit('Show Season 2 Complete.zip', { episode: 5, season: 2 }), 1);
  });

  it('accepts every archive for a movie, and when the season is not known', () => {
    assert.equal(archiveFit('Whatever.zip', { movie: true }), 1);
    assert.equal(archiveFit('Show S02 Complete.zip', { episode: 5, season: null }), 1);
  });
});

describe('membersFor', () => {
  const names = (members) => members.map((m) => m.path);

  it('takes the files of the episode out of a batch', () => {
    const entries = [
      entry('Show/[SubsPlease] Show - 04 (1080p).ass'),
      entry('Show/[SubsPlease] Show - 05 (1080p).ass'),
      entry('Show/[SubsPlease] Show - 05 (1080p).srt'),
      entry('Show/[SubsPlease] Show - 06 (1080p).ass'),
      entry('Show/Fonts/NotoSansJP.ttf'),
      entry('Show/readme.txt'),
      entry('__MACOSX/Show/._[SubsPlease] Show - 05 (1080p).ass'),
      entry('Show/', { directory: true }),
    ];
    assert.deepEqual(names(membersFor(entries, { episode: 5, archiveName: 'Show.zip' })), ['Show/[SubsPlease] Show - 05 (1080p).ass', 'Show/[SubsPlease] Show - 05 (1080p).srt']);
  });

  it('does not mistake 05 for 5 digits of something else', () => {
    const entries = [entry('Show - 15.ass'), entry('Show - 50.ass'), entry('Show - 05.ass')];
    assert.deepEqual(names(membersFor(entries, { episode: 5 })), ['Show - 05.ass']);
  });

  it('reads the folder a file is in when its own name has no number', () => {
    const entries = [entry('Episode 04/subs.ass'), entry('Episode 05/subs.ass'), entry('06/subs.srt'), entry('05/other.srt')];
    assert.deepEqual(names(membersFor(entries, { episode: 5 })), ['Episode 05/subs.ass', '05/other.srt']);
    assert.deepEqual(names(membersFor(entries, { episode: 6 })), ['06/subs.srt']);
  });

  it('takes the only file of an archive named for the episode', () => {
    assert.deepEqual(names(membersFor([entry('subs.ass')], { episode: 5, archiveName: 'Show - 05 [ASS].zip' })), ['subs.ass']);
    assert.deepEqual(names(membersFor([entry('subs.ass')], { episode: 6, archiveName: 'Show - 05 [ASS].zip' })), []);
    assert.deepEqual(names(membersFor([entry('a.ass'), entry('b.ass')], { episode: 5, archiveName: 'Show - 05 [ASS].zip' })), [], 'two unnamed files cannot be told apart');
  });

  it('never guesses when nothing says which episode', () => {
    assert.deepEqual(names(membersFor([entry('Show.ass')], { episode: 5, archiveName: 'Show.zip' })), []);
    assert.deepEqual(names(membersFor([entry('Show - 05.ass')], { episode: null })), []);
  });

  it('keeps to the season asked for when the files name one, and keeps files that name none', () => {
    const entries = [entry('Show S01E05.ass'), entry('Show S02E05.ass'), entry('Season 2/Show - 05.ass'), entry('Show - 05.srt')];
    assert.deepEqual(names(membersFor(entries, { episode: 5, season: 2 })), ['Show S02E05.ass', 'Season 2/Show - 05.ass', 'Show - 05.srt']);
    assert.deepEqual(names(membersFor(entries, { episode: 5, season: null })).length, 4);
  });

  it('takes a file that covers a range of episodes', () => {
    assert.deepEqual(names(membersFor([entry('Show S01E05-E06.ass'), entry('Show S01E07.ass')], { episode: 6 })), ['Show S01E05-E06.ass']);
  });

  it('takes every subtitle file of a movie, and nothing else', () => {
    const entries = [entry('Movie.ass'), entry('Movie.srt'), entry('Movie.sup'), entry('Fonts/a.ttf'), entry('Movie.vtt')];
    assert.deepEqual(names(membersFor(entries, { movie: true })), ['Movie.ass', 'Movie.srt', 'Movie.vtt']);
  });

  it('leaves out what cannot be read: encrypted, ZIP64, exotic compression', () => {
    const entries = [entry('Show - 05.ass', { encrypted: true }), entry('Show - 05.srt', { method: 12 }), entry('Show - 05.vtt', { zip64: true }), entry('Show - 05.ssa')];
    assert.deepEqual(names(membersFor(entries, { episode: 5 })), ['Show - 05.ssa']);
    assert.equal(isSubtitleMember(entry('a.ass', { encrypted: true })), false);
    assert.equal(isSubtitleMember(entry('a.ASS')), true);
  });
});
