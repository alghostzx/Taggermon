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

  it('reads and persists custom template tags like dc:description and calibre meta tags without classifying them as unwanted', async () => {
    const srcEpub = ws.copyFixture(
      'books/sample_book.epub',
      path.join(ws.downloadsDir, 'asimov_desc/fundacao.epub')
    );

    const customBookTags = [...bookTags, 'dc:description', 'dc:rights'];
    const destWithDesc = path.join(
      ws.libraryDirs.books,
      'Isaac Asimov/Fundação (1951).epub'
    );

    // 1. Inspect with dc:rights in template -> should be in tags, not unwantedTags
    const initial = await inspectBookFile(srcEpub, customBookTags);
    expect(initial.tags['dc:rights']).toBe('Unwanted Copyright Watermark');
    expect(initial.unwantedTags['dc:rights']).toBeUndefined();

    // 2. Write dc:description into EPUB via processBookFile
    await processBookFile({
      sourcePath: srcEpub,
      destinationPath: destWithDesc,
      tags: {
        ...initial.tags,
        'dc:description': 'O Império Galáctico está em decadência.',
      },
      removeSourceAfterWrite: false,
    });

    // 3. Re-inspect with dc:description in template -> populated in tags['dc:description'], NOT in unwantedTags
    const afterWithTemplate = await inspectBookFile(
      destWithDesc,
      customBookTags
    );
    expect(afterWithTemplate.tags['dc:description']).toBe(
      'O Império Galáctico está em decadência.'
    );
    expect(afterWithTemplate.unwantedTags['dc:description']).toBeUndefined();

    // 4. Re-inspect with 'description' alias in template -> populated in tags.description
    const afterWithAlias = await inspectBookFile(destWithDesc, [
      ...bookTags,
      'description',
    ]);
    expect(afterWithAlias.tags.description).toBe(
      'O Império Galáctico está em decadência.'
    );
    expect(afterWithAlias.unwantedTags['dc:description']).toBeUndefined();

    // 5. Re-inspect WITHOUT dc:description in template -> appears in unwantedTags
    const afterWithoutTemplate = await inspectBookFile(destWithDesc, bookTags);
    expect(afterWithoutTemplate.tags['dc:description']).toBeUndefined();
    expect(afterWithoutTemplate.unwantedTags['dc:description']).toBe(
      'O Império Galáctico está em decadência.'
    );
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
