import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  inspectAudioFile,
  writeAudioFileWithTagsAndCover,
  extractEmbeddedCoverFromAudio,
  saveFolderCoverFile,
  inspectImageFile,
} from '../../src/server/processors/audioProcessor.js';
import { MEDIA_TYPES_CONFIG } from '../../src/shared/constants.js';
import {
  createTestWorkspace,
  FIXTURES_DIR,
  TestWorkspace,
} from '../test-helpers.js';

describe('Integration: Music & Audiobooks Media Processor', () => {
  let ws: TestWorkspace;
  const musicTags = MEDIA_TYPES_CONFIG.music.availableTags.map((t) => t.key);
  const audiobookTags = MEDIA_TYPES_CONFIG.audiobooks.availableTags.map(
    (t) => t.key
  );

  beforeEach(() => {
    ws = createTestWorkspace('taggermon-audio-int-');
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('reads MP3, FLAC, M4A, and OGG fixtures, detecting template tags, unwanted tags, and whitelisted tags', async () => {
    // 1. MP3
    const mp3Info = await inspectAudioFile(
      path.join(FIXTURES_DIR, 'audio/sample.mp3'),
      'music',
      musicTags
    );
    expect(mp3Info.tags).toMatchObject({
      album_artist: 'Pink Floyd',
      artist: 'Pink Floyd',
      album: 'The Dark Side of the Moon',
      year: '1973',
      genre: 'Progressive Rock',
      track: '1',
      total_tracks: '10',
      disc: '1',
      total_discs: '1',
      title: 'Speak to Me',
    });
    expect(mp3Info.unwantedTags.comment).toBe(
      'Downloaded from PirateMusic.example'
    );
    expect(mp3Info.unwantedTags.encoded_by).toBe('LAME-Spam');

    // 2. FLAC with whitelist for REPLAYGAIN_TRACK_GAIN
    const flacInfo = await inspectAudioFile(
      path.join(FIXTURES_DIR, 'audio/sample.flac'),
      'music',
      musicTags,
      ['replaygain_track_gain']
    );
    expect(flacInfo.tags).toMatchObject({
      album_artist: 'Daft Punk',
      album: 'Discovery',
      year: '2001',
      track: '2',
      total_tracks: '14',
      title: 'Aerodynamic',
    });
    const flacUnwantedValues = Object.values(flacInfo.unwantedTags);
    expect(flacUnwantedValues).toContain('Unwanted FLAC description tag');
    expect(
      Object.keys(flacInfo.unwantedTags).map((k) => k.toLowerCase())
    ).not.toContain('replaygain_track_gain');

    // 3. M4A
    const m4aInfo = await inspectAudioFile(
      path.join(FIXTURES_DIR, 'audio/sample.m4a'),
      'music',
      musicTags
    );
    expect(m4aInfo.tags.album_artist).toBe('Radiohead');
    expect(m4aInfo.tags.album).toBe('OK Computer');
    expect(m4aInfo.unwantedTags.comment).toBe('Unwanted M4A comment');

    // 4. OGG
    const oggInfo = await inspectAudioFile(
      path.join(FIXTURES_DIR, 'audio/sample.ogg'),
      'music',
      musicTags
    );
    expect(oggInfo.tags.album_artist).toBe('Nirvana');
    expect(oggInfo.tags.title).toBe('Smells Like Teen Spirit');
    expect(oggInfo.unwantedTags.comment).toBe('Unwanted OGG Tag');
  });

  it('writes clean tags, embeds cover without downscaling, extracts embedded cover, and saves folder.png / folder.jpg', async () => {
    const srcMp3 = ws.copyFixture(
      'audio/sample.mp3',
      path.join(ws.downloadsDir, 'album/track01.mp3')
    );
    const coverPng = ws.copyFixture(
      'extras/cover_highres.png',
      path.join(ws.downloadsDir, 'album/cover.png')
    );
    const coverJpg = ws.copyFixture(
      'extras/cover_highres.jpg',
      path.join(ws.downloadsDir, 'album/cover.jpg')
    );

    const pngInfo = inspectImageFile(coverPng);
    expect(pngInfo).toEqual({ width: 64, height: 64, format: 'png' });

    const destAlbumDir = path.join(
      ws.libraryDirs.music,
      'Pink Floyd/1973 - The Dark Side of the Moon'
    );
    const destMp3 = path.join(destAlbumDir, '01 - Speak to Me.mp3');

    await writeAudioFileWithTagsAndCover({
      sourcePath: srcMp3,
      destinationPath: destMp3,
      mediaType: 'music',
      tags: {
        album_artist: 'Pink Floyd',
        artist: 'Pink Floyd',
        album: 'The Dark Side of the Moon',
        year: '1973',
        genre: 'Progressive Rock',
        disc: '1',
        total_discs: '1',
        track: '1',
        total_tracks: '10',
        title: 'Speak to Me',
        composer: 'Nick Mason',
      },
      preservedExtraTags: { custom_preserved: 'keep_me' },
      coverImagePath: coverPng,
      removeSourceAfterWrite: true,
    });

    expect(fs.existsSync(srcMp3)).toBe(false);
    expect(fs.existsSync(destMp3)).toBe(true);

    const after = await inspectAudioFile(destMp3, 'music', musicTags);
    expect(after.tags.composer).toBe('Nick Mason');
    expect(after.unwantedTags.comment).toBeUndefined();
    expect(after.unwantedTags.encoded_by).toBeUndefined();
    expect(after.unwantedTags.custom_preserved).toBe('keep_me');
    expect(after.hasEmbeddedCover).toBe(true);

    // Extract embedded cover and verify exact 64x64 resolution (no downscale)
    const extracted = await extractEmbeddedCoverFromAudio(destMp3);
    expect(extracted).not.toBeNull();
    expect(extracted!.ext).toBe('png');
    expect(extracted!.buffer.equals(fs.readFileSync(coverPng))).toBe(true);

    // Save folder.png, then replace with folder.jpg and verify folder.png is cleaned up
    const folderPngPath = saveFolderCoverFile(coverPng, destAlbumDir);
    expect(path.basename(folderPngPath)).toBe('folder.png');
    expect(fs.existsSync(folderPngPath)).toBe(true);

    const folderJpgPath = saveFolderCoverFile(coverJpg, destAlbumDir);
    expect(path.basename(folderJpgPath)).toBe('folder.jpg');
    expect(fs.existsSync(folderJpgPath)).toBe(true);
    expect(fs.existsSync(folderPngPath)).toBe(false);
  });

  it('processes M4B Audiobook files with author, narrator, series, series_part, book_title, and cover', async () => {
    const srcM4b = ws.copyFixture(
      'audio/sample.m4b',
      path.join(ws.downloadsDir, 'lotr/fellowship.m4b')
    );
    const coverJpg = ws.copyFixture(
      'extras/cover_highres.jpg',
      path.join(ws.downloadsDir, 'lotr/cover.jpg')
    );

    const before = await inspectAudioFile(srcM4b, 'audiobooks', audiobookTags);
    expect(before.tags).toMatchObject({
      author: 'J.R.R. Tolkien',
      narrator: 'Rob Inglis',
      book_title: 'The Fellowship of the Ring',
      series: 'The Lord of the Rings',
      series_part: '1',
      year: '1954',
      track: '1',
      total_tracks: '22',
      title: 'A Long-expected Party',
    });
    expect(before.unwantedTags.comment).toBe('Unwanted Audiobook Tag');

    const destDir = path.join(
      ws.libraryDirs.audiobooks,
      'J.R.R. Tolkien/The Lord of the Rings/01 - The Fellowship of the Ring (1954)'
    );
    const destM4b = path.join(destDir, '01 - A Long-expected Party.m4b');

    await writeAudioFileWithTagsAndCover({
      sourcePath: srcM4b,
      destinationPath: destM4b,
      mediaType: 'audiobooks',
      tags: {
        author: 'J.R.R. Tolkien',
        narrator: 'Rob Inglis',
        book_title: 'The Fellowship of the Ring',
        series: 'The Lord of the Rings',
        series_part: '1',
        year: '1954',
        genre: 'Fantasy',
        language: 'en',
        track: '1',
        total_tracks: '22',
        title: 'A Long-expected Party',
      },
      coverImagePath: coverJpg,
      removeSourceAfterWrite: true,
    });

    const after = await inspectAudioFile(destM4b, 'audiobooks', audiobookTags);
    expect(after.tags.author).toBe('J.R.R. Tolkien');
    expect(after.tags.narrator).toBe('Rob Inglis');
    expect(after.tags.series).toBe('The Lord of the Rings');
    expect(after.tags.series_part).toBe('1');
    expect(after.unwantedTags.comment).toBeUndefined();
    expect(after.hasEmbeddedCover).toBe(true);
  });

  it('handles corrupted or non-existent audio files gracefully without crashing', async () => {
    const corruptPath = path.join(ws.downloadsDir, 'corrupt.mp3');
    fs.writeFileSync(corruptPath, 'NOT_A_VALID_AUDIO_FILE');

    const res = await inspectAudioFile(corruptPath, 'music', musicTags);
    expect(res).toEqual({
      tags: {},
      unwantedTags: {},
      hasEmbeddedCover: false,
    });

    const coverRes = await extractEmbeddedCoverFromAudio(corruptPath);
    expect(coverRes).toBeNull();
  });
});
