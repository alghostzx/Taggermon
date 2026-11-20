import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  inspectBookFile,
  processBookFile,
} from '../../src/server/processors/bookProcessor.js';
import { MEDIA_TYPES_CONFIG } from '../../src/shared/constants.js';
import {
  createTestWorkspace,
  FIXTURES_DIR,
  TestWorkspace,
} from '../test-helpers.js';

describe('Integration: Books Media Processor (.epub, .mobi, .pdf)', () => {
  let ws: TestWorkspace;
  const bookTags = MEDIA_TYPES_CONFIG.books.availableTags.map((t) => t.key);

  beforeEach(() => {
    ws = createTestWorkspace('taggermon-books-int-');
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('reads and updates EPUB OPF metadata, cleans unwanted tags, and embeds cover image', async () => {
    const srcEpub = ws.copyFixture(
      'books/sample_book.epub',
      path.join(ws.downloadsDir, 'asimov/fundacao.epub')
    );
    const coverPng = ws.copyFixture(
      'extras/cover_highres.png',
      path.join(ws.downloadsDir, 'asimov/cover.png')
    );

    const before = await inspectBookFile(srcEpub, bookTags);
    expect(before.isPdfNoInternalTags).toBe(false);
    expect(before.tags).toMatchObject({
      title: 'Fundação',
      author: 'Isaac Asimov',
      publisher: 'Aleph',
      year: '1951',
      language: 'pt-BR',
      genre: 'Sci-Fi',
      isbn: '9788576570660',
      series: 'Série da Fundação',
      series_part: '1',
    });
    expect(before.unwantedTags['dc:rights']).toBe(
      'Unwanted Copyright Watermark'
    );
    expect(before.unwantedTags['calibre:user_metadata']).toBe(
      'unwanted_calibre_blob'
    );

    const destEpub = path.join(
      ws.libraryDirs.books,
      'Isaac Asimov/Série da Fundação/Série da Fundação 01 - Fundação (1951).epub'
    );

    await processBookFile({
      sourcePath: srcEpub,
      destinationPath: destEpub,
      tags: {
        ...before.tags,
        title: 'Fundação (Edição Revisada)',
      },
      coverImagePath: coverPng,
      removeSourceAfterWrite: true,
    });

    expect(fs.existsSync(srcEpub)).toBe(false);
    expect(fs.existsSync(destEpub)).toBe(true);

    const after = await inspectBookFile(destEpub, bookTags);
    expect(after.tags.title).toBe('Fundação (Edição Revisada)');
    expect(after.tags.series).toBe('Série da Fundação');
    expect(after.tags.isbn).toBe('9788576570660');
    expect(after.hasEmbeddedCover).toBe(true);
    expect(after.unwantedTags['dc:rights']).toBeUndefined();
    expect(after.unwantedTags['calibre:user_metadata']).toBeUndefined();
  });

  it('organizes MOBI and PDF books into target library folders', async () => {
    const srcMobi = ws.copyFixture(
      'books/sample_book.mobi',
      path.join(ws.downloadsDir, 'mobi/book.mobi')
    );
    const destMobi = path.join(
      ws.libraryDirs.books,
      'Isaac Asimov/Fundação (1951).mobi'
    );

    await processBookFile({
      sourcePath: srcMobi,
      destinationPath: destMobi,
      tags: {
        author: 'Isaac Asimov',
        title: 'Fundação',
        year: '1951',
      },
      removeSourceAfterWrite: true,
    });
    expect(fs.existsSync(destMobi)).toBe(true);

    // PDF: dispenses internal tags
    const srcPdf = ws.copyFixture(
      'books/sample_document.pdf',
      path.join(ws.downloadsDir, 'pdf/doc.pdf')
    );
    const pdfInspect = await inspectBookFile(srcPdf, bookTags);
    expect(pdfInspect.isPdfNoInternalTags).toBe(true);

    const destPdf = path.join(
      ws.libraryDirs.books,
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
});
