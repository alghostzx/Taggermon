import fs from 'fs';
import path from 'path';
import os from 'os';
import { closeDb } from '../src/server/db.js';

export const FIXTURES_DIR = path.resolve(process.cwd(), 'tests/fixtures');

export interface TestWorkspace {
  rootDir: string;
  configDir: string;
  downloadsDir: string;
  libraryDirs: {
    music: string;
    audiobooks: string;
    books: string;
    comics: string;
    manga: string;
    movies: string;
    series: string;
  };
  copyFixture: (fixtureRelativePath: string, targetAbsolutePath: string) => string;
  cleanup: () => void;
}

export function createTestWorkspace(prefix = 'taggermon-ws-'): TestWorkspace {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(rootDir, 'config');
  const downloadsDir = path.join(rootDir, 'downloads');
  const libraryDirs = {
    music: path.join(rootDir, 'library/music'),
    audiobooks: path.join(rootDir, 'library/audiobooks'),
    books: path.join(rootDir, 'library/books'),
    comics: path.join(rootDir, 'library/comics'),
    manga: path.join(rootDir, 'library/manga'),
    movies: path.join(rootDir, 'library/movies'),
    series: path.join(rootDir, 'library/series'),
  };

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  for (const d of Object.values(libraryDirs)) {
    fs.mkdirSync(d, { recursive: true });
  }

  process.env.CONFIG_DIR = configDir;
  process.env.DOWNLOADS_DIR = downloadsDir;
  process.env.LIBRARY_MUSIC_DIR = libraryDirs.music;
  process.env.LIBRARY_AUDIOBOOKS_DIR = libraryDirs.audiobooks;
  process.env.LIBRARY_BOOKS_DIR = libraryDirs.books;
  process.env.LIBRARY_COMICS_DIR = libraryDirs.comics;
  process.env.LIBRARY_MANGA_DIR = libraryDirs.manga;
  process.env.LIBRARY_MOVIES_DIR = libraryDirs.movies;
  process.env.LIBRARY_SERIES_DIR = libraryDirs.series;

  closeDb();

  const copyFixture = (
    fixtureRelativePath: string,
    targetAbsolutePath: string
  ): string => {
    const src = path.join(FIXTURES_DIR, fixtureRelativePath);
    fs.mkdirSync(path.dirname(targetAbsolutePath), { recursive: true });
    fs.copyFileSync(src, targetAbsolutePath);
    return targetAbsolutePath;
  };

  const cleanup = () => {
    closeDb();
    fs.rmSync(rootDir, { recursive: true, force: true });
  };

  return {
    rootDir,
    configDir,
    downloadsDir,
    libraryDirs,
    copyFixture,
    cleanup,
  };
}
