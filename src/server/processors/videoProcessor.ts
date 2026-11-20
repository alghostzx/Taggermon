import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { SubtitleItem } from '../../shared/types.js';

const execFileAsync = promisify(execFile);

export const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
  '.ts',
]);

export const SUBTITLE_EXTENSIONS = new Set([
  '.srt',
  '.ass',
  '.ssa',
  '.sub',
  '.idx',
  '.vtt',
]);

/**
 * Inspects a video file via ffprobe to detect any existing container tags (e.g. release group title/comment)
 * so the UI can show what will be stripped when the toggle is active.
 */
export async function inspectVideoContainerTags(
  filePath: string
): Promise<Record<string, string>> {
  const technicalKeys = new Set([
    'encoder',
    'major_brand',
    'minor_version',
    'compatible_brands',
    'creation_time',
    'duration',
  ]);
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      filePath,
    ]);
    const parsed = JSON.parse(stdout);
    const result: Record<string, string> = {};
    if (parsed?.format?.tags) {
      for (const [k, v] of Object.entries(parsed.format.tags)) {
        if (
          v !== undefined &&
          v !== null &&
          String(v).trim() !== '' &&
          !technicalKeys.has(k.toLowerCase())
        ) {
          result[k] = String(v).trim();
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Parses language code and flags (`forced`, `sdh`) from a subtitle filename.
 * E.g. `Movie.2022.1080p.pt-BR.forced.srt` -> `{ languageCode: 'pt-BR', isForced: true, isSdh: false }`
 */
export function detectSubtitleLanguageAndFlags(subtitleFilename: string): {
  languageCode: string;
  isForced: boolean;
  isSdh: boolean;
} {
  const ext = path.extname(subtitleFilename);
  let base = subtitleFilename.slice(0, -ext.length);
  let isForced = false;
  let isSdh = false;
  let languageCode = '';

  // Iteratively strip trailing .forced / .sdh / .cc flags
  let flagMatched = true;
  while (flagMatched) {
    flagMatched = false;
    if (/[._\s-]forced$/i.test(base)) {
      isForced = true;
      base = base.replace(/[._\s-]forced$/i, '');
      flagMatched = true;
    } else if (/[._\s-](sdh|cc)$/i.test(base)) {
      isSdh = true;
      base = base.replace(/[._\s-](sdh|cc)$/i, '');
      flagMatched = true;
    }
  }

  // Check for compound or standard language code at the end of `base`
  const langMatch = base.match(
    /(?:^|[._\s-])(pt[-_]br|pt[-_]pt|pt|pob|por|en|eng|es|spa|fr|fre|fra|de|ger|deu|it|ita|ja|jpn|ko|kor|ru|rus|zh|chi|zho)$/i
  );
  if (langMatch) {
    const lower = langMatch[1].toLowerCase();
    if (lower === 'pt-br' || lower === 'pt_br' || lower === 'pob') {
      languageCode = 'pt-BR';
    } else if (lower === 'pt-pt' || lower === 'pt_pt') {
      languageCode = 'pt-PT';
    } else if (lower === 'por' || lower === 'pt') {
      languageCode = 'pt';
    } else if (lower === 'eng' || lower === 'en') {
      languageCode = 'en';
    } else if (lower === 'spa' || lower === 'es') {
      languageCode = 'es';
    } else if (lower === 'jpn' || lower === 'ja') {
      languageCode = 'ja';
    } else {
      languageCode = lower;
    }
  }

  return { languageCode, isForced, isSdh };
}

/**
 * Extracts `SxxExx` or `1x02` episode key from a filename for matching series videos and subtitles.
 */
export function extractEpisodeMarker(filename: string): string | null {
  const seMatch = filename.match(/\b[Ss](\d{1,2})[Ee](\d{1,3})\b/);
  if (seMatch) {
    return `S${seMatch[1].padStart(2, '0')}E${seMatch[2].padStart(2, '0')}`;
  }
  const xMatch = filename.match(/\b(\d{1,2})x(\d{2,3})\b/i);
  if (xMatch) {
    return `S${xMatch[1].padStart(2, '0')}E${xMatch[2].padStart(2, '0')}`;
  }
  return null;
}

/**
 * Matches a list of subtitle relative paths against a list of video relative paths in the same cluster.
 */
export function matchSubtitlesToVideos(
  videoRelativePaths: string[],
  subtitleRelativePaths: string[]
): SubtitleItem[] {
  return subtitleRelativePaths.map((subRel) => {
    const subFilename = path.basename(subRel);
    const subExt = path.extname(subFilename).toLowerCase().replace(/^\./, '');
    const subBase = subFilename.slice(0, -(subExt.length + 1)).toLowerCase();
    const { languageCode, isForced, isSdh } =
      detectSubtitleLanguageAndFlags(subFilename);

    let matchedVideo: string | null = null;

    if (videoRelativePaths.length === 1) {
      matchedVideo = videoRelativePaths[0];
    } else if (videoRelativePaths.length > 1) {
      // 1. Try matching by SxxExx marker
      const subMarker = extractEpisodeMarker(subFilename);
      if (subMarker) {
        matchedVideo =
          videoRelativePaths.find(
            (v) => extractEpisodeMarker(path.basename(v)) === subMarker
          ) || null;
      }

      // 2. Fallback: longest prefix / base substring match
      if (!matchedVideo) {
        let bestScore = 0;
        for (const vidRel of videoRelativePaths) {
          const vidFilename = path.basename(vidRel);
          const vidBase = vidFilename
            .slice(0, -path.extname(vidFilename).length)
            .toLowerCase();
          if (subBase.startsWith(vidBase) || vidBase.startsWith(subBase)) {
            const score = Math.min(subBase.length, vidBase.length);
            if (score > bestScore) {
              bestScore = score;
              matchedVideo = vidRel;
            }
          }
        }
      }

      // 3. Also check if subtitle resides in `Subs/<VideoNameWithoutExt>/...`
      if (!matchedVideo) {
        const parentDirName = path.basename(path.dirname(subRel)).toLowerCase();
        for (const vidRel of videoRelativePaths) {
          const vidBase = path
            .basename(vidRel, path.extname(vidRel))
            .toLowerCase();
          if (parentDirName === vidBase) {
            matchedVideo = vidRel;
            break;
          }
        }
      }
    }

    return {
      relativePath: subRel,
      filename: subFilename,
      ext: subExt,
      matchedVideoRelativePath: matchedVideo,
      languageCode,
      isForced,
      isSdh,
    };
  });
}

/**
 * Formats the destination filename for a matched subtitle alongside a destination video path:
 * `<video_final_name_without_ext>[.<lang>][.sdh][.forced].<sub_ext>`
 */
export function formatSubtitleDestinationPath(
  videoDestinationPath: string,
  sub: {
    ext: string;
    languageCode?: string;
    isForced?: boolean;
    isSdh?: boolean;
  }
): string {
  const videoDir = path.dirname(videoDestinationPath);
  const videoExt = path.extname(videoDestinationPath);
  const videoBase = path.basename(videoDestinationPath, videoExt);

  const parts = [videoBase];
  if (sub.languageCode && sub.languageCode.trim() !== '') {
    parts.push(sub.languageCode.trim());
  }
  if (sub.isSdh) {
    parts.push('sdh');
  }
  if (sub.isForced) {
    parts.push('forced');
  }
  const cleanExt = sub.ext.replace(/^\./, '');
  parts.push(cleanExt);

  return path.join(videoDir, parts.join('.'));
}

/**
 * Processes a video file (Movie or Series episode) and its associated subtitles:
 * - Moves or copies the video file to `destinationPath`.
 * - When `stripContainerTags` is true (default), strips container tags via `mkvpropedit` (for .mkv, instant in-place header edit)
 *   or `ffmpeg -map 0 -c copy -map_metadata -1`.
 * - Renames and moves all associated subtitle files next to the destination video.
 */
export async function processVideoAndSubtitles(options: {
  sourceVideoPath: string;
  destinationVideoPath: string;
  stripContainerTags: boolean;
  subtitles?: Array<{
    sourceSubtitlePath: string;
    ext: string;
    languageCode?: string;
    isForced?: boolean;
    isSdh?: boolean;
  }>;
  removeSourceAfterWrite?: boolean;
}): Promise<{
  videoOutputPath: string;
  subtitleOutputPaths: string[];
}> {
  const {
    sourceVideoPath,
    destinationVideoPath,
    stripContainerTags,
    subtitles = [],
    removeSourceAfterWrite = false,
  } = options;

  fs.mkdirSync(path.dirname(destinationVideoPath), { recursive: true });
  const ext = path.extname(destinationVideoPath).toLowerCase();
  const isSamePath =
    path.resolve(sourceVideoPath) === path.resolve(destinationVideoPath);

  if (!stripContainerTags) {
    if (!isSamePath) {
      fs.copyFileSync(sourceVideoPath, destinationVideoPath);
      if (removeSourceAfterWrite && fs.existsSync(sourceVideoPath)) {
        fs.unlinkSync(sourceVideoPath);
      }
    }
  } else {
    // If MKV, we can copy/move and run mkvpropedit in-place or fallback to ffmpeg
    let strippedWithMkvpropedit = false;
    if (ext === '.mkv') {
      if (!isSamePath) {
        fs.copyFileSync(sourceVideoPath, destinationVideoPath);
      }
      try {
        await execFileAsync('mkvpropedit', [
          destinationVideoPath,
          '--tags',
          'all:',
          '--delete',
          'title',
        ]);
        strippedWithMkvpropedit = true;
        if (
          removeSourceAfterWrite &&
          !isSamePath &&
          fs.existsSync(sourceVideoPath)
        ) {
          fs.unlinkSync(sourceVideoPath);
        }
      } catch {
        // Fallback to ffmpeg below if mkvpropedit fails
      }
    }

    if (!strippedWithMkvpropedit) {
      const tempVideo = `${destinationVideoPath}.tmp_${Date.now()}${ext}`;
      try {
        await execFileAsync('ffmpeg', [
          '-y',
          '-v',
          'error',
          '-i',
          sourceVideoPath,
          '-map',
          '0',
          '-c',
          'copy',
          '-map_metadata',
          '-1',
          tempVideo,
        ]);
        fs.renameSync(tempVideo, destinationVideoPath);
        if (
          removeSourceAfterWrite &&
          !isSamePath &&
          fs.existsSync(sourceVideoPath)
        ) {
          fs.unlinkSync(sourceVideoPath);
        }
      } catch {
        if (fs.existsSync(tempVideo)) {
          try {
            fs.unlinkSync(tempVideo);
          } catch {
            // ignore
          }
        }
        // Fallback: direct copy if container isn't supported by ffmpeg remux
        if (!isSamePath) {
          fs.copyFileSync(sourceVideoPath, destinationVideoPath);
          if (removeSourceAfterWrite && fs.existsSync(sourceVideoPath)) {
            fs.unlinkSync(sourceVideoPath);
          }
        }
      }
    }
  }

  const subtitleOutputPaths: string[] = [];
  for (const sub of subtitles) {
    if (!fs.existsSync(sub.sourceSubtitlePath)) continue;
    const subDest = formatSubtitleDestinationPath(destinationVideoPath, sub);
    fs.mkdirSync(path.dirname(subDest), { recursive: true });
    if (path.resolve(sub.sourceSubtitlePath) !== path.resolve(subDest)) {
      fs.copyFileSync(sub.sourceSubtitlePath, subDest);
      if (removeSourceAfterWrite && fs.existsSync(sub.sourceSubtitlePath)) {
        fs.unlinkSync(sub.sourceSubtitlePath);
      }
    }
    subtitleOutputPaths.push(subDest);
  }

  return {
    videoOutputPath: destinationVideoPath,
    subtitleOutputPaths,
  };
}
