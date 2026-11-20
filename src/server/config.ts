import path from 'path';
import { MediaType } from '../shared/types.js';
import { MEDIA_TYPES_CONFIG } from '../shared/constants.js';

export function getConfigDir(): string {
  return process.env.CONFIG_DIR || path.resolve(process.cwd(), 'data/config');
}

export function getDownloadsDir(): string {
  return process.env.DOWNLOADS_DIR || path.resolve(process.cwd(), 'data/downloads');
}

export function getLibraryDir(mediaType: MediaType): string {
  const cfg = MEDIA_TYPES_CONFIG[mediaType];
  return (
    process.env[cfg.mountEnv] ||
    path.resolve(process.cwd(), 'data/library', mediaType)
  );
}

export function getAllMountPaths(): Record<'downloads' | MediaType, string> {
  return {
    downloads: getDownloadsDir(),
    music: getLibraryDir('music'),
    audiobooks: getLibraryDir('audiobooks'),
    books: getLibraryDir('books'),
    comics: getLibraryDir('comics'),
    manga: getLibraryDir('manga'),
    movies: getLibraryDir('movies'),
    series: getLibraryDir('series'),
  };
}
