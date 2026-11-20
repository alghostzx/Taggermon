import fs from 'fs';
import path from 'path';
import { MediaType, TemplateSuggestion } from '../shared/types.js';
import { MEDIA_TYPES_CONFIG } from '../shared/constants.js';

/**
 * Sanitizes a single path segment or filename component so it doesn't break filesystem rules
 * while keeping spaces, accents, parentheses, brackets, and standard punctuation.
 */
export function sanitizeSegment(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Evaluates a single token expression like `{track:02}` or `{album_artist}` against `tags`.
 * Returns `{ value: string, hasValue: boolean }`.
 */
function renderTokensInChunk(
  chunk: string,
  tags: Record<string, string | number | undefined | null>
): { rendered: string; hasAnyToken: boolean; allTokensResolved: boolean } {
  let hasAnyToken = false;
  let allTokensResolved = true;

  const rendered = chunk.replace(
    /\{([a-zA-Z0-9_]+)(?::(\d+))?\}/g,
    (_full, key: string, padWidthStr?: string) => {
      hasAnyToken = true;
      const raw = tags[key];
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        allTokensResolved = false;
        return '';
      }
      let strVal = String(raw).trim();
      if (padWidthStr) {
        const padWidth = parseInt(padWidthStr, 10);
        const numericMatch = strVal.match(/^\d+/);
        if (numericMatch) {
          strVal = numericMatch[0].padStart(padWidth, '0');
        } else {
          strVal = strVal.padStart(padWidth, '0');
        }
      }
      return sanitizeSegment(strVal);
    }
  );

  return { rendered, hasAnyToken, allTokensResolved };
}

/**
 * Renders a template string containing tokens `{token}` / `{token:02}` and
 * optional blocks `[...]`. Optional blocks `[...]` are included ONLY if all tokens inside
 * them have non-empty values. Supports nested optional blocks as well.
 */
export function renderTemplate(
  template: string,
  tags: Record<string, string | number | undefined | null>
): string {
  let current = template;
  // Resolve innermost [...] blocks iteratively
  const blockRegex = /\[([^\[\]]+)\]/g;
  let safetyCounter = 0;
  while (blockRegex.test(current) && safetyCounter < 20) {
    safetyCounter++;
    current = current.replace(blockRegex, (_match, inner: string) => {
      const { rendered, hasAnyToken, allTokensResolved } = renderTokensInChunk(
        inner,
        tags
      );
      if (hasAnyToken && allTokensResolved) {
        return rendered;
      }
      return '';
    });
  }

  // Render remaining top-level tokens
  const { rendered } = renderTokensInChunk(current, tags);

  // Clean up duplicate slashes or trailing/leading spaces per directory segment
  return rendered
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0)
    .join('/');
}

/**
 * Formats full relative path inside the destination library from pathTemplate + filenameTemplate.
 */
