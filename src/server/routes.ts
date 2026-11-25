import fs from 'fs';
import path from 'path';
import os from 'os';
import { FastifyInstance } from 'fastify';
import {
  ALL_MEDIA_TYPES,
  MEDIA_TYPES_CONFIG,
} from '../shared/constants.js';
import {
  DiscoveredTagSuggestion,
  ExtraFileAction,
  MediaType,
  TemplateSuggestion,
} from '../shared/types.js';
import { getAllMountPaths, getLibraryDir } from './config.js';
import {
  getAllTemplates,
  getTemplateByMediaType,
  updateTemplate,
} from './db.js';
import {
  cleanupEmptyDirectoriesUpwards,
  collectAllFilesRelative,
  getRootDirForSource,
  listFolderClusters,
  previewClusterDestinations,
  resolveSafePath,
  scanClusterFolder,
} from './scanner.js';
import {
  aggregateTemplateSuggestions,
  formatDestinationRelativePath,
  parseTagsFromPattern,
  sampleFilesFromLibrary,
} from './templateEngine.js';
import {
  extractEmbeddedCoverFromAudio,
  inspectAudioFile,
  inspectImageBuffer,
  saveFolderCoverFile,
  writeAudioFileWithTagsAndCover,
} from './processors/audioProcessor.js';
import {
  inspectComicOrMangaFile,
  processComicOrMangaFile,
} from './processors/comicProcessor.js';
import {
  inspectBookFile,
  processBookFile,
} from './processors/bookProcessor.js';
import {
  processVideoAndSubtitles,
  VIDEO_EXTENSIONS,
} from './processors/videoProcessor.js';

export interface ProcessClusterPayload {
  sourceRoot: 'downloads' | MediaType;
  clusterRelativePath: string;
  targetMediaType: MediaType;
  pathTemplate?: string;
  filenameTemplate?: string;
  stripContainerTags?: boolean;
  convertMobiToEpub?: boolean;
  deleteIgnoredExtrasAndCleanupSource?: boolean;
  coverSelection?: {
    mode: 'none' | 'extra_file' | 'cov_url' | 'uploaded_base64';
    extraFileRelativePath?: string;
    covImageUrl?: string;
    uploadedBase64?: string;
  };
  files: Array<{
    relativePath: string;
    tags: Record<string, string>;
    preservedExtraTags?: Record<string, string>;
  }>;
  extraFiles?: Array<{
    relativePath: string;
    action: ExtraFileAction;
  }>;
  subtitles?: Array<{
    relativePath: string;
    matchedVideoRelativePath: string | null;
    languageCode: string;
    isForced: boolean;
    isSdh: boolean;
  }>;
}

export interface ProcessClusterResult {
  success: boolean;
  targetMediaType: MediaType;
  destinationRoot: string;
  processedFiles: Array<{
    sourceRelativePath: string;
    destinationRelativePath: string;
  }>;
  folderCoverSavedAs?: string;
  movedExtras: string[];
  deletedExtras: string[];
  sourceFolderRemoved: boolean;
}

/**
 * Executes a full cluster tagging, conversion, cover embedding, extra file handling,
 * subtitle renaming, and moving into the destination library.
 */
