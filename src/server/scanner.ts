import fs from 'fs';
import path from 'path';
import {
  ClusterScanResult,
  ExtraFileAction,
  ExtraFileItem,
  MediaFileItem,
  MediaType,
} from '../shared/types.js';
import { getDownloadsDir, getLibraryDir } from './config.js';
import { getTemplateByMediaType } from './db.js';
import {
  inspectAudioFile,
  inspectImageFile,
} from './processors/audioProcessor.js';
import { inspectComicOrMangaFile } from './processors/comicProcessor.js';
import { inspectBookFile } from './processors/bookProcessor.js';
import {
  extractEpisodeMarker,
  inspectVideoContainerTags,
  matchSubtitlesToVideos,
  SUBTITLE_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from './processors/videoProcessor.js';
import { formatDestinationRelativePath } from './templateEngine.js';

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.m4b',
  '.ogg',
  '.opus',
  '.wav',
  '.aac',
]);

const COMIC_EXTENSIONS = new Set(['.cbz', '.cbr']);
const BOOK_ONLY_EXTENSIONS = new Set(['.mobi', '.azw3']);
const SHARED_BOOK_COMIC_EXTENSIONS = new Set(['.epub', '.pdf']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export interface FolderTreeItem {
  name: string;
  relativePath: string;
  hasSubfolders: boolean;
  fileCount: number;
  suggestedMediaType?: MediaType;
}

export function getRootDirForSource(sourceRoot: 'downloads' | MediaType): string {
  if (sourceRoot === 'downloads') {
    return getDownloadsDir();
  }
  return getLibraryDir(sourceRoot);
}

/**
 * Safely resolves a relative path inside a root directory, preventing path traversal.
 */
export function resolveSafePath(rootDir: string, relativePath: string): string {
  const cleanRel = relativePath.replace(/^[/\\]+/, '');
  const resolved = path.resolve(rootDir, cleanRel);
  const normalizedRoot = path.resolve(rootDir);
  if (
    resolved !== normalizedRoot &&
    !resolved.startsWith(normalizedRoot + path.sep)
  ) {
    throw new Error(`Invalid path traversal attempt: ${relativePath}`);
  }
  return resolved;
}

/**
 * Lists directories (and standalone root files in downloads wrapped or listed as clusters) inside a source root.
 */
export function listFolderClusters(
  sourceRoot: 'downloads' | MediaType,
  parentRelativePath = ''
): FolderTreeItem[] {
  const rootDir = getRootDirForSource(sourceRoot);
  fs.mkdirSync(rootDir, { recursive: true });
  const targetDir = resolveSafePath(rootDir, parentRelativePath);
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return [];
  }

  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  const folders: FolderTreeItem[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(targetDir, entry.name);
    const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      const subEntries = safeReaddir(fullPath);
      const hasSubfolders = subEntries.some(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith('.') &&
          e.name.toLowerCase() !== 'subs' &&
          e.name.toLowerCase() !== 'subtitles'
      );
      const allFiles = collectAllFilesRelative(fullPath);
      const guessed =
        sourceRoot === 'downloads'
          ? detectMediaTypeHeuristic(entry.name, allFiles).mediaType
          : sourceRoot;

      folders.push({
        name: entry.name,
        relativePath: relPath,
        hasSubfolders,
        fileCount: allFiles.length,
        suggestedMediaType: guessed,
      });
    }
  }

  return folders.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true })
  );
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function collectAllFilesRelative(baseDir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(baseDir)) return results;

  function walk(curr: string) {
    for (const entry of safeReaddir(curr)) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(curr, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        results.push(path.relative(baseDir, full).replace(/\\/g, '/'));
      }
    }
  }

  walk(baseDir);
  return results.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

/**
 * Heuristically detects the media type of a folder cluster from its name and file extensions.
 */