export function formatDestinationRelativePath(
  pathTemplate: string,
  filenameTemplate: string,
  tags: Record<string, string | number | undefined | null>,
  extWithoutDot: string
): { directory: string; filename: string; fullRelativePath: string } {
  const fullTags = {
    ...tags,
    ext: extWithoutDot.replace(/^\./, ''),
  };
  const directory = renderTemplate(pathTemplate, fullTags);
  const filename = renderTemplate(filenameTemplate, fullTags).replace(/\//g, '_');
  const fullRelativePath = directory ? `${directory}/${filename}` : filename;
  return { directory, filename, fullRelativePath };
}

/**
 * Converts a user token pattern like `[{disc:02}-]{track:02} - {title}.{ext}` or `{series} - S{season:02}E{episode:02}`
 * into a RegExp with named capture groups and extracts tag values from an input string (filename or relative path).
 */
export function parseTagsFromPattern(
  input: string,
  pattern: string
): Record<string, string> | null {
  // Normalize slashes
  const normalizedInput = input.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/').trim();
  if (!normalizedPattern) return null;

  const usedGroupNames = new Set<string>();

  function compileChunkToRegex(chunk: string): string {
    let out = '';
    let i = 0;
    while (i < chunk.length) {
      if (chunk[i] === '[') {
        // Find matching closing bracket
        let depth = 1;
        let j = i + 1;
        while (j < chunk.length && depth > 0) {
          if (chunk[j] === '[') depth++;
          else if (chunk[j] === ']') depth--;
          j++;
        }
        const inner = chunk.slice(i + 1, j - 1);
        out += `(?:${compileChunkToRegex(inner)})?`;
        i = j;
      } else if (chunk[i] === '{') {
        const closeIdx = chunk.indexOf('}', i);
        if (closeIdx !== -1) {
          const tokenExpr = chunk.slice(i + 1, closeIdx);
          const [rawKey, padStr] = tokenExpr.split(':');
          const key = rawKey.trim();
          const isDuplicate = usedGroupNames.has(key);
          usedGroupNames.add(key);

          const groupPrefix = isDuplicate ? '?:' : `?<${key}>`;
          if (padStr) {
            out += `(${groupPrefix}\\d+)`;
          } else if (
            ['year', 'track', 'disc', 'season', 'episode', 'number', 'volume', 'series_part'].includes(
              key
            )
          ) {
            out += `(${groupPrefix}\\d+(?:\\.\\d+)?)`;
          } else {
            out += `(${groupPrefix}[^/]+?)`;
          }
          i = closeIdx + 1;
          continue;
        }
        out += '\\{';
        i++;
      } else {
        const ch = chunk[i];
        if (/[.*+?^${}()|\\]/.test(ch)) {
          out += '\\' + ch;
        } else {
          out += ch;
        }
        i++;
      }
    }
    return out;
  }

  try {
    const regexBody = compileChunkToRegex(normalizedPattern);
    const regex = new RegExp(`^${regexBody}$`, 'i');
    const match = regex.exec(normalizedInput);
    if (!match || !match.groups) {
      return null;
    }

    const extracted: Record<string, string> = {};
    for (const [k, v] of Object.entries(match.groups)) {
      if (v !== undefined && v !== '') {
        if (k === 'ext') continue;
        // Strip leading zeros for pure integers except year
        if (
          ['track', 'disc', 'season', 'episode', 'number', 'volume', 'series_part'].includes(k) &&
          /^\d+$/.test(v)
        ) {
          extracted[k] = String(parseInt(v, 10));
        } else {
          extracted[k] = v.trim();
        }
      }
    }
    return extracted;
  } catch {
    return null;
  }
}

/**
 * Given a real file from an existing library (its relative path and any known internal tags),
 * heuristically deduces the pathTemplate and filenameTemplate that produced it.
 */
export function deduceTemplateFromSample(
  mediaType: MediaType,
  relativePath: string,
  knownTags: Record<string, string>
): {
  pathTemplate: string;
  filenameTemplate: string;
  extractedTags: Record<string, string>;
} {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const filenameWithExt = parts.pop() || normalized;
  const extMatch = filenameWithExt.match(/\.([a-zA-Z0-9]+)$/);
  const ext = extMatch ? extMatch[1] : '';
  const filenameBase = extMatch
    ? filenameWithExt.slice(0, -extMatch[0].length)
    : filenameWithExt;

  const extractedTags: Record<string, string> = { ...knownTags };

  // 1. If we have internal tags, replace their exact values inside path segments and filenameBase
  // Sort tags by value length descending so longer values (e.g. album title vs artist) match first
  const tagEntries = Object.entries(knownTags)
    .filter(([k, v]) => v && v.trim().length > 0 && k !== 'ext')
    .sort((a, b) => b[1].length - a[1].length);

  function replaceKnownTagsInText(text: string): string {
    let result = text;

    // First handle numeric tags with potential zero-padding (track, disc, year, number, volume)
    for (const [key, val] of tagEntries) {
      if (/^\d+$/.test(val.trim())) {
        const num = parseInt(val.trim(), 10);
        const pad3 = String(num).padStart(3, '0');
        const pad2 = String(num).padStart(2, '0');
        if (key !== 'year') {
          if (result.includes(pad3) && pad3.length === 3) {
            result = result.replace(
              new RegExp(`(?<!\\d)${pad3}(?!\\d)`),
              `{${key}:03}`
            );
            continue;
          }
          if (result.includes(pad2) && pad2.length === 2) {
            result = result.replace(
              new RegExp(`(?<!\\d)${pad2}(?!\\d)`),
              `{${key}:02}`
            );
            continue;
          }
        }
        result = result.replace(
          new RegExp(`(?<!\\d)${num}(?!\\d)`),
          `{${key}}`
        );
      } else {
        const escaped = val.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (escaped.length >= 2) {
          result = result.replace(new RegExp(escaped, 'i'), `{${key}}`);
        }
      }
    }
    return result;
  }

  let deducedSegments = parts.map((seg) => replaceKnownTagsInText(seg));
  let deducedFilename = replaceKnownTagsInText(filenameBase);

  // 2. Apply structural heuristics for segments/filenames not yet tokenized (or for tagless media like series, movies, PDFs)
  if (mediaType === 'series') {
    // Match S01E02 or s01e02
    const seMatch = deducedFilename.match(
      /^(.*?)\s*-\s*[Ss](\d{2})[Ee](\d{2})(?:\s*-\s*(.+))?$/
    );
    if (seMatch) {
      extractedTags.series = extractedTags.series || seMatch[1].trim();
      extractedTags.season = String(parseInt(seMatch[2], 10));
      extractedTags.episode = String(parseInt(seMatch[3], 10));
      if (seMatch[4]) {
        extractedTags.title = seMatch[4].trim();
        deducedFilename = '{series} - S{season:02}E{episode:02}[ - {title}]';
      } else {
        deducedFilename = '{series} - S{season:02}E{episode:02}';
      }
    }
    deducedSegments = deducedSegments.map((seg, idx) => {
      const seasonMatch = seg.match(/^(Season|Temporada)\s+(\d{1,2})$/i);
      if (seasonMatch) {
        const pad = seasonMatch[2].length === 2 ? ':02' : '';
        return `${seasonMatch[1]} {season${pad}}`;
      }
      if (idx === 0 && !seg.includes('{')) {
        extractedTags.series = extractedTags.series || seg;
        return '{series}';
      }
      return seg;
    });
  } else if (mediaType === 'movies') {
    deducedSegments = deducedSegments.map((seg) => {
      const m = seg.match(/^(.+?)\s*\((\d{4})\)$/);
      if (m) {
        extractedTags.title = extractedTags.title || m[1].trim();
        extractedTags.year = m[2];
        return '{title} ({year})';
      }
      return seg;
    });
    const fileM = deducedFilename.match(
      /^(.+?)\s*\((\d{4})\)(?:\s*-\s*(\d{3,4}p))?$/i
    );
    if (fileM) {
      extractedTags.title = extractedTags.title || fileM[1].trim();
      extractedTags.year = fileM[2];
      if (fileM[3]) {
        extractedTags.resolution = fileM[3];
        deducedFilename = '{title} ({year})[ - {resolution}]';
      } else {
        deducedFilename = '{title} ({year})';
      }
    }
  } else if (mediaType === 'manga' || mediaType === 'comics') {
    // Structural fallback when ComicInfo.xml isn't present (e.g. PDFs or untagged CBZs)
    if (!deducedFilename.includes('{')) {
      const mangaMatch = deducedFilename.match(
        /^(.+?)\s*-\s*(?:Vol\.\s*(\d+)\s+)?(?:Cap\.|Ch\.|#)\s*(\d+)(?:\s*-\s*(.+))?$/i
      );
      if (mangaMatch) {
        extractedTags.series = extractedTags.series || mangaMatch[1].trim();
        if (mangaMatch[2]) extractedTags.volume = String(parseInt(mangaMatch[2], 10));
        extractedTags.number = String(parseInt(mangaMatch[3], 10));
        if (mangaMatch[4]) extractedTags.title = mangaMatch[4].trim();
        deducedFilename =
          mediaType === 'manga'
            ? '{series} - [Vol. {volume:02} ]Cap. {number:03}[ - {title}]'
            : '{series} #{number:03}[ - {title}]';
      }
    }
    deducedSegments = deducedSegments.map((seg, idx) => {
      const volMatch = seg.match(/^Vol\.\s*(\d+)$/i);
      if (volMatch) {
        return 'Vol. {volume:02}';
      }
      if (idx === 0 && !seg.includes('{')) {
        return '{series}';
      }
      return seg;
    });
  } else if (mediaType === 'music') {
    if (!deducedFilename.includes('{')) {
      const trackMatch = deducedFilename.match(
        /^(?:(\d{1,2})-)?(\d{2})\s*-\s*(.+)$/
      );
      if (trackMatch) {
        if (trackMatch[1]) extractedTags.disc = String(parseInt(trackMatch[1], 10));
        extractedTags.track = String(parseInt(trackMatch[2], 10));
        extractedTags.title = trackMatch[3].trim();
        deducedFilename = '[{disc:02}-]{track:02} - {title}';
      }
    }
    deducedSegments = deducedSegments.map((seg, idx) => {
      if (!seg.includes('{')) {
        const yearAlbum = seg.match(/^(\d{4})\s*-\s*(.+)$/);
        if (yearAlbum) {
          extractedTags.year = extractedTags.year || yearAlbum[1];
          extractedTags.album = extractedTags.album || yearAlbum[2].trim();
          return '{year} - {album}';
        }
        const albumYear = seg.match(/^(.+?)\s*\((\d{4})\)$/);
        if (albumYear) {
          extractedTags.album = extractedTags.album || albumYear[1].trim();
          extractedTags.year = extractedTags.year || albumYear[2];
          return '{album} ({year})';
        }
        if (idx === 0) {
          extractedTags.album_artist = extractedTags.album_artist || seg;
          return '{album_artist}';
        }
      }
      return seg;
    });
  } else if (mediaType === 'books' || mediaType === 'audiobooks') {
    if (!deducedFilename.includes('{')) {
      const bookMatch = deducedFilename.match(/^(.+?)\s*\((\d{4})\)$/);
      if (bookMatch) {
        extractedTags.title = extractedTags.title || bookMatch[1].trim();
        extractedTags.year = bookMatch[2];
        deducedFilename = '{title} ({year})';
      }
    }
    deducedSegments = deducedSegments.map((seg, idx) => {
      if (idx === 0 && !seg.includes('{')) {
        extractedTags.author = extractedTags.author || seg;
        return '{author}';
      }
      return seg;
    });
  }

  const finalPathTemplate =
    deducedSegments.length > 0
      ? deducedSegments.join('/')
      : MEDIA_TYPES_CONFIG[mediaType].defaultPathTemplate;
  const finalFilenameTemplate = ext
    ? `${deducedFilename}.{ext}`
    : `${deducedFilename}.{ext}`;

  return {
    pathTemplate: finalPathTemplate,
    filenameTemplate: finalFilenameTemplate,
    extractedTags,
  };
}

/**
 * Recursively traverses a library directory and returns a uniformly random sample
 * of up to `maxFiles` media files (using Reservoir Sampling + Fisher-Yates shuffle),
 * ensuring files across the entire library are sampled rather than the first sequential files.
 */
export function sampleFilesFromLibrary(
  libraryRootDir: string,
  allowedExtensions: Set<string>,
  maxFiles = 40
): string[] {
  if (!fs.existsSync(libraryRootDir) || maxFiles <= 0) return [];
  const reservoir: string[] = [];
  let totalEligibleSeen = 0;

  function shuffleInPlace<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }

  function walk(currentDir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    // Randomize traversal order of directories and files at each level
    shuffleInPlace(entries);

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase().replace(/^\./, '');
        if (allowedExtensions.has(ext)) {
          const relPath = path
            .relative(libraryRootDir, fullPath)
            .replace(/\\/g, '/');
          totalEligibleSeen++;
          if (reservoir.length < maxFiles) {
            reservoir.push(relPath);
          } else {
            // Algorithm R (Vitter's Reservoir Sampling): replace with probability maxFiles / totalEligibleSeen
            const replaceIndex = Math.floor(Math.random() * totalEligibleSeen);
            if (replaceIndex < maxFiles) {
              reservoir[replaceIndex] = relPath;
            }
          }
        }
      }
    }
  }

  walk(libraryRootDir);
  shuffleInPlace(reservoir);
  return reservoir;
}