export async function executeProcessCluster(
  payload: ProcessClusterPayload
): Promise<ProcessClusterResult> {
  const {
    sourceRoot,
    clusterRelativePath,
    targetMediaType,
    stripContainerTags = true,
    convertMobiToEpub = false,
    deleteIgnoredExtrasAndCleanupSource = false,
    coverSelection,
    files,
    extraFiles = [],
    subtitles = [],
  } = payload;

  const sourceRootDir = getRootDirForSource(sourceRoot);
  const clusterFullPath = resolveSafePath(sourceRootDir, clusterRelativePath);
  if (!fs.existsSync(clusterFullPath)) {
    throw new Error(`Source cluster folder does not exist: ${clusterRelativePath}`);
  }

  const destLibraryRoot = getLibraryDir(targetMediaType);
  fs.mkdirSync(destLibraryRoot, { recursive: true });

  const savedTemplate = getTemplateByMediaType(targetMediaType);
  const pathTemplate = payload.pathTemplate || savedTemplate.pathTemplate;
  const filenameTemplate =
    payload.filenameTemplate || savedTemplate.filenameTemplate;

  // Prepare cover file in temporary location if selected via COV URL, base64 upload, or extra file
  let tempCoverFilePath: string | null = null;
  let coverBufferForFolder: Buffer | null = null;

  try {
    if (coverSelection && coverSelection.mode !== 'none') {
      if (
        coverSelection.mode === 'extra_file' &&
        coverSelection.extraFileRelativePath
      ) {
        const extraImgFull = resolveSafePath(
          clusterFullPath,
          coverSelection.extraFileRelativePath
        );
        if (fs.existsSync(extraImgFull)) {
          coverBufferForFolder = fs.readFileSync(extraImgFull);
        }
      } else if (
        coverSelection.mode === 'cov_url' &&
        coverSelection.covImageUrl
      ) {
        const resp = await fetch(coverSelection.covImageUrl, {
          headers: {
            'User-Agent': 'Taggermon/1.0 (+https://github.com/alghostzx/Taggermon)',
          },
        });
        if (!resp.ok) {
          throw new Error(
            `Failed to download cover from COV URL (${resp.status})`
          );
        }
        const arrBuf = await resp.arrayBuffer();
        coverBufferForFolder = Buffer.from(arrBuf);
      } else if (
        coverSelection.mode === 'uploaded_base64' &&
        coverSelection.uploadedBase64
      ) {
        const base64Clean = coverSelection.uploadedBase64.replace(
          /^data:image\/[a-zA-Z0-9+.-]+;base64,/,
          ''
        );
        coverBufferForFolder = Buffer.from(base64Clean, 'base64');
      }
    }

    // Check if any extraFile was marked `use_as_cover`
    if (!coverBufferForFolder) {
      const coverExtra = extraFiles.find((e) => e.action === 'use_as_cover');
      if (coverExtra) {
        const extraImgFull = resolveSafePath(
          clusterFullPath,
          coverExtra.relativePath
        );
        if (fs.existsSync(extraImgFull)) {
          coverBufferForFolder = fs.readFileSync(extraImgFull);
        }
      }
    }

    if (coverBufferForFolder) {
      const info = inspectImageBuffer(coverBufferForFolder);
      const ext = info?.format === 'png' ? '.png' : '.jpg';
      tempCoverFilePath = path.join(
        os.tmpdir(),
        `taggermon_cover_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`
      );
      fs.writeFileSync(tempCoverFilePath, coverBufferForFolder);
    }

    const processedFiles: Array<{
      sourceRelativePath: string;
      destinationRelativePath: string;
    }> = [];
    const primaryDestinationDirs = new Set<string>();
    const protectedDestinationPaths = new Set<string>();

    for (const fileItem of files) {
      const sourceFileFull = resolveSafePath(
        clusterFullPath,
        fileItem.relativePath
      );
      if (!fs.existsSync(sourceFileFull)) continue;

      let targetExt = path
        .extname(sourceFileFull)
        .toLowerCase()
        .replace(/^\./, '');

      if (
        (targetMediaType === 'comics' || targetMediaType === 'manga') &&
        (targetExt === 'cbr' || targetExt === 'epub')
      ) {
        targetExt = 'cbz';
      } else if (
        targetMediaType === 'books' &&
        convertMobiToEpub &&
        (targetExt === 'mobi' || targetExt === 'azw3')
      ) {
        targetExt = 'epub';
      }

      const formatted = formatDestinationRelativePath(
        pathTemplate,
        filenameTemplate,
        fileItem.tags,
        targetExt
      );

      const destFileFull = resolveSafePath(
        destLibraryRoot,
        formatted.fullRelativePath
      );
      primaryDestinationDirs.add(path.dirname(destFileFull));

      if (targetMediaType === 'music' || targetMediaType === 'audiobooks') {
        // If no external cover was chosen, check if the track already has an embedded cover so we can also write folder.jpg/png
        if (!coverBufferForFolder) {
          const embedded = await extractEmbeddedCoverFromAudio(sourceFileFull);
          if (embedded) {
            coverBufferForFolder = embedded.buffer;
          }
        }

        await writeAudioFileWithTagsAndCover({
          sourcePath: sourceFileFull,
          destinationPath: destFileFull,
          mediaType: targetMediaType,
          tags: fileItem.tags,
          preservedExtraTags: fileItem.preservedExtraTags,
          coverImagePath: tempCoverFilePath,
          removeSourceAfterWrite: true,
        });
      } else if (targetMediaType === 'comics' || targetMediaType === 'manga') {
        await processComicOrMangaFile({
          sourcePath: sourceFileFull,
          destinationPath: destFileFull,
          tags: fileItem.tags,
          preservedExtraTags: fileItem.preservedExtraTags,
          removeSourceAfterWrite: true,
        });
      } else if (targetMediaType === 'books') {
        await processBookFile({
          sourcePath: sourceFileFull,
          destinationPath: destFileFull,
          tags: fileItem.tags,
          preservedExtraTags: fileItem.preservedExtraTags,
          coverImagePath: tempCoverFilePath,
          convertMobiToEpub,
          removeSourceAfterWrite: true,
        });
      } else if (targetMediaType === 'movies' || targetMediaType === 'series') {
        const matchedSubs = subtitles
          .filter((s) => s.matchedVideoRelativePath === fileItem.relativePath)
          .map((s) => ({
            sourceSubtitlePath: resolveSafePath(
              clusterFullPath,
              s.relativePath
            ),
            ext: path.extname(s.relativePath).replace(/^\./, ''),
            languageCode: s.languageCode,
            isForced: s.isForced,
            isSdh: s.isSdh,
          }));

        const videoResult = await processVideoAndSubtitles({
          sourceVideoPath: sourceFileFull,
          destinationVideoPath: destFileFull,
          stripContainerTags,
          subtitles: matchedSubs,
          removeSourceAfterWrite: true,
        });
        for (const subOut of videoResult.subtitleOutputPaths) {
          protectedDestinationPaths.add(path.resolve(subOut));
        }
      }

      protectedDestinationPaths.add(path.resolve(destFileFull));
      processedFiles.push({
        sourceRelativePath: fileItem.relativePath,
        destinationRelativePath: formatted.fullRelativePath,
      });
    }

    // For music and audiobooks: ensure cover exists in the album folder as folder.jpg or folder.png without downscale
    let folderCoverSavedAs: string | undefined;
    if (
      (targetMediaType === 'music' || targetMediaType === 'audiobooks') &&
      coverBufferForFolder &&
      primaryDestinationDirs.size > 0
    ) {
      for (const albumDir of primaryDestinationDirs) {
        const savedCoverFull = saveFolderCoverFile(
          coverBufferForFolder,
          albumDir
        );
        protectedDestinationPaths.add(path.resolve(savedCoverFull));
        folderCoverSavedAs = path
          .relative(destLibraryRoot, savedCoverFull)
          .replace(/\\/g, '/');
      }
    }

    // Process extra files according to individual actions ('move', 'use_as_cover', 'delete', 'ignore')
    const movedExtras: string[] = [];
    const deletedExtras: string[] = [];
    const primaryDestDir =
      Array.from(primaryDestinationDirs)[0] || destLibraryRoot;

    for (const extra of extraFiles) {
      const sourceExtraFull = resolveSafePath(
        clusterFullPath,
        extra.relativePath
      );
      if (!fs.existsSync(sourceExtraFull)) continue;

      if (extra.action === 'move') {
        const targetExtraFull = path.join(
          primaryDestDir,
          path.basename(extra.relativePath)
        );
        fs.mkdirSync(path.dirname(targetExtraFull), { recursive: true });
        if (path.resolve(sourceExtraFull) !== path.resolve(targetExtraFull)) {
          fs.copyFileSync(sourceExtraFull, targetExtraFull);
          fs.unlinkSync(sourceExtraFull);
        }
        protectedDestinationPaths.add(path.resolve(targetExtraFull));
        movedExtras.push(
          path.relative(destLibraryRoot, targetExtraFull).replace(/\\/g, '/')
        );
      } else if (extra.action === 'use_as_cover') {
        // Already copied as folder.jpg/png and embedded; remove original file only if it is not the saved folder cover itself
        const resolvedSource = path.resolve(sourceExtraFull);
        if (
          !protectedDestinationPaths.has(resolvedSource) &&
          fs.existsSync(sourceExtraFull)
        ) {
          fs.unlinkSync(sourceExtraFull);
        }
      } else if (
        extra.action === 'delete' ||
        (extra.action === 'ignore' && deleteIgnoredExtrasAndCleanupSource)
      ) {
        const resolvedSource = path.resolve(sourceExtraFull);
        if (!protectedDestinationPaths.has(resolvedSource)) {
          fs.unlinkSync(sourceExtraFull);
          deletedExtras.push(extra.relativePath);
        }
      }
    }

    // If deleteIgnoredExtrasAndCleanupSource is requested, remove any leftover files in the source cluster that aren't protected destination outputs
    if (deleteIgnoredExtrasAndCleanupSource && fs.existsSync(clusterFullPath)) {
      const remaining = collectAllFilesRelative(clusterFullPath);
      for (const remRel of remaining) {
        const remFull = path.join(clusterFullPath, remRel);
        const isProtectedDest = protectedDestinationPaths.has(
          path.resolve(remFull)
        );
        if (!isProtectedDest && fs.existsSync(remFull)) {
          fs.unlinkSync(remFull);
        }
      }
    }

    // Clean up empty directories in the source cluster up to sourceRootDir
    if (fs.existsSync(clusterFullPath)) {
      // Remove empty subdirectories inside clusterFullPath first
      removeEmptySubdirsRecursive(clusterFullPath);
      cleanupEmptyDirectoriesUpwards(clusterFullPath, sourceRootDir);
    }

    const sourceFolderRemoved = !fs.existsSync(clusterFullPath);

    return {
      success: true,
      targetMediaType,
      destinationRoot: destLibraryRoot,
      processedFiles,
      folderCoverSavedAs,
      movedExtras,
      deletedExtras,
      sourceFolderRemoved,
    };
  } finally {
    if (tempCoverFilePath && fs.existsSync(tempCoverFilePath)) {
      try {
        fs.unlinkSync(tempCoverFilePath);
      } catch {
        // ignore
      }
    }
  }
}

