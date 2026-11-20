import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  sanitizeSegment,
  renderTemplate,
  formatDestinationRelativePath,
  parseTagsFromPattern,
  deduceTemplateFromSample,
  sampleFilesFromLibrary,
  aggregateTemplateSuggestions,
} from '../../src/server/templateEngine.js';

describe('Unit: Template Engine & Heuristic Library Sampler', () => {
  it('sanitizes forbidden filesystem characters while keeping accents, spaces, and punctuation', () => {
    expect(sanitizeSegment('AC/DC: Back*In?Black "Special" <1980>|Test')).toBe(
      'AC_DC_ Back_In_Black _Special_ _1980__Test'
    );
    expect(sanitizeSegment('  Coração   Valente (Edição Especial)  ')).toBe(
      'Coração Valente (Edição Especial)'
    );
  });

  it('renders tokens with numeric padding (:02, :03) and nested optional blocks [...]', () => {
    const tpl =
      '{author}/[{series}/[Vol. {series_part:02} - ]]{title} ({year})';
    expect(
      renderTemplate(tpl, {
        author: 'Isaac Asimov',
        series: 'Fundação',
        series_part: '1',
        title: 'Prelúdio à Fundação',
        year: '1988',
      })
    ).toBe('Isaac Asimov/Fundação/Vol. 01 - Prelúdio à Fundação (1988)');

    // Without series_part, inner block [Vol. {series_part:02} - ] collapses while outer [{series}/...] stays
    expect(
      renderTemplate(tpl, {
        author: 'Isaac Asimov',
        series: 'Fundação',
        title: 'Prelúdio à Fundação',
        year: '1988',
      })
    ).toBe('Isaac Asimov/Fundação/Prelúdio à Fundação (1988)');

    // Without series, entire optional directory block collapses
    expect(
      renderTemplate(tpl, {
        author: 'Isaac Asimov',
        title: 'O Fim da Eternidade',
        year: '1955',
      })
    ).toBe('Isaac Asimov/O Fim da Eternidade (1955)');
  });

  it('formats full destination relative path for all 7 media types', () => {
    const mangaDest = formatDestinationRelativePath(
      '{series}[/Vol. {volume:02}]',
      '{series} - [Vol. {volume:02} ]Cap. {number:03}[ - {title}].{ext}',
      {
        series: 'Berserk',
        volume: '12',
        number: '95',
        title: 'Eclipse',
      },
      '.cbz'
    );
    expect(mangaDest.directory).toBe('Berserk/Vol. 12');
    expect(mangaDest.filename).toBe('Berserk - Vol. 12 Cap. 095 - Eclipse.cbz');
    expect(mangaDest.fullRelativePath).toBe(
      'Berserk/Vol. 12/Berserk - Vol. 12 Cap. 095 - Eclipse.cbz'
    );
  });

  it('parses tags from filenames and paths with optional blocks and duplicate tokens', () => {
    expect(
      parseTagsFromPattern(
        'Berserk/Vol. 03/Berserk - Vol. 03 Cap. 025 - A Hora',
        '{series}[/Vol. {volume:02}]/{series} - [Vol. {volume:02} ]Cap. {number:03}[ - {title}]'
      )
    ).toEqual({
      series: 'Berserk',
      volume: '3',
      number: '25',
      title: 'A Hora',
    });

    expect(
      parseTagsFromPattern(
        '02-09 - Comfortably Numb.flac',
        '[{disc:02}-]{track:02} - {title}.{ext}'
      )
    ).toEqual({
      disc: '2',
      track: '9',
      title: 'Comfortably Numb',
    });

    // Returns null on empty pattern or non-matching string
    expect(parseTagsFromPattern('anything', '')).toBeNull();
    expect(
      parseTagsFromPattern('random_name', 'S{season:02}E{episode:02}')
    ).toBeNull();
  });

  it('heuristically deduces templates from samples across all 7 media types', () => {
    // 1. Music with internal tags
    const music = deduceTemplateFromSample(
      'music',
      'Pink Floyd/1973 - The Dark Side of the Moon/01-04 - Time.flac',
      {
        album_artist: 'Pink Floyd',
        year: '1973',
        album: 'The Dark Side of the Moon',
        disc: '1',
        track: '4',
        title: 'Time',
      }
    );
    expect(music.pathTemplate).toBe('{album_artist}/{year} - {album}');
    expect(music.filenameTemplate).toBe('{disc:02}-{track:02} - {title}.{ext}');

    // 2. Music without internal tags (structural fallback)
    const musicUntagged = deduceTemplateFromSample(
      'music',
      'Metallica/Master of Puppets (1986)/01-02 - Master of Puppets.mp3',
      {}
    );
    expect(musicUntagged.pathTemplate).toBe('{album_artist}/{album} ({year})');
    expect(musicUntagged.filenameTemplate).toBe(
      '[{disc:02}-]{track:02} - {title}.{ext}'
    );

    // 3. Audiobooks
    const audiobook = deduceTemplateFromSample(
      'audiobooks',
      'J.R.R. Tolkien/The Fellowship of the Ring (1954).m4b',
      {}
    );
    expect(audiobook.pathTemplate).toBe('{author}');
    expect(audiobook.filenameTemplate).toBe('{title} ({year}).{ext}');

    // 4. Books (PDF without internal tags)
    const bookPdf = deduceTemplateFromSample(
      'books',
      'Frank Herbert/Duna (1965).pdf',
      {}
    );
    expect(bookPdf.pathTemplate).toBe('{author}');
    expect(bookPdf.filenameTemplate).toBe('{title} ({year}).{ext}');

    // 5. Manga & Comics (both standard Cap. pattern and real-world "{series} - {writer}/{series} - Vol. {number:02} - {writer}.cbz")
    const manga = deduceTemplateFromSample(
      'manga',
      'One Piece/Vol. 01/One Piece - Vol. 01 Cap. 001 - Romance Dawn.cbz',
      {}
    );
    expect(manga.pathTemplate).toBe('{series}/Vol. {volume:02}');
    expect(manga.filenameTemplate).toBe(
      '{series} - [Vol. {volume:02} ]Cap. {number:03}[ - {title}].{ext}'
    );

    const realWorldManga = deduceTemplateFromSample(
      'manga',
      'Death Note - Tsugumi Ohba/Death Note - Vol. 07 - Tsugumi Ohba.cbz',
      {
        title: 'Death Note - Vol. 07',
        series: 'Death Note',
        number: '07',
        count: '13',
        writer: 'Tsugumi Ohba',
        publisher: 'JBC',
        language: 'pt-BR',
      }
    );
    expect(realWorldManga.pathTemplate).toBe('{series} - {writer}');
    expect(realWorldManga.filenameTemplate).toBe(
      '{series} - Vol. {number:02} - {writer}.{ext}'
    );

    // 6. Movies
    const movie = deduceTemplateFromSample(
      'movies',
      'Blade Runner (1982)/Blade Runner (1982) - 1080p.mkv',
      {}
    );
    expect(movie.pathTemplate).toBe('{title} ({year})');
    expect(movie.filenameTemplate).toBe(
      '{title} ({year})[ - {resolution}].{ext}'
    );

    // 7. Series
    const series = deduceTemplateFromSample(
      'series',
      'Severance/Temporada 01/Severance - S01E01 - Good News.mkv',
      {}
    );
    expect(series.pathTemplate).toBe('{series}/Temporada {season:02}');
    expect(series.filenameTemplate).toBe(
      '{series} - S{season:02}E{episode:02}[ - {title}].{ext}'
    );
  });

  it('aggregates and ranks multiple template suggestions by confidence', () => {
    // Empty sample list returns default template with confidence 1
    const emptySug = aggregateTemplateSuggestions('movies', []);
    expect(emptySug).toHaveLength(1);
    expect(emptySug[0].totalSampled).toBe(0);

    const ranked = aggregateTemplateSuggestions('movies', [
      {
        relativePath: 'The Matrix (1999)/The Matrix (1999) - 1080p.mkv',
        tags: {},
      },
      {
        relativePath: 'Inception (2010)/Inception (2010) - 2160p.mkv',
        tags: {},
      },
      {
        relativePath: 'Arrival (2016)/Arrival (2016).mp4',
        tags: {},
      },
    ]);

    expect(ranked).toHaveLength(2);
    expect(ranked[0].matchCount).toBe(2);
    expect(ranked[0].confidence).toBe(0.67);
    expect(ranked[0].filenameTemplate).toBe(
      '{title} ({year})[ - {resolution}].{ext}'
    );
    expect(ranked[1].matchCount).toBe(1);
  });

  it('performs uniform random reservoir sampling across the entire library', () => {
    const tmpLib = fs.mkdtempSync(path.join(os.tmpdir(), 'taggermon-unit-rnd-'));
    try {
      for (let i = 1; i <= 12; i++) {
        const dir = path.join(tmpLib, `Folder_${String(i).padStart(2, '0')}`);
        fs.mkdirSync(dir, { recursive: true });
        for (let j = 1; j <= 10; j++) {
          fs.writeFileSync(
            path.join(dir, `Item_${String(j).padStart(2, '0')}.mp3`),
            'x'
          );
        }
      }

      const s1 = sampleFilesFromLibrary(tmpLib, new Set(['mp3']), 20);
      const s2 = sampleFilesFromLibrary(tmpLib, new Set(['mp3']), 20);

      expect(s1).toHaveLength(20);
      expect(s2).toHaveLength(20);
      expect(new Set(s1).size).toBe(20);
      expect(s1.join(',')).not.toBe(s2.join(','));

      const foldersRepresented = new Set(s1.map((p) => p.split('/')[0]));
      expect(foldersRepresented.size).toBeGreaterThan(3);

      expect(sampleFilesFromLibrary('/non/existent/path', new Set(['mp3']))).toEqual(
        []
      );
      expect(sampleFilesFromLibrary(tmpLib, new Set(['mp3']), 0)).toEqual([]);
    } finally {
      fs.rmSync(tmpLib, { recursive: true, force: true });
    }
  });
});