/**
 * Aggregates template deductions across sampled files and returns ranked suggestions.
 */
export function aggregateTemplateSuggestions(
  mediaType: MediaType,
  samples: Array<{ relativePath: string; tags: Record<string, string> }>
): TemplateSuggestion[] {
  if (samples.length === 0) {
    const cfg = MEDIA_TYPES_CONFIG[mediaType];
    return [
      {
        pathTemplate: cfg.defaultPathTemplate,
        filenameTemplate: cfg.defaultFilenameTemplate,
        confidence: 1,
        matchCount: 0,
        totalSampled: 0,
        samplePreviews: [],
      },
    ];
  }

  const groups = new Map<
    string,
    {
      pathTemplate: string;
      filenameTemplate: string;
      count: number;
      previews: Array<{
        originalPath: string;
        extractedTags: Record<string, string>;
      }>;
    }
  >();

  for (const sample of samples) {
    const deduced = deduceTemplateFromSample(
      mediaType,
      sample.relativePath,
      sample.tags
    );
    const key = `${deduced.pathTemplate}|||${deduced.filenameTemplate}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      if (existing.previews.length < 5) {
        existing.previews.push({
          originalPath: sample.relativePath,
          extractedTags: deduced.extractedTags,
        });
      }
    } else {
      groups.set(key, {
        pathTemplate: deduced.pathTemplate,
        filenameTemplate: deduced.filenameTemplate,
        count: 1,
        previews: [
          {
            originalPath: sample.relativePath,
            extractedTags: deduced.extractedTags,
          },
        ],
      });
    }
  }

  const total = samples.length;
  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count)
    .map((g) => ({
      pathTemplate: g.pathTemplate,
      filenameTemplate: g.filenameTemplate,
      confidence: Number((g.count / total).toFixed(2)),
      matchCount: g.count,
      totalSampled: total,
      samplePreviews: g.previews,
    }));
}