export function detectMediaTypeHeuristic(
  clusterName: string,
  relativeFiles: string[]
): { mediaType: MediaType; confidence: number } {
  const exts = relativeFiles.map((f) => path.extname(f).toLowerCase());
  const lowerName = clusterName.toLowerCase();

  // 1. Check Audio
  if (exts.includes('.m4b') || /audiobook|audiolivro|narrat/i.test(lowerName)) {
    if (exts.some((e) => AUDIO_EXTENSIONS.has(e))) {
      return { mediaType: 'audiobooks', confidence: 0.95 };
    }
  }
  if (exts.some((e) => AUDIO_EXTENSIONS.has(e))) {
    return { mediaType: 'music', confidence: 0.9 };
  }

  // 2. Check Video (Movies vs Series)
  const videoFiles = relativeFiles.filter((f) =>
    VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase())
  );
  if (videoFiles.length > 0) {
    const hasEpisodeMarker =
      videoFiles.some((f) => extractEpisodeMarker(f) !== null) ||
      /\b(s\d{1,2}|season\s*\d+|temporada\s*\d+|complete\s*series)\b/i.test(
        lowerName
      );
    if (hasEpisodeMarker || videoFiles.length > 2) {
      return { mediaType: 'series', confidence: 0.92 };
    }
    return { mediaType: 'movies', confidence: 0.9 };
  }

  // 3. Check Comics vs Manga
  const mangaPattern =
    /(?:^|[\s._-])(cap\.?|capítulo|capitulo|ch\.?|chapter|manga|mangá)(?:$|[\s._-]|\d)/i;
  if (exts.some((e) => COMIC_EXTENSIONS.has(e))) {
    if (
      mangaPattern.test(lowerName) ||
      relativeFiles.some((f) => mangaPattern.test(f))
    ) {
      return { mediaType: 'manga', confidence: 0.88 };
    }
    return { mediaType: 'comics', confidence: 0.85 };
  }

  // 4. Check Books vs Manga/Comics for .epub / .mobi / .pdf
  if (exts.some((e) => BOOK_ONLY_EXTENSIONS.has(e))) {
    return { mediaType: 'books', confidence: 0.95 };
  }
  if (exts.some((e) => SHARED_BOOK_COMIC_EXTENSIONS.has(e))) {
    if (
      mangaPattern.test(lowerName) ||
      relativeFiles.some((f) => mangaPattern.test(f))
    ) {
      return { mediaType: 'manga', confidence: 0.8 };
    }
    if (/(?:^|[\s._-])(issue|comic|hq|#\d+)/i.test(lowerName)) {
      return { mediaType: 'comics', confidence: 0.8 };
    }
    return { mediaType: 'books', confidence: 0.85 };
  }

  return { mediaType: 'music', confidence: 0.5 };
}

function isMediaFileForType(ext: string, mediaType: MediaType): boolean {
  const e = ext.toLowerCase();
  switch (mediaType) {
    case 'music':
    case 'audiobooks':
      return AUDIO_EXTENSIONS.has(e);
    case 'books':
      return e === '.epub' || e === '.mobi' || e === '.azw3' || e === '.pdf';
    case 'comics':
    case 'manga':
      return e === '.cbz' || e === '.cbr' || e === '.epub' || e === '.pdf';
    case 'movies':
    case 'series':
      return VIDEO_EXTENSIONS.has(e);
  }
}

/**
 * Performs a deep scan of a specific cluster folder, reading existing internal tags,
 * unwanted tags, extra files (with image dimensions/quality), and matching subtitles.
 */
