import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import AdmZip from 'adm-zip';
import {
  renderTemplate,
  formatDestinationRelativePath,
  parseTagsFromPattern,
  deduceTemplateFromSample,
  aggregateTemplateSuggestions,
} from '../src/server/templateEngine.js';
import {
  inspectAudioFile,
  writeAudioFileWithTagsAndCover,
  saveFolderCoverFile,
} from '../src/server/processors/audioProcessor.js';
import {
  inspectComicOrMangaFile,
  processComicOrMangaFile,
  parseComicInfoXml,
} from '../src/server/processors/comicProcessor.js';
import {
  inspectBookFile,
  processBookFile,
} from '../src/server/processors/bookProcessor.js';
import {
  detectSubtitleLanguageAndFlags,
  matchSubtitlesToVideos,
  processVideoAndSubtitles,
  inspectVideoContainerTags,
} from '../src/server/processors/videoProcessor.js';
import { buildServer } from '../src/server/index.js';
import { closeDb } from '../src/server/db.js';

const execFileAsync = promisify(execFile);

// Tiny valid 2x2 PNG image buffer for testing covers and comic pages without external assets
const VALID_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4z8DAwAAABgAB/7/1KAAAAABJRU5ErkJggg==',
  'base64'
);

describe('Template Engine & Heuristic Discovery', () => {
  it('renders tokens with zero-padding and conditional optional blocks [...]', () => {
    const pathTpl = '{album_artist}/{year} - {album}';
    const fileTpl = '[{disc:02}-]{track:02} - {title}.{ext}';

    const resWithoutDisc = formatDestinationRelativePath(
      pathTpl,
      fileTpl,
      {
        album_artist: 'Pink Floyd',
        year: '1973',
        album: 'The Dark Side of the Moon',
        track: '3',
        title: 'Time',
      },
      'flac'
    );
    expect(resWithoutDisc.fullRelativePath).toBe(
      'Pink Floyd/1973 - The Dark Side of the Moon/03 - Time.flac'
    );

    const resWithDisc = formatDestinationRelativePath(
      pathTpl,
      fileTpl,
      {
        album_artist: 'Pink Floyd',
        year: '1979',
        album: 'The Wall',
        disc: '2',
        track: '6',
        title: 'Comfortably Numb',
      },
      'flac'
    );
    expect(resWithDisc.fullRelativePath).toBe(
      'Pink Floyd/1979 - The Wall/02-06 - Comfortably Numb.flac'
    );
  });

  it('parses tags from filename or path using token pattern', () => {
    const parsed = parseTagsFromPattern(
      '01-05 - Money',
      '[{disc:02}-]{track:02} - {title}'
    );
    expect(parsed).toEqual({
      disc: '1',
      track: '5',
      title: 'Money',
    });

    const parsedNoDisc = parseTagsFromPattern(
      '05 - Money',
      '[{disc:02}-]{track:02} - {title}'
    );
    expect(parsedNoDisc).toEqual({
      track: '5',
      title: 'Money',
    });

    const parsedSeries = parseTagsFromPattern(
      'Severance - S01E04 - The You You Are',
      '{series} - S{season:02}E{episode:02}[ - {title}]'
    );
    expect(parsedSeries).toEqual({
      series: 'Severance',
      season: '1',
      episode: '4',
      title: 'The You You Are',
    });
  });

  it('heuristically deduces templates from existing library samples', () => {
    const musicSample = deduceTemplateFromSample(
      'music',
      'Iron Maiden/1982 - The Number of the Beast/06 - Run to the Hills.flac',
      {
        album_artist: 'Iron Maiden',
        year: '1982',
        album: 'The Number of the Beast',
        track: '6',
        title: 'Run to the Hills',
      }
    );
    expect(musicSample.pathTemplate).toBe('{album_artist}/{year} - {album}');
    expect(musicSample.filenameTemplate).toBe('{track:02} - {title}.{ext}');

    const seriesSuggestions = aggregateTemplateSuggestions('series', [
      {
        relativePath:
          'Breaking Bad/Season 01/Breaking Bad - S01E01 - Pilot.mkv',
        tags: {},
      },
      {
        relativePath:
          'Breaking Bad/Season 01/Breaking Bad - S01E02 - Cat\'s in the Bag.mkv',
        tags: {},
      },
    ]);
    expect(seriesSuggestions[0].pathTemplate).toBe('{series}/Season {season:02}');
    expect(seriesSuggestions[0].filenameTemplate).toBe(
      '{series} - S{season:02}E{episode:02}[ - {title}].{ext}'
    );
    expect(seriesSuggestions[0].confidence).toBe(1);
  });
});