function removeEmptySubdirsRecursive(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeEmptySubdirsRecursive(full);
      try {
        if (fs.readdirSync(full).length === 0) {
          fs.rmdirSync(full);
        }
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Samples an existing library mount and generates heuristic template suggestions
 * along with discovered tags across the sampled files.
 */
export async function suggestTemplatesFromExistingLibrary(
  mediaType: MediaType,
  maxSamples = 35
): Promise<{
  suggestions: TemplateSuggestion[];
  discoveredTags: DiscoveredTagSuggestion[];
}> {
  const libDir = getLibraryDir(mediaType);
  const cfg = MEDIA_TYPES_CONFIG[mediaType];
  const allPossibleStandardTags = cfg.availableTags.map((t) => t.key);
  const standardTagSet = new Set(allPossibleStandardTags);

  let exts: Set<string>;
  switch (mediaType) {
    case 'music':
    case 'audiobooks':
      exts = new Set(['mp3', 'flac', 'm4a', 'm4b', 'ogg', 'opus']);
      break;
    case 'books':
      exts = new Set(['epub', 'mobi', 'azw3', 'pdf']);
      break;
    case 'comics':
    case 'manga':
      exts = new Set(['cbz', 'cbr', 'epub', 'pdf']);
      break;
    case 'movies':
    case 'series':
      exts = new Set(
        Array.from(VIDEO_EXTENSIONS).map((e) => e.replace(/^\./, ''))
      );
      break;
  }

  const sampledRelativePaths = sampleFilesFromLibrary(libDir, exts, maxSamples);
  const samplesWithTags: Array<{
    relativePath: string;
    tags: Record<string, string>;
  }> = [];

  const tagCounts = new Map<
    string,
    { count: number; sampleValues: Set<string>; isStandard: boolean }
  >();

  const recordDiscoveredTag = (
    key: string,
    val: string,
    isStandard: boolean
  ) => {
    const cleanKey = key.trim();
    const cleanVal = String(val).trim();
    if (!cleanKey || !cleanVal || cleanKey === 'ext') return;
    const entry = tagCounts.get(cleanKey);
    if (entry) {
      entry.count++;
      if (entry.sampleValues.size < 3) {
        entry.sampleValues.add(cleanVal);
      }
    } else {
      tagCounts.set(cleanKey, {
        count: 1,
        sampleValues: new Set([cleanVal]),
        isStandard,
      });
    }
  };

  for (const relPath of sampledRelativePaths) {
    const fullPath = path.join(libDir, relPath);
    let tags: Record<string, string> = {};
    let extraTags: Record<string, string> = {};

    if (mediaType === 'music' || mediaType === 'audiobooks') {
      const res = await inspectAudioFile(
        fullPath,
        mediaType,
        allPossibleStandardTags
      );
      tags = res.tags;
      extraTags = res.unwantedTags;
    } else if (mediaType === 'comics' || mediaType === 'manga') {
      const res = await inspectComicOrMangaFile(
        fullPath,
        allPossibleStandardTags
      );
      tags = res.tags;
      extraTags = res.unwantedTags;
    } else if (mediaType === 'books') {
      const res = await inspectBookFile(fullPath, allPossibleStandardTags);
      tags = res.tags;
      extraTags = res.unwantedTags;
    }

    for (const [k, v] of Object.entries(tags)) {
      recordDiscoveredTag(k, v, true);
    }
    for (const [k, v] of Object.entries(extraTags)) {
      recordDiscoveredTag(k, v, standardTagSet.has(k));
    }

    samplesWithTags.push({ relativePath: relPath, tags });
  }

  const suggestions = aggregateTemplateSuggestions(mediaType, samplesWithTags);

  // Also record tags deduced structurally from paths/filenames (for movies, series, or untagged files)
  for (const sug of suggestions) {
    for (const prev of sug.samplePreviews) {
      for (const [k, v] of Object.entries(prev.extractedTags)) {
        if (!tagCounts.has(k)) {
          recordDiscoveredTag(k, v, standardTagSet.has(k));
        }
      }
    }
  }

  const totalSampled = sampledRelativePaths.length || 1;
  const discoveredTags: DiscoveredTagSuggestion[] = Array.from(
    tagCounts.entries()
  )
    .sort((a, b) => {
      if (a[1].isStandard !== b[1].isStandard) {
        return a[1].isStandard ? -1 : 1;
      }
      return b[1].count - a[1].count;
    })
    .map(([key, info]) => ({
      key,
      count: info.count,
      totalSampled: sampledRelativePaths.length,
      frequency: Number(
        Math.min(1, info.count / totalSampled).toFixed(2)
      ),
      sampleValues: Array.from(info.sampleValues),
      isStandardTag: info.isStandard,
    }));

  return { suggestions, discoveredTags };
}

/**
 * Registers all Fastify REST API routes under `/api`.
 */
export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  // 1. Get system configuration, media types metadata, and mount paths
  app.get('/api/config', async () => {
    return {
      mediaTypes: MEDIA_TYPES_CONFIG,
      allMediaTypes: ALL_MEDIA_TYPES,
      mounts: getAllMountPaths(),
      templates: getAllTemplates(),
    };
  });

  // 2. Get all 7 templates
  app.get('/api/templates', async () => {
    return getAllTemplates();
  });

  // 3. Update a media type template
  app.put<{
    Params: { mediaType: MediaType };
    Body: {
      pathTemplate: string;
      filenameTemplate: string;
      requiredTags?: string[];
      whitelistedExtraTags?: string[];
      stripContainerTagsByDefault?: boolean;
    };
  }>('/api/templates/:mediaType', async (req, reply) => {
    const { mediaType } = req.params;
    if (!ALL_MEDIA_TYPES.includes(mediaType)) {
      return reply.status(400).send({ error: 'Invalid media type' });
    }
    const updated = updateTemplate(mediaType, req.body);
    return updated;
  });

  // 4. Heuristic template suggestions by sampling the existing library
  app.get<{
    Params: { mediaType: MediaType };
    Querystring: { maxSamples?: string };
  }>('/api/templates/:mediaType/suggestions', async (req, reply) => {
    const { mediaType } = req.params;
    if (!ALL_MEDIA_TYPES.includes(mediaType)) {
      return reply.status(400).send({ error: 'Invalid media type' });
    }
    const max = req.query.maxSamples
      ? parseInt(req.query.maxSamples, 10)
      : 35;
    const { suggestions, discoveredTags } =
      await suggestTemplatesFromExistingLibrary(mediaType, max);
    return { suggestions, discoveredTags };
  });

  // 5. List folders in downloads or any of the 7 libraries
  app.get<{
    Querystring: {
      source?: 'downloads' | MediaType;
      parentPath?: string;
    };
  }>('/api/folders', async (req) => {
    const source = req.query.source || 'downloads';
    const parentPath = req.query.parentPath || '';
    const folders = listFolderClusters(source, parentPath);
    return {
      source,
      parentPath,
      folders,
    };
  });

  // 6. Inspect a specific folder cluster (in downloads or library)
  app.get<{
    Querystring: {
      source?: 'downloads' | MediaType;
      path: string;
      mediaType?: MediaType;
    };
  }>('/api/cluster', async (req, reply) => {
    const source = req.query.source || 'downloads';
    const clusterPath = req.query.path;
    if (!clusterPath) {
      return reply.status(400).send({ error: 'Missing path parameter' });
    }
    try {
      const scan = await scanClusterFolder({
        sourceRoot: source,
        clusterRelativePath: clusterPath,
        overrideMediaType: req.query.mediaType,
      });
      return scan;
    } catch (err) {
      return reply
        .status(404)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 7. Serve image preview for an extra image file or embedded audio cover
  app.get<{
    Querystring: {
      source?: 'downloads' | MediaType;
      clusterPath: string;
      filePath: string;
      embedded?: string;
    };
  }>('/api/preview-image', async (req, reply) => {
    const source = req.query.source || 'downloads';
    const rootDir = getRootDirForSource(source);
    const clusterDir = resolveSafePath(rootDir, req.query.clusterPath || '');
    const targetFile = resolveSafePath(clusterDir, req.query.filePath || '');

    if (!fs.existsSync(targetFile)) {
      return reply.status(404).send({ error: 'File not found' });
    }

    if (req.query.embedded === 'true') {
      const extracted = await extractEmbeddedCoverFromAudio(targetFile);
      if (!extracted) {
        return reply.status(404).send({ error: 'No embedded cover found' });
      }
      return reply
        .type(extracted.ext === 'png' ? 'image/png' : 'image/jpeg')
        .send(extracted.buffer);
    }

    const ext = path.extname(targetFile).toLowerCase();
    const mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.webp'
        ? 'image/webp'
        : 'image/jpeg';
    return reply.type(mime).send(fs.readFileSync(targetFile));
  });

  // 8. Proxy/inspect a cover image chosen via COV Remote Protocol (`covers.musichoarders.xyz`) without downscale
  app.post<{
    Body: { imageUrl: string };
  }>('/api/cov/inspect-url', async (req, reply) => {
    const { imageUrl } = req.body;
    if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
      return reply.status(400).send({ error: 'Invalid imageUrl' });
    }
    try {
      const resp = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Taggermon/1.0 (+https://github.com/alghostzx/Taggermon)',
        },
      });
      if (!resp.ok) {
        return reply
          .status(502)
          .send({ error: `Upstream HTTP ${resp.status}` });
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      const info = inspectImageBuffer(buffer);
      const mime = info?.format === 'png' ? 'image/png' : 'image/jpeg';
      return {
        imageUrl,
        sizeBytes: buffer.length,
        width: info?.width || 0,
        height: info?.height || 0,
        format: info?.format || 'jpg',
        dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
      };
    } catch (err) {
      return reply
        .status(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 9. Parse tags from filenames/paths using a token pattern
  app.post<{
    Body: {
      pattern: string;
      inputs: Array<{ id: string; text: string }>;
    };
  }>('/api/parse-pattern', async (req) => {
    const { pattern, inputs } = req.body;
    const results = inputs.map((item) => ({
      id: item.id,
      extracted: parseTagsFromPattern(item.text, pattern) || {},
    }));
    return { results };
  });

  // 10. Live preview of destination paths for all files in the editor
  app.post<{
    Body: {
      mediaType: MediaType;
      pathTemplate: string;
      filenameTemplate: string;
      convertMobiToEpub?: boolean;
      files: Array<{
        relativePath: string;
        ext: string;
        tags: Record<string, string>;
      }>;
    };
  }>('/api/preview-destinations', async (req) => {
    const previews = previewClusterDestinations(req.body);
    return { previews };
  });

  // 11. Process & organize cluster (write tags, clean unwanted tags, convert CBR/EPUB->CBZ, save folder.jpg/png, move subtitles, move to library)
  app.post<{
    Body: ProcessClusterPayload;
  }>('/api/process-cluster', async (req, reply) => {
    try {
      const result = await executeProcessCluster(req.body);
      return result;
    } catch (err) {
      return reply
        .status(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