export async function scanClusterFolder(options: {
  sourceRoot: 'downloads' | MediaType;
  clusterRelativePath: string;
  overrideMediaType?: MediaType;
}): Promise<ClusterScanResult> {
  const { sourceRoot, clusterRelativePath, overrideMediaType } = options;
  const rootDir = getRootDirForSource(sourceRoot);
  const clusterFullPath = resolveSafePath(rootDir, clusterRelativePath);

  if (!fs.existsSync(clusterFullPath)) {
    throw new Error(`Cluster folder not found: ${clusterRelativePath}`);
  }

  const clusterName = path.basename(clusterFullPath);
  const allRelativeFiles = collectAllFilesRelative(clusterFullPath);

  const heuristic =
    sourceRoot !== 'downloads'
      ? { mediaType: sourceRoot, confidence: 1 }
      : detectMediaTypeHeuristic(clusterName, allRelativeFiles);

  const activeMediaType = overrideMediaType || heuristic.mediaType;
  const template = getTemplateByMediaType(activeMediaType);
  const allowedTags = template.requiredTags;
  const whitelistedExtra = template.whitelistedExtraTags;

  const mediaFiles: MediaFileItem[] = [];
  const extraFiles: ExtraFileItem[] = [];
  const subtitleRelativePaths: string[] = [];

  for (const relFile of allRelativeFiles) {
    const fullFile = path.join(clusterFullPath, relFile);
    const stat = fs.statSync(fullFile);
    const extWithDot = path.extname(relFile).toLowerCase();
    const ext = extWithDot.replace(/^\./, '');
    const filename = path.basename(relFile);

    if (isMediaFileForType(extWithDot, activeMediaType)) {
      if (activeMediaType === 'music' || activeMediaType === 'audiobooks') {
        const info = await inspectAudioFile(
          fullFile,
          activeMediaType,
          allowedTags,
          whitelistedExtra
        );
        mediaFiles.push({
          relativePath: relFile,
          filename,
          ext,
          sizeBytes: stat.size,
          tags: info.tags,
          unwantedTags: info.unwantedTags,
          hasEmbeddedCover: info.hasEmbeddedCover,
          embeddedCoverMime: info.embeddedCoverMime,
        });
      } else if (activeMediaType === 'comics' || activeMediaType === 'manga') {
        const info = await inspectComicOrMangaFile(
          fullFile,
          allowedTags,
          whitelistedExtra
        );
        mediaFiles.push({
          relativePath: relFile,
          filename,
          ext,
          sizeBytes: stat.size,
          tags: info.tags,
          unwantedTags: info.unwantedTags,
          needsConversionToCbz: info.needsConversionToCbz,
          isPdfNoInternalTags: info.isPdfNoInternalTags,
        });
      } else if (activeMediaType === 'books') {
        const info = await inspectBookFile(
          fullFile,
          allowedTags,
          whitelistedExtra
        );
        mediaFiles.push({
          relativePath: relFile,
          filename,
          ext,
          sizeBytes: stat.size,
          tags: info.tags,
          unwantedTags: info.unwantedTags,
          hasEmbeddedCover: info.hasEmbeddedCover,
          isPdfNoInternalTags: info.isPdfNoInternalTags,
        });
      } else {
        // movies or series: no tag editing, only container tag inspection & path/filename tags
        const containerTags = await inspectVideoContainerTags(fullFile);
        const autoExtracted = autoGuessVideoTagsFromFilename(
          activeMediaType,
          clusterName,
          filename
        );
        mediaFiles.push({
          relativePath: relFile,
          filename,
          ext,
          sizeBytes: stat.size,
          tags: autoExtracted,
          unwantedTags: containerTags,
        });
      }
    } else if (
      (activeMediaType === 'movies' || activeMediaType === 'series') &&
      SUBTITLE_EXTENSIONS.has(extWithDot)
    ) {
      subtitleRelativePaths.push(relFile);
    } else {
      const isImg = IMAGE_EXTENSIONS.has(extWithDot);
      const imgInfo = isImg ? inspectImageFile(fullFile) : null;
      let defaultAction: ExtraFileAction = 'ignore';
      if (
        isImg &&
        (activeMediaType === 'music' || activeMediaType === 'audiobooks') &&
        /^(folder|cover|front)\.(jpg|jpeg|png)$/i.test(filename)
      ) {
        defaultAction = 'use_as_cover';
      } else if (['.cue', '.log'].includes(extWithDot)) {
        defaultAction = 'move';
      }

      extraFiles.push({
        relativePath: relFile,
        filename,
        ext,
        sizeBytes: stat.size,
        isImage: isImg,
        imageWidth: imgInfo?.width,
        imageHeight: imgInfo?.height,
        imageFormat: imgInfo?.format,
        defaultAction,
      });
    }
  }

  // Ensure only one extra image defaults to `use_as_cover`
  let foundCoverDefault = false;
  for (const extra of extraFiles) {
    if (extra.defaultAction === 'use_as_cover') {
      if (!foundCoverDefault) {
        foundCoverDefault = true;
      } else {
        extra.defaultAction = 'ignore';
      }
    }
  }
  if (
    !foundCoverDefault &&
    (activeMediaType === 'music' || activeMediaType === 'audiobooks')
  ) {
    const firstImg = extraFiles.find((e) => e.isImage);
    if (firstImg) {
      firstImg.defaultAction = 'use_as_cover';
    }
  }

  const subtitles =
    activeMediaType === 'movies' || activeMediaType === 'series'
      ? matchSubtitlesToVideos(
          mediaFiles.map((m) => m.relativePath),
          subtitleRelativePaths
        )
      : [];

  return {
    sourceRoot,
    clusterRelativePath,
    clusterName,
    detectedMediaType: activeMediaType,
    detectionConfidence: heuristic.confidence,
    mediaFiles,
    extraFiles,
    subtitles,
  };
}

