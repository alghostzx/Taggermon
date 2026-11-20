import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { imageSize } from 'image-size';
import { MediaType } from '../../shared/types.js';

const execFileAsync = promisify(execFile);

export interface AudioInspectResult {
  tags: Record<string, string>;
  unwantedTags: Record<string, string>;
  hasEmbeddedCover: boolean;
  embeddedCoverMime?: string;
}

const TECHNICAL_TAG_KEYS = new Set([
  'encoder',
  'major_brand',
  'minor_version',
  'compatible_brands',
  'creation_time',
  'handler_name',
  'vendor_id',
  'duration',
  'bitrate',
]);

/**
 * Maps raw ffprobe metadata tag keys to our normalized template keys for Music and Audiobooks.
 */
function normalizeRawTagKey(
  rawKey: string,
  mediaType: 'music' | 'audiobooks'
): string | null {
  const k = rawKey.toLowerCase().trim();
  if (mediaType === 'music') {
    switch (k) {
      case 'album_artist':
      case 'albumartist':
      case 'album artist':
      case 'tpe2':
        return 'album_artist';
      case 'artist':
      case 'tpe1':
      case 'performer':
        return 'artist';
      case 'album':
      case 'talb':
        return 'album';
      case 'date':
      case 'year':
      case 'tyer':
      case 'tdrc':
      case 'originalyear':
        return 'year';
      case 'genre':
      case 'tcon':
        return 'genre';
      case 'disc':
      case 'discnumber':
      case 'tpos':
        return 'disc';
      case 'disctotal':
      case 'totaldiscs':
      case 'total_discs':
        return 'total_discs';
      case 'track':
      case 'tracknumber':
      case 'trck':
        return 'track';
      case 'tracktotal':
      case 'totaltracks':
      case 'total_tracks':
        return 'total_tracks';
      case 'title':
      case 'tit2':
        return 'title';
      case 'composer':
      case 'tcom':
        return 'composer';
      default:
        return null;
    }
  } else {
    // audiobooks
    switch (k) {
      case 'artist':
      case 'album_artist':
      case 'albumartist':
      case 'author':
        return 'author';
      case 'composer':
      case 'narrator':
      case 'performer':
      case 'nrt':
        return 'narrator';
      case 'album':
      case 'book_title':
        return 'book_title';
      case 'series':
      case 'Grouping':
      case 'grouping':
      case 'contentgroup':
      case 'movementname':
      case 'mvnm':
        return 'series';
      case 'series_part':
      case 'series-part':
      case 'movement':
      case 'mvi':
      case 'disc':
      case 'discnumber':
        return 'series_part';
      case 'date':
      case 'year':
        return 'year';
      case 'genre':
        return 'genre';
      case 'language':
      case 'lang':
        return 'language';
      case 'track':
      case 'tracknumber':
        return 'track';
      case 'tracktotal':
      case 'totaltracks':
      case 'total_tracks':
        return 'total_tracks';
      case 'title':
        return 'title';
      default:
        return null;
    }
  }
}

/**
 * Inspects an audio file via ffprobe to read all tags (format + stream tags),
 * separating them into template-known tags and unwanted extra tags, and detecting embedded cover art.
 */
export async function inspectAudioFile(
  filePath: string,
  mediaType: 'music' | 'audiobooks',
  allowedTemplateTags: string[],
  whitelistedExtraTags: string[] = []
): Promise<AudioInspectResult> {
  const allowedSet = new Set(allowedTemplateTags);
  const whitelistSet = new Set(whitelistedExtraTags.map((t) => t.toLowerCase()));

  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    const parsed = JSON.parse(stdout);
    const rawTags: Record<string, string> = {};

    if (parsed.format?.tags) {
      for (const [k, v] of Object.entries(parsed.format.tags)) {
        if (v !== undefined && v !== null) {
          rawTags[k] = String(v);
        }
      }
    }

    let hasEmbeddedCover = false;
    let embeddedCoverMime: string | undefined;

    if (Array.isArray(parsed.streams)) {
      for (const stream of parsed.streams) {
        if (
          stream.codec_type === 'video' &&
          (stream.disposition?.attached_pic === 1 ||
            ['mjpeg', 'png', 'webp'].includes(stream.codec_name))
        ) {
          hasEmbeddedCover = true;
          embeddedCoverMime =
            stream.codec_name === 'png' ? 'image/png' : 'image/jpeg';
        }
        // For OGG/OPUS or FLAC where tags live in stream 0
        if (stream.codec_type === 'audio' && stream.tags) {
          for (const [k, v] of Object.entries(stream.tags)) {
            if (v !== undefined && v !== null && !(k in rawTags)) {
              rawTags[k] = String(v);
            }
          }
        }
      }
    }

    const tags: Record<string, string> = {};
    const unwantedTags: Record<string, string> = {};

    for (const [rawKey, rawValue] of Object.entries(rawTags)) {
      const lowerKey = rawKey.toLowerCase().trim();
      if (TECHNICAL_TAG_KEYS.has(lowerKey)) continue;
      if (lowerKey === 'metadata_block_picture') {
        hasEmbeddedCover = true;
        continue;
      }

      const normalized = normalizeRawTagKey(rawKey, mediaType);
      if (normalized && allowedSet.has(normalized)) {
        // Handle slash-separated track/total_tracks or disc/total_discs (e.g. "03/12")
        if (
          (normalized === 'track' || normalized === 'disc') &&
          rawValue.includes('/')
        ) {
          const [numPart, totalPart] = rawValue.split('/');
          tags[normalized] = String(parseInt(numPart.trim(), 10) || numPart.trim());
          const totalKey =
            normalized === 'track' ? 'total_tracks' : 'total_discs';
          if (allowedSet.has(totalKey) && totalPart?.trim()) {
            tags[totalKey] = String(
              parseInt(totalPart.trim(), 10) || totalPart.trim()
            );
          }
        } else if (normalized === 'year') {
          const yMatch = rawValue.match(/\b(\d{4})\b/);
          tags.year = yMatch ? yMatch[1] : rawValue.trim();
        } else if (
          ['track', 'disc', 'total_tracks', 'total_discs', 'series_part'].includes(
            normalized
          ) &&
          /^\d+$/.test(rawValue.trim())
        ) {
          tags[normalized] = String(parseInt(rawValue.trim(), 10));
        } else {
          tags[normalized] = rawValue.trim();
        }
      } else if (!whitelistSet.has(lowerKey)) {
        unwantedTags[rawKey] = rawValue;
      }
    }

    return {
      tags,
      unwantedTags,
      hasEmbeddedCover,
      embeddedCoverMime,
    };
  } catch {
    return {
      tags: {},
      unwantedTags: {},
      hasEmbeddedCover: false,
    };
  }
}