describe('Media Processors & Full API Pipeline', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taggermon-test-'));
    process.env.CONFIG_DIR = path.join(tempRoot, 'config');
    process.env.DOWNLOADS_DIR = path.join(tempRoot, 'downloads');
    process.env.LIBRARY_MUSIC_DIR = path.join(tempRoot, 'library/music');
    process.env.LIBRARY_AUDIOBOOKS_DIR = path.join(
      tempRoot,
      'library/audiobooks'
    );
    process.env.LIBRARY_BOOKS_DIR = path.join(tempRoot, 'library/books');
    process.env.LIBRARY_COMICS_DIR = path.join(tempRoot, 'library/comics');
    process.env.LIBRARY_MANGA_DIR = path.join(tempRoot, 'library/manga');
    process.env.LIBRARY_MOVIES_DIR = path.join(tempRoot, 'library/movies');
    process.env.LIBRARY_SERIES_DIR = path.join(tempRoot, 'library/series');
    closeDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('processes Music & Audiobooks: reads tags, cleans unwanted tags, embeds cover without downscale, and saves folder.png/jpg', async () => {
    const srcMp3 = path.join(tempRoot, 'src_track.mp3');
    const coverPng = path.join(tempRoot, 'highres_cover.png');
    await execFileAsync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=32x32:d=0.1',
      '-frames:v',
      '1',
      coverPng,
    ]);
    const validPngBytes = fs.readFileSync(coverPng);

    // Generate a 0.2s silent MP3 with an unwanted tag COMMENT="pirate-site.org"
    await execFileAsync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=stereo',
      '-t',
      '0.2',
      '-metadata',
      'title=Old Title',
      '-metadata',
      'artist=Old Artist',
      '-metadata',
      'comment=pirate-site.org',
      '-metadata',
      'encoded_by=SpamRipper',
      srcMp3,
    ]);

    const inspectedBefore = await inspectAudioFile(srcMp3, 'music', [
      'album_artist',
      'artist',
      'album',
      'year',
      'track',
      'title',
    ]);
    expect(inspectedBefore.tags.title).toBe('Old Title');
    expect(inspectedBefore.unwantedTags.comment).toBe('pirate-site.org');

    const destDir = path.join(
      process.env.LIBRARY_MUSIC_DIR!,
      'Daft Punk/2001 - Discovery'
    );
    const destMp3 = path.join(destDir, '01 - One More Time.mp3');

    await writeAudioFileWithTagsAndCover({
      sourcePath: srcMp3,
      destinationPath: destMp3,
      mediaType: 'music',
      tags: {
        album_artist: 'Daft Punk',
        artist: 'Daft Punk',
        album: 'Discovery',
        year: '2001',
        track: '1',
        total_tracks: '14',
        title: 'One More Time',
      },
      coverImagePath: coverPng,
      removeSourceAfterWrite: true,
    });

    const savedFolderCover = saveFolderCoverFile(coverPng, destDir);
    expect(path.basename(savedFolderCover)).toBe('folder.png');
    expect(fs.readFileSync(savedFolderCover).equals(validPngBytes)).toBe(
      true
    );

    const inspectedAfter = await inspectAudioFile(destMp3, 'music', [
      'album_artist',
      'artist',
      'album',
      'year',
      'track',
      'total_tracks',
      'title',
    ]);
    expect(inspectedAfter.tags.album_artist).toBe('Daft Punk');
    expect(inspectedAfter.tags.album).toBe('Discovery');
    expect(inspectedAfter.tags.title).toBe('One More Time');
    expect(inspectedAfter.tags.track).toBe('1');
    expect(inspectedAfter.unwantedTags.comment).toBeUndefined();
    expect(inspectedAfter.hasEmbeddedCover).toBe(true);
  });

  it('converts Manga/Comics EPUB to CBZ following <spine> reading order and writes clean ComicInfo.xml', async () => {
    const srcEpub = path.join(tempRoot, 'manga_vol1.epub');
    const epubZip = new AdmZip();

    epubZip.addFile(
      'META-INF/container.xml',
      Buffer.from(
        `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
      )
    );

    // Note: alphabetically img_z.png is after img_a.png, but <spine> puts page1 (which shows img_z.png) FIRST!
    epubZip.addFile(
      'OEBPS/content.opf',
      Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Berserk Vol 1</dc:title>
    <dc:creator>Kentaro Miura</dc:creator>
    <dc:description>Spam description to clean</dc:description>
  </metadata>
  <manifest>
    <item id="p1" href="text/p1.xhtml" media-type="application/xhtml+xml"/>
    <item id="p2" href="text/p2.xhtml" media-type="application/xhtml+xml"/>
    <item id="img_z" href="images/z_first_page.png" media-type="image/png"/>
    <item id="img_a" href="images/a_second_page.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="p1"/>
    <itemref idref="p2"/>
  </spine>
</package>`
      )
    );

    epubZip.addFile(
      'OEBPS/text/p1.xhtml',
      Buffer.from(
        `<html><body><img src="../images/z_first_page.png"/></body></html>`
      )
    );
    epubZip.addFile(
      'OEBPS/text/p2.xhtml',
      Buffer.from(
        `<html><body><img src="../images/a_second_page.png"/></body></html>`
      )
    );

    const page1Bytes = Buffer.concat([VALID_PNG_BUFFER, Buffer.from('PAGE1')]);
    const page2Bytes = Buffer.concat([VALID_PNG_BUFFER, Buffer.from('PAGE2')]);
    epubZip.addFile('OEBPS/images/z_first_page.png', page1Bytes);
    epubZip.addFile('OEBPS/images/a_second_page.png', page2Bytes);
    epubZip.writeZip(srcEpub);

    const inspected = await inspectComicOrMangaFile(srcEpub, [
      'series',
      'writer',
      'volume',
      'number',
      'title',
    ]);
    expect(inspected.needsConversionToCbz).toBe(true);
    expect(inspected.tags.writer).toBe('Kentaro Miura');

    const destCbz = path.join(
      process.env.LIBRARY_MANGA_DIR!,
      'Berserk/Vol. 01/Berserk - Vol. 01 Cap. 001.cbz'
    );
    const outPath = await processComicOrMangaFile({
      sourcePath: srcEpub,
      destinationPath: destCbz,
      tags: {
        series: 'Berserk',
        writer: 'Kentaro Miura',
        volume: '1',
        number: '1',
        title: 'The Black Swordsman',
      },
      removeSourceAfterWrite: true,
    });

    expect(outPath).toBe(destCbz);
    expect(fs.existsSync(destCbz)).toBe(true);

    const resultZip = new AdmZip(destCbz);
    const entryNames = resultZip.getEntries().map((e) => e.entryName);
    expect(entryNames).toContain('0001.png');
    expect(entryNames).toContain('0002.png');
    expect(entryNames).toContain('ComicInfo.xml');

    // Verify 0001.png actually contains page1Bytes (following spine order, not alphabetical)
    expect(resultZip.getEntry('0001.png')!.getData().equals(page1Bytes)).toBe(
      true
    );
    expect(resultZip.getEntry('0002.png')!.getData().equals(page2Bytes)).toBe(
      true
    );

    const comicInfoText = resultZip
      .getEntry('ComicInfo.xml')!
      .getData()
      .toString('utf8');
    const parsedXml = parseComicInfoXml(comicInfoText, [
      'series',
      'writer',
      'volume',
      'number',
      'title',
    ]);
    expect(parsedXml.tags.series).toBe('Berserk');
    expect(parsedXml.tags.writer).toBe('Kentaro Miura');
    expect(parsedXml.tags.number).toBe('1');
    expect(Object.keys(parsedXml.unwantedTags)).toHaveLength(0);
  });

  it('edits EPUB Book metadata in content.opf and handles PDF without internal tags', async () => {
    const srcBookEpub = path.join(tempRoot, 'foundation.epub');
    const zip = new AdmZip();
    zip.addFile(
      'META-INF/container.xml',
      Buffer.from(
        `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
      )
    );
    zip.addFile(
      'content.opf',
      Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Old Title</dc:title>
    <dc:creator>Old Author</dc:creator>
    <dc:rights>Unwanted Rights Tag</dc:rights>
  </metadata>
  <manifest/>
  <spine/>
</package>`
      )
    );
    zip.writeZip(srcBookEpub);

    const destBookEpub = path.join(
      process.env.LIBRARY_BOOKS_DIR!,
      'Isaac Asimov/Série da Fundação/Série da Fundação 01 - Fundação (1951).epub'
    );

    await processBookFile({
      sourcePath: srcBookEpub,
      destinationPath: destBookEpub,
      tags: {
        author: 'Isaac Asimov',
        title: 'Fundação',
        series: 'Série da Fundação',
        series_part: '1',
        year: '1951',
      },
      removeSourceAfterWrite: true,
    });

    const afterInspect = await inspectBookFile(destBookEpub, [
      'author',
      'title',
      'series',
      'series_part',
      'year',
    ]);
    expect(afterInspect.tags.author).toBe('Isaac Asimov');
    expect(afterInspect.tags.title).toBe('Fundação');
    expect(afterInspect.tags.series).toBe('Série da Fundação');
    expect(afterInspect.tags.series_part).toBe('1');
    expect(afterInspect.unwantedTags['dc:rights']).toBeUndefined();

    // PDF book test: dispenses internal tags, only organizes path and filename
    const srcPdf = path.join(tempRoot, 'raw.pdf');
    fs.writeFileSync(srcPdf, '%PDF-1.4 mock content');
    const destPdf = path.join(
      process.env.LIBRARY_BOOKS_DIR!,
      'Isaac Asimov/Eu, Robô (1950).pdf'
    );
    await processBookFile({
      sourcePath: srcPdf,
      destinationPath: destPdf,
      tags: { author: 'Isaac Asimov', title: 'Eu, Robô', year: '1950' },
      removeSourceAfterWrite: true,
    });
    expect(fs.existsSync(destPdf)).toBe(true);
  });

  it('strips Video container tags via ffmpeg/mkvpropedit and matches/renames subtitles', async () => {
    const srcMkv = path.join(tempRoot, 'Severance.S01E01.1080p.mkv');
    const srcSrtPt = path.join(tempRoot, 'Severance.S01E01.pt-BR.forced.srt');
    const srcSrtEn = path.join(tempRoot, 'Severance.S01E01.eng.srt');

    await execFileAsync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x64:d=0.1',
      '-metadata',
      'title=RARBG.COM - Severance.S01E01',
      '-metadata',
      'comment=Downloaded from tracker',
      srcMkv,
    ]);
    fs.writeFileSync(srcSrtPt, '1\n00:00:00,000 --> 00:00:01,000\nOlá\n');
    fs.writeFileSync(srcSrtEn, '1\n00:00:00,000 --> 00:00:01,000\nHello\n');

    const beforeTags = await inspectVideoContainerTags(srcMkv);
    expect(beforeTags.title).toContain('RARBG');

    const matchedSubs = matchSubtitlesToVideos(
      ['Severance.S01E01.1080p.mkv'],
      ['Severance.S01E01.pt-BR.forced.srt', 'Severance.S01E01.eng.srt']
    );
    expect(matchedSubs).toHaveLength(2);
    expect(matchedSubs[0].languageCode).toBe('pt-BR');
    expect(matchedSubs[0].isForced).toBe(true);
    expect(matchedSubs[1].languageCode).toBe('en');

    const destMkv = path.join(
      process.env.LIBRARY_SERIES_DIR!,
      'Severance/Season 01/Severance - S01E01 - Good News About Hell.mkv'
    );

    const res = await processVideoAndSubtitles({
      sourceVideoPath: srcMkv,
      destinationVideoPath: destMkv,
      stripContainerTags: true,
      subtitles: [
        {
          sourceSubtitlePath: srcSrtPt,
          ext: 'srt',
          languageCode: 'pt-BR',
          isForced: true,
        },
        {
          sourceSubtitlePath: srcSrtEn,
          ext: 'srt',
          languageCode: 'en',
          isForced: false,
        },
      ],
      removeSourceAfterWrite: true,
    });

    expect(fs.existsSync(res.videoOutputPath)).toBe(true);
    const afterTags = await inspectVideoContainerTags(res.videoOutputPath);
    expect(afterTags.title).toBeUndefined();
    expect(afterTags.comment).toBeUndefined();

    expect(res.subtitleOutputPaths).toContain(
      path.join(
        process.env.LIBRARY_SERIES_DIR!,
        'Severance/Season 01/Severance - S01E01 - Good News About Hell.pt-BR.forced.srt'
      )
    );
    expect(res.subtitleOutputPaths).toContain(
      path.join(
        process.env.LIBRARY_SERIES_DIR!,
        'Severance/Season 01/Severance - S01E01 - Good News About Hell.en.srt'
      )
    );
  });

  it('executes end-to-end Fastify API routes for folder scanning, template update, and cluster processing', async () => {
    const app = await buildServer();

    // Create a download cluster folder with a music track and a cover image
    const downloadClusterDir = path.join(
      process.env.DOWNLOADS_DIR!,
      'Pink Floyd - 1973 - Dark Side'
    );
    fs.mkdirSync(downloadClusterDir, { recursive: true });
    const trackPath = path.join(downloadClusterDir, '01 - Speak to Me.mp3');
    const coverPath = path.join(downloadClusterDir, 'cover.png');
    await execFileAsync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=32x32:d=0.1',
      '-frames:v',
      '1',
      coverPath,
    ]);
    fs.writeFileSync(path.join(downloadClusterDir, 'info.nfo'), 'release nfo');

    await execFileAsync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=stereo',
      '-t',
      '0.1',
      '-metadata',
      'title=Speak to Me',
      '-metadata',
      'artist=Pink Floyd',
      '-metadata',
      'album=The Dark Side of the Moon',
      '-metadata',
      'date=1973',
      '-metadata',
      'track=1',
      trackPath,
    ]);

    // 1. List folders in downloads
    const foldersRes = await app.inject({
      method: 'GET',
      url: '/api/folders?source=downloads',
    });
    expect(foldersRes.statusCode).toBe(200);
    const foldersData = foldersRes.json();
    expect(foldersData.folders).toHaveLength(1);
    expect(foldersData.folders[0].suggestedMediaType).toBe('music');

    // 2. Scan cluster
    const clusterRes = await app.inject({
      method: 'GET',
      url: `/api/cluster?source=downloads&path=${encodeURIComponent(
        'Pink Floyd - 1973 - Dark Side'
      )}`,
    });
    expect(clusterRes.statusCode).toBe(200);
    const clusterData = clusterRes.json();
    expect(clusterData.mediaFiles).toHaveLength(1);
    expect(clusterData.extraFiles).toHaveLength(2);

    // 3. Process cluster into /library/music
    const processRes = await app.inject({
      method: 'POST',
      url: '/api/process-cluster',
      payload: {
        sourceRoot: 'downloads',
        clusterRelativePath: 'Pink Floyd - 1973 - Dark Side',
        targetMediaType: 'music',
        deleteIgnoredExtrasAndCleanupSource: true,
        coverSelection: {
          mode: 'extra_file',
          extraFileRelativePath: 'cover.png',
        },
        files: [
          {
            relativePath: '01 - Speak to Me.mp3',
            tags: {
              album_artist: 'Pink Floyd',
              artist: 'Pink Floyd',
              album: 'The Dark Side of the Moon',
              year: '1973',
              track: '1',
              title: 'Speak to Me',
            },
          },
        ],
        extraFiles: [
          { relativePath: 'cover.png', action: 'use_as_cover' },
          { relativePath: 'info.nfo', action: 'ignore' },
        ],
      },
    });
    expect(processRes.statusCode).toBe(200);
    const procData = processRes.json();
    expect(procData.success).toBe(true);
    expect(procData.sourceFolderRemoved).toBe(true);
    expect(procData.folderCoverSavedAs).toBe(
      'Pink Floyd/1973 - The Dark Side of the Moon/folder.png'
    );

    const finalTrack = path.join(
      process.env.LIBRARY_MUSIC_DIR!,
      'Pink Floyd/1973 - The Dark Side of the Moon/01 - Speak to Me.mp3'
    );
    expect(fs.existsSync(finalTrack)).toBe(true);

    // 4. Verify heuristic template discovery on the newly populated music library
    const sugRes = await app.inject({
      method: 'GET',
      url: '/api/templates/music/suggestions',
    });
    expect(sugRes.statusCode).toBe(200);
    const sugData = sugRes.json();
    expect(sugData.suggestions[0].pathTemplate).toBe(
      '{album_artist}/{year} - {album}'
    );

    await app.close();
  });
});
