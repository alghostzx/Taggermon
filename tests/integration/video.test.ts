import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  inspectVideoContainerTags,
  detectSubtitleLanguageAndFlags,
  matchSubtitlesToVideos,
  processVideoAndSubtitles,
} from '../../src/server/processors/videoProcessor.js';
import { createTestWorkspace, TestWorkspace } from '../test-helpers.js';

describe('Integration: Movies & Series Video Processor and Subtitle Matcher', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace('taggermon-video-int-');
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('detects language codes and flags (.forced, .sdh) across varied subtitle naming conventions', () => {
    expect(
      detectSubtitleLanguageAndFlags('Severance.S01E01.pt-BR.forced.srt')
    ).toEqual({
      languageCode: 'pt-BR',
      isForced: true,
      isSdh: false,
    });

    expect(
      detectSubtitleLanguageAndFlags('Severance.S01E01.eng.sdh.srt')
    ).toEqual({
      languageCode: 'en',
      isForced: false,
      isSdh: true,
    });

    expect(
      detectSubtitleLanguageAndFlags('Blade.Runner.1982.pob.cc.forced.ass')
    ).toEqual({
      languageCode: 'pt-BR',
      isForced: true,
      isSdh: true,
    });
  });

  it('strips MKV container tags via mkvpropedit/ffmpeg and renames matched episode subtitles', async () => {
    const srcMkv = ws.copyFixture(
      'video/sample_episode.mkv',
      path.join(ws.downloadsDir, 'Severance.S01/Severance.S01E01.1080p.mkv')
    );
    const srcSrtPt = ws.copyFixture(
      'video/sample_episode.pt-BR.forced.srt',
      path.join(
        ws.downloadsDir,
        'Severance.S01/Severance.S01E01.pt-BR.forced.srt'
      )
    );
    const srcSrtEn = ws.copyFixture(
      'video/sample_episode.eng.sdh.srt',
      path.join(ws.downloadsDir, 'Severance.S01/Severance.S01E01.eng.sdh.srt')
    );

    const beforeTags = await inspectVideoContainerTags(srcMkv);
    expect(beforeTags.title).toBe('RARBG.COM - Severance.S01E01.1080p');

    const matched = matchSubtitlesToVideos(
      ['Severance.S01E01.1080p.mkv'],
      [
        'Severance.S01E01.pt-BR.forced.srt',
        'Severance.S01E01.eng.sdh.srt',
      ]
    );
    expect(matched).toHaveLength(2);

    const destMkv = path.join(
      ws.libraryDirs.series,
      'Severance/Season 01/Severance - S01E01 - Good News About Hell.mkv'
    );

    const result = await processVideoAndSubtitles({
      sourceVideoPath: srcMkv,
      destinationVideoPath: destMkv,
      stripContainerTags: true,
      subtitles: [
        {
          sourceSubtitlePath: srcSrtPt,
          ext: 'srt',
          languageCode: 'pt-BR',
          isForced: true,
          isSdh: false,
        },
        {
          sourceSubtitlePath: srcSrtEn,
          ext: 'srt',
          languageCode: 'en',
          isForced: false,
          isSdh: true,
        },
      ],
      removeSourceAfterWrite: true,
    });

    expect(fs.existsSync(result.videoOutputPath)).toBe(true);
    const afterTags = await inspectVideoContainerTags(result.videoOutputPath);
    expect(afterTags.title).toBeUndefined();
    expect(afterTags.comment).toBeUndefined();

    expect(result.subtitleOutputPaths).toEqual([
      path.join(
        ws.libraryDirs.series,
        'Severance/Season 01/Severance - S01E01 - Good News About Hell.pt-BR.forced.srt'
      ),
      path.join(
        ws.libraryDirs.series,
        'Severance/Season 01/Severance - S01E01 - Good News About Hell.en.sdh.srt'
      ),
    ]);
  });

  it('processes MP4 movie files and respects stripContainerTags=false toggle when disabled', async () => {
    const srcMp4 = ws.copyFixture(
      'video/sample_movie.mp4',
      path.join(ws.downloadsDir, 'BladeRunner/sample_movie.mp4')
    );
    const srcAss = ws.copyFixture(
      'video/Subs/sample_movie.pt-BR.ass',
      path.join(ws.downloadsDir, 'BladeRunner/Subs/sample_movie.pt-BR.ass')
    );

    const destMp4KeepTags = path.join(
      ws.libraryDirs.movies,
      'Blade Runner (1982)/Blade Runner (1982) - 1080p.mp4'
    );

    // 1. With stripContainerTags = false -> keeps original container tags
    await processVideoAndSubtitles({
      sourceVideoPath: srcMp4,
      destinationVideoPath: destMp4KeepTags,
      stripContainerTags: false,
      subtitles: [
        {
          sourceSubtitlePath: srcAss,
          ext: 'ass',
          languageCode: 'pt-BR',
        },
      ],
      removeSourceAfterWrite: false,
    });

    const keptTags = await inspectVideoContainerTags(destMp4KeepTags);
    expect(keptTags.title).toBe('YTS.MX - Blade Runner (1982) 1080p');

    // 2. With stripContainerTags = true -> strips MP4 container tags via ffmpeg
    const destMp4Stripped = path.join(
      ws.libraryDirs.movies,
      'Blade Runner (1982)/Blade Runner (1982) - Clean.mp4'
    );
    await processVideoAndSubtitles({
      sourceVideoPath: srcMp4,
      destinationVideoPath: destMp4Stripped,
      stripContainerTags: true,
      removeSourceAfterWrite: true,
    });

    const strippedTags = await inspectVideoContainerTags(destMp4Stripped);
    expect(strippedTags.title).toBeUndefined();
    expect(strippedTags.comment).toBeUndefined();
  });
});