/**
 * Extracts embedded cover art from an audio file into a Buffer (without downscaling).
 */
export async function extractEmbeddedCoverFromAudio(
  filePath: string
): Promise<{ buffer: Buffer; ext: 'jpg' | 'png' } | null> {
  const tmpCover = path.join(
    path.dirname(filePath),
    `.tmp_cover_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`
  );
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-i',
      filePath,
      '-an',
      '-vcodec',
      'copy',
      tmpCover,
    ]);
    if (fs.existsSync(tmpCover)) {
      const buffer = fs.readFileSync(tmpCover);
      fs.unlinkSync(tmpCover);
      const info = inspectImageBuffer(buffer);
      const ext = info?.format === 'png' ? 'png' : 'jpg';
      return { buffer, ext };
    }
    return null;
  } catch {
    if (fs.existsSync(tmpCover)) {
      try {
        fs.unlinkSync(tmpCover);
      } catch {
        // ignore
      }
    }
    return null;
  }
}

/**
 * Inspects an image file or buffer to return width, height, and format (jpeg/png/webp).
 */
export function inspectImageBuffer(buffer: Buffer): {
  width: number;
  height: number;
  format: string;
} | null {
  try {
    const dim = imageSize(buffer);
    if (dim.width && dim.height) {
      return {
        width: dim.width,
        height: dim.height,
        format: dim.type || 'jpg',
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function inspectImageFile(filePath: string): {
  width: number;
  height: number;
  format: string;
} | null {
  try {
    const buffer = fs.readFileSync(filePath);
    return inspectImageBuffer(buffer);
  } catch {
    return null;
  }
}

/**
 * Builds the ffmpeg `-metadata` arguments for writing clean tags to an audio file.
 * Strips all existing tags (`-map_metadata -1`) and writes only the template tags plus any preserved extra tags.
 */
function buildFfmpegMetadataArgs(
  mediaType: 'music' | 'audiobooks',
  tags: Record<string, string>,
  preservedExtraTags: Record<string, string> = {}
): string[] {
  const args: string[] = [];

  function addMeta(key: string, val?: string) {
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      args.push('-metadata', `${key}=${String(val).trim()}`);
    }
  }

  if (mediaType === 'music') {
    addMeta('album_artist', tags.album_artist);
    addMeta('artist', tags.artist || tags.album_artist);
    addMeta('album', tags.album);
    addMeta('date', tags.year);
    addMeta('year', tags.year);
    addMeta('genre', tags.genre);
    if (tags.disc) {
      const discVal = tags.total_discs
        ? `${tags.disc}/${tags.total_discs}`
        : tags.disc;
      addMeta('disc', discVal);
    }
    if (tags.track) {
      const trackVal = tags.total_tracks
        ? `${tags.track}/${tags.total_tracks}`
        : tags.track;
      addMeta('track', trackVal);
    }
    addMeta('title', tags.title);
    addMeta('composer', tags.composer);
  } else {
    // audiobooks
    addMeta('artist', tags.author);
    addMeta('album_artist', tags.author);
    addMeta('author', tags.author);
    addMeta('composer', tags.narrator);
    addMeta('narrator', tags.narrator);
    addMeta('album', tags.book_title);
    addMeta('grouping', tags.series);
    addMeta('series', tags.series);
    addMeta('series_part', tags.series_part);
    addMeta('disc', tags.series_part);
    addMeta('date', tags.year);
    addMeta('year', tags.year);
    addMeta('genre', tags.genre);
    addMeta('language', tags.language);
    if (tags.track) {
      const trackVal = tags.total_tracks
        ? `${tags.track}/${tags.total_tracks}`
        : tags.track;
      addMeta('track', trackVal);
    }
    addMeta('title', tags.title);
  }

  for (const [k, v] of Object.entries(preservedExtraTags)) {
    addMeta(k, v);
  }

  return args;
}

/**
 * Writes clean tags and optional cover art (without downscaling) to the destination audio file.
 * If `coverImagePath` is provided, embeds that exact image stream (`-c:v copy`).
 * Otherwise preserves existing embedded cover art if present, while stripping all unwanted metadata (`-map_metadata -1`).
 */
export async function writeAudioFileWithTagsAndCover(options: {
  sourcePath: string;
  destinationPath: string;
  mediaType: 'music' | 'audiobooks';
  tags: Record<string, string>;
  preservedExtraTags?: Record<string, string>;
  coverImagePath?: string | null;
  removeSourceAfterWrite?: boolean;
}): Promise<void> {
  const {
    sourcePath,
    destinationPath,
    mediaType,
    tags,
    preservedExtraTags = {},
    coverImagePath,
    removeSourceAfterWrite = false,
  } = options;

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  const ext = path.extname(destinationPath).toLowerCase();
  const tempOutput = path.join(
    path.dirname(destinationPath),
    `.tmp_taggermon_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`
  );

  const supportsAttachedPic = ['.mp3', '.flac', '.m4a', '.m4b', '.aac'].includes(
    ext
  );

  const ffmpegArgs: string[] = ['-y', '-v', 'error', '-i', sourcePath];

  if (coverImagePath && fs.existsSync(coverImagePath) && supportsAttachedPic) {
    ffmpegArgs.push('-i', coverImagePath);
    ffmpegArgs.push('-map', '0:a');
    ffmpegArgs.push('-map', '1:v:0');
    ffmpegArgs.push('-c:a', 'copy');
    ffmpegArgs.push('-c:v', 'copy');
    ffmpegArgs.push('-disposition:v:0', 'attached_pic');
    if (ext === '.mp3') {
      ffmpegArgs.push('-id3v2_version', '3');
      ffmpegArgs.push(
        '-metadata:s:v',
        'title=Album cover',
        '-metadata:s:v',
        'comment=Cover (front)'
      );
    }
  } else {
    // Copy audio (and existing attached pic if any) without re-encoding
    ffmpegArgs.push('-map', '0:a');
    if (supportsAttachedPic) {
      ffmpegArgs.push('-map', '0:v?');
    }
    ffmpegArgs.push('-c', 'copy');
    if (ext === '.mp3') {
      ffmpegArgs.push('-id3v2_version', '3');
    }
  }

  // Strip all previous metadata from container and streams
  ffmpegArgs.push('-map_metadata', '-1');
  ffmpegArgs.push(
    ...buildFfmpegMetadataArgs(mediaType, tags, preservedExtraTags)
  );
  ffmpegArgs.push(tempOutput);

  try {
    await execFileAsync('ffmpeg', ffmpegArgs);
    fs.renameSync(tempOutput, destinationPath);
    if (
      removeSourceAfterWrite &&
      path.resolve(sourcePath) !== path.resolve(destinationPath) &&
      fs.existsSync(sourcePath)
    ) {
      fs.unlinkSync(sourcePath);
    }
  } catch (err) {
    if (fs.existsSync(tempOutput)) {
      try {
        fs.unlinkSync(tempOutput);
      } catch {
        // ignore
      }
    }
    throw err;
  }
}

/**
 * Saves the chosen album/audiobook cover into the destination folder as `folder.jpg` or `folder.png`
 * without any downscale or re-compression (exact binary copy).
 */
export function saveFolderCoverFile(
  coverSourcePathOrBuffer: string | Buffer,
  destinationFolder: string
): string {
  fs.mkdirSync(destinationFolder, { recursive: true });
  const buffer =
    typeof coverSourcePathOrBuffer === 'string'
      ? fs.readFileSync(coverSourcePathOrBuffer)
      : coverSourcePathOrBuffer;

  const info = inspectImageBuffer(buffer);
  const ext = info?.format === 'png' ? 'png' : 'jpg';
  const targetFilename = `folder.${ext}`;
  const targetPath = path.join(destinationFolder, targetFilename);

  // Remove opposite folder.jpg / folder.png if replacing cover
  const oppositeExt = ext === 'png' ? 'jpg' : 'png';
  const oppositePath = path.join(destinationFolder, `folder.${oppositeExt}`);
  if (fs.existsSync(oppositePath)) {
    try {
      fs.unlinkSync(oppositePath);
    } catch {
      // ignore
    }
  }

  fs.writeFileSync(targetPath, buffer);
  return targetPath;
}