function autoGuessVideoTagsFromFilename(
  mediaType: 'movies' | 'series',
  clusterName: string,
  filename: string
): Record<string, string> {
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  const tags: Record<string, string> = {};

  const resMatch = base.match(/\b(2160p|1080p|720p|480p|4K)\b/i);
  if (resMatch) {
    tags.resolution = resMatch[1];
  }

  if (mediaType === 'series') {
    const seMatch = base.match(
      /^(.*?)[.\s_-]+[Ss](\d{1,2})[Ee](\d{1,3})(?:[.\s_-]+(.*))?$/
    );
    if (seMatch) {
      const rawSeries = seMatch[1].replace(/[._]/g, ' ').trim();
      if (rawSeries) tags.series = rawSeries;
      tags.season = String(parseInt(seMatch[2], 10));
      tags.episode = String(parseInt(seMatch[3], 10));
    }
    if (!tags.series) {
      tags.series = clusterName
        .replace(/[._]/g, ' ')
        .replace(/\b(S\d{1,2}.*|Season\s*\d+.*)$/i, '')
        .trim();
    }
  } else {
    const movieMatch = base.match(/^(.+?)[.\s_(]+((?:19|20)\d{2})\b/);
    if (movieMatch) {
      tags.title = movieMatch[1].replace(/[._]/g, ' ').trim();
      tags.year = movieMatch[2];
    } else {
      tags.title = base.replace(/[._]/g, ' ').trim();
    }
  }

  return tags;
}

/**
 * Preview destination paths for a list of files given a template and current tag state.
 */
export function previewClusterDestinations(options: {
  mediaType: MediaType;
  pathTemplate: string;
  filenameTemplate: string;
  files: Array<{
    relativePath: string;
    ext: string;
    tags: Record<string, string>;
  }>;
  convertMobiToEpub?: boolean;
}): Array<{
  relativePath: string;
  destinationDirectory: string;
  destinationFilename: string;
  destinationFullRelativePath: string;
}> {
  const {
    mediaType,
    pathTemplate,
    filenameTemplate,
    files,
    convertMobiToEpub = false,
  } = options;

  return files.map((f) => {
    let targetExt = f.ext.toLowerCase().replace(/^\./, '');
    if (
      (mediaType === 'comics' || mediaType === 'manga') &&
      (targetExt === 'cbr' || targetExt === 'epub')
    ) {
      targetExt = 'cbz';
    } else if (
      mediaType === 'books' &&
      convertMobiToEpub &&
      (targetExt === 'mobi' || targetExt === 'azw3')
    ) {
      targetExt = 'epub';
    }

    const formatted = formatDestinationRelativePath(
      pathTemplate,
      filenameTemplate,
      f.tags,
      targetExt
    );

    return {
      relativePath: f.relativePath,
      destinationDirectory: formatted.directory,
      destinationFilename: formatted.filename,
      destinationFullRelativePath: formatted.fullRelativePath,
    };
  });
}

/**
 * Removes empty directories recursively up to `stopAtRootDir`.
 */
export function cleanupEmptyDirectoriesUpwards(
  startDir: string,
  stopAtRootDir: string
): void {
  const normalizedRoot = path.resolve(stopAtRootDir);
  let current = path.resolve(startDir);

  while (
    current !== normalizedRoot &&
    current.startsWith(normalizedRoot + path.sep)
  ) {
    if (!fs.existsSync(current)) {
      current = path.dirname(current);
      continue;
    }
    const entries = fs.readdirSync(current);
    if (entries.length === 0) {
      try {
        fs.rmdirSync(current);
      } catch {
        break;
      }
      current = path.dirname(current);
    } else {
      break;
    }
  }
}
