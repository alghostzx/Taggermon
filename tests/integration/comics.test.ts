import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import {
  inspectComicOrMangaFile,
  processComicOrMangaFile,
  parseComicInfoXml,
} from '../../src/server/processors/comicProcessor.js';
import { MEDIA_TYPES_CONFIG } from '../../src/shared/constants.js';
import {
  createTestWorkspace,
  FIXTURES_DIR,
  TestWorkspace,
} from '../test-helpers.js';

describe('Integration: Comics & Manga Media Processor', () => {
  let ws: TestWorkspace;
  const comicTags = MEDIA_TYPES_CONFIG.comics.availableTags.map((t) => t.key);
  const mangaTags = MEDIA_TYPES_CONFIG.manga.availableTags.map((t) => t.key);

  beforeEach(() => {
    ws = createTestWorkspace('taggermon-comics-int-');
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('reads existing CBZ ComicInfo.xml, updates template tags, and strips unwanted tags', async () => {
    const srcCbz = ws.copyFixture(
      'comics/sample.cbz',
      path.join(ws.downloadsDir, 'sandman/issue01.cbz')
    );

    const before = await inspectComicOrMangaFile(srcCbz, comicTags);
    expect(before.needsConversionToCbz).toBe(false);
    expect(before.isPdfNoInternalTags).toBe(false);
    expect(before.tags).toMatchObject({
      series: 'The Sandman',
      publisher: 'Vertigo',
      writer: 'Neil Gaiman',
      penciller: 'Sam Kieth',
      year: '1989',
      volume: '1',
      number: '1',
      title: 'Sleep of the Just',
      genre: 'Dark Fantasy',
      language: 'en',
    });
    expect(before.unwantedTags.ScanInformation).toBe(
      'Scanned by PirateScansGroup'
    );
    expect(before.unwantedTags.Web).toBe('https://piratescans.example.org');

    const destCbz = path.join(
      ws.libraryDirs.comics,
      'Vertigo/The Sandman (1989)/The Sandman #001 - Sleep of the Just.cbz'
    );

    const outPath = await processComicOrMangaFile({
      sourcePath: srcCbz,
      destinationPath: destCbz,
      tags: before.tags,
      removeSourceAfterWrite: true,
    });

    expect(outPath).toBe(destCbz);
    expect(fs.existsSync(srcCbz)).toBe(false);

    const after = await inspectComicOrMangaFile(destCbz, comicTags);
    expect(after.tags.series).toBe('The Sandman');
    expect(after.unwantedTags).toEqual({});
  });

  it('converts CBR archive to CBZ with sequential page numbering and clean ComicInfo.xml', async () => {
    const srcCbr = ws.copyFixture(
      'comics/sample.cbr',
      path.join(ws.downloadsDir, 'sandman_cbr/issue01.cbr')
    );

    const before = await inspectComicOrMangaFile(srcCbr, comicTags);
    expect(before.needsConversionToCbz).toBe(true);
    expect(before.tags.series).toBe('The Sandman');

    const destPath = path.join(
      ws.libraryDirs.comics,
      'Vertigo/The Sandman (1989)/The Sandman #001.cbr'
    );
    const finalCbzPath = await processComicOrMangaFile({
      sourcePath: srcCbr,
      destinationPath: destPath,
      tags: {
        series: 'The Sandman',
        publisher: 'Vertigo',
        year: '1989',
        number: '1',
      },
      removeSourceAfterWrite: true,
    });

    expect(finalCbzPath.endsWith('.cbz')).toBe(true);
    expect(fs.existsSync(finalCbzPath)).toBe(true);

    const zip = new AdmZip(finalCbzPath);
    const entries = zip.getEntries().map((e) => e.entryName);
    expect(entries).toContain('0001.png');
    expect(entries).toContain('0002.jpg');
    expect(entries).toContain('ComicInfo.xml');
  });

  it('converts Manga EPUB to CBZ following <spine> reading order instead of alphabetical order', async () => {
    const srcEpub = ws.copyFixture(
      'comics/sample_manga.epub',
      path.join(ws.downloadsDir, 'berserk/vol01.epub')
    );

    const before = await inspectComicOrMangaFile(srcEpub, mangaTags);
    expect(before.needsConversionToCbz).toBe(true);
    expect(before.tags).toMatchObject({
      series: 'Berserk',
      writer: 'Kentaro Miura',
      publisher: 'Hakusensha',
      year: '1989',
      language: 'pt',
      genre: 'Seinen',
    });
    expect(before.unwantedTags['dc:description']).toBe(
      'Unwanted Manga Promo Text'
    );

    const destCbz = path.join(
      ws.libraryDirs.manga,
      'Berserk/Vol. 01/Berserk - Vol. 01 Cap. 001.cbz'
    );

    await processComicOrMangaFile({
      sourcePath: srcEpub,
      destinationPath: destCbz,
      tags: {
        ...before.tags,
        volume: '1',
        number: '1',
        title: 'O Espadachim Negro',
      },
      removeSourceAfterWrite: true,
    });

    const zip = new AdmZip(destCbz);
    // In sample_manga.epub, spine item 1 points to z_page_one.png (PNG) and spine item 2 points to a_page_two.jpg (JPG)
    const firstPage = zip.getEntry('0001.png');
    const secondPage = zip.getEntry('0002.jpg');
    expect(firstPage).toBeDefined();
    expect(secondPage).toBeDefined();
    expect(
      firstPage!
        .getData()
        .equals(fs.readFileSync(path.join(FIXTURES_DIR, 'extras/cover_highres.png')))
    ).toBe(true);
    expect(
      secondPage!
        .getData()
        .equals(fs.readFileSync(path.join(FIXTURES_DIR, 'extras/cover_highres.jpg')))
    ).toBe(true);

    const xmlText = zip.getEntry('ComicInfo.xml')!.getData().toString('utf8');
    const parsed = parseComicInfoXml(xmlText, mangaTags);
    expect(parsed.tags.title).toBe('O Espadachim Negro');
    expect(parsed.unwantedTags).toEqual({});
  });

  it('handles PDF comics/manga by organizing path and filename only without modifying internal bytes', async () => {
    const srcPdf = ws.copyFixture(
      'books/sample_document.pdf',
      path.join(ws.downloadsDir, 'akira/akira_v1.pdf')
    );
    const originalBytes = fs.readFileSync(srcPdf);

    const before = await inspectComicOrMangaFile(srcPdf, mangaTags);
    expect(before.isPdfNoInternalTags).toBe(true);
    expect(before.needsConversionToCbz).toBe(false);

    const destPdf = path.join(
      ws.libraryDirs.manga,
      'Akira/Vol. 01/Akira - Vol. 01 Cap. 001.pdf'
    );
    const outPath = await processComicOrMangaFile({
      sourcePath: srcPdf,
      destinationPath: destPdf,
      tags: { series: 'Akira', volume: '1', number: '1' },
      removeSourceAfterWrite: true,
    });

    expect(outPath).toBe(destPdf);
    expect(fs.readFileSync(destPdf).equals(originalBytes)).toBe(true);
  });
});
