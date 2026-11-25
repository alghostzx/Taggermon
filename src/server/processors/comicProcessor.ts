import AdmZip from 'adm-zip';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';

const execFileAsync = promisify(execFile);

/**
 * Fast ZIP Central Directory reader that extracts ONLY a single XML/text entry (e.g. `ComicInfo.xml`)
 * from a `.cbz`/`.zip` archive without loading the entire 60MB-300MB archive into memory.
 */
export function readSingleFileFromZipFast(
  zipPath: string,
  predicate: (entryName: string) => boolean
): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(zipPath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize < 22) return null;

    const tailSize = Math.min(fileSize, 65557);
    const tailBuf = Buffer.alloc(tailSize);
    fs.readSync(fd, tailBuf, 0, tailSize, fileSize - tailSize);

    // Search backwards for End of Central Directory signature (0x06054b50)
    let eocdPos = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tailBuf.readUInt32LE(i) === 0x06054b50) {
        eocdPos = i;
        break;
      }
    }
    if (eocdPos === -1) return null;

    const cdSize = tailBuf.readUInt32LE(eocdPos + 12);
    const cdOffset = tailBuf.readUInt32LE(eocdPos + 16);
    if (
      cdOffset === 0xffffffff ||
      cdSize === 0xffffffff ||
      cdOffset + cdSize > fileSize
    ) {
      return null;
    }

    const cdBuf = Buffer.alloc(cdSize);
    fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);

    let ptr = 0;
    while (ptr + 46 <= cdSize) {
      if (cdBuf.readUInt32LE(ptr) !== 0x02014b50) break;
      const compressionMethod = cdBuf.readUInt16LE(ptr + 10);
      const compSize = cdBuf.readUInt32LE(ptr + 20);
      const fileNameLen = cdBuf.readUInt16LE(ptr + 28);
      const extraLen = cdBuf.readUInt16LE(ptr + 30);
      const commentLen = cdBuf.readUInt16LE(ptr + 32);
      const localHeaderOffset = cdBuf.readUInt32LE(ptr + 42);

      const entryName = cdBuf.toString(
        'utf8',
        ptr + 46,
        ptr + 46 + fileNameLen
      );
      if (predicate(entryName)) {
        const lhBuf = Buffer.alloc(30);
        fs.readSync(fd, lhBuf, 0, 30, localHeaderOffset);
        if (lhBuf.readUInt32LE(0) !== 0x04034b50) return null;
        const lhNameLen = lhBuf.readUInt16LE(26);
        const lhExtraLen = lhBuf.readUInt16LE(28);
        const dataOffset = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
        const rawData = Buffer.alloc(compSize);
        fs.readSync(fd, rawData, 0, compSize, dataOffset);

        if (compressionMethod === 0) {
          return rawData;
        } else if (compressionMethod === 8) {
          return zlib.inflateRawSync(rawData);
        }
        return null;
      }

      ptr += 46 + fileNameLen + extraLen + commentLen;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.avif',
]);

const COMIC_INFO_TO_TAG_KEY: Record<string, string> = {
  Series: 'series',
  Publisher: 'publisher',
  Writer: 'writer',
  Penciller: 'penciller',
  Year: 'year',
  Volume: 'volume',
  Number: 'number',
  Count: 'count',
  Title: 'title',
  Genre: 'genre',
  LanguageISO: 'language',
  Manga: 'manga',
  BlackAndWhite: 'black_and_white',
};

const TAG_KEY_TO_COMIC_INFO: Record<string, string> = {
  series: 'Series',
  publisher: 'Publisher',
  writer: 'Writer',
  penciller: 'Penciller',
  year: 'Year',
  volume: 'Volume',
  number: 'Number',
  count: 'Count',
  title: 'Title',
  genre: 'Genre',
  language: 'LanguageISO',
  manga: 'Manga',
  black_and_white: 'BlackAndWhite',
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
});

export interface ComicInspectResult {
  tags: Record<string, string>;
  unwantedTags: Record<string, string>;
  needsConversionToCbz: boolean;
  isPdfNoInternalTags: boolean;
}

/**
 * Parses a `ComicInfo.xml` string into template tags and unwanted extra tags.
 */
export function parseComicInfoXml(
  xmlContent: string,
  allowedTemplateTags: string[],
  whitelistedExtraTags: string[] = []
): { tags: Record<string, string>; unwantedTags: Record<string, string> } {
  const allowedSet = new Set(allowedTemplateTags);
  const whitelistSet = new Set(whitelistedExtraTags.map((t) => t.toLowerCase()));

  try {
    const parsed = xmlParser.parse(xmlContent);
    const info = parsed?.ComicInfo;
    if (!info || typeof info !== 'object') {
      return { tags: {}, unwantedTags: {} };
    }

    const tags: Record<string, string> = {};
    const unwantedTags: Record<string, string> = {};

    for (const [xmlKey, rawVal] of Object.entries(info)) {
      if (xmlKey.startsWith('@_')) continue;
      if (xmlKey === 'Pages' || xmlKey === 'PageCount') continue;
      if (rawVal === undefined || rawVal === null || String(rawVal).trim() === '') {
        continue;
      }
      const strVal = String(rawVal).trim();
      const mappedKey = COMIC_INFO_TO_TAG_KEY[xmlKey];
      if (mappedKey && allowedSet.has(mappedKey)) {
        if (mappedKey === 'volume' && strVal === '-1') continue;
        tags[mappedKey] = strVal;
      } else {
        const matchedCustom = allowedTemplateTags.find(
          (t) => t.toLowerCase() === xmlKey.toLowerCase()
        );
        if (matchedCustom) {
          tags[matchedCustom] = strVal;
        } else if (!whitelistSet.has(xmlKey.toLowerCase())) {
          unwantedTags[xmlKey] = strVal;
        }
      }
    }

    return { tags, unwantedTags };
  } catch {
    return { tags: {}, unwantedTags: {} };
  }
}

/**
 * Builds a clean `ComicInfo.xml` string containing ONLY the template tags, optional page count,
 * and any preserved extra tags.
 */
export function buildComicInfoXml(
  tags: Record<string, string>,
  preservedExtraTags: Record<string, string> = {},
  pageCount?: number
): string {
  const comicInfoObj: Record<string, string | number> = {
    '@_xmlns:xsd': 'http://www.w3.org/2001/XMLSchema',
    '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
  };

  for (const [tagKey, xmlNodeName] of Object.entries(TAG_KEY_TO_COMIC_INFO)) {
    const val = tags[tagKey];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      if (['year', 'volume'].includes(tagKey) && /^\d+$/.test(String(val).trim())) {
        comicInfoObj[xmlNodeName] = parseInt(String(val).trim(), 10);
      } else {
        comicInfoObj[xmlNodeName] = String(val).trim();
      }
    }
  }

  for (const [tagKey, val] of Object.entries(tags)) {
    if (
      !(tagKey in TAG_KEY_TO_COMIC_INFO) &&
      val !== undefined &&
      val !== null &&
      String(val).trim() !== '' &&
      !(tagKey in comicInfoObj)
    ) {
      comicInfoObj[tagKey] = String(val).trim();
    }
  }

  if (pageCount && pageCount > 0) {
    comicInfoObj.PageCount = pageCount;
  }

  for (const [extraXmlKey, extraVal] of Object.entries(preservedExtraTags)) {
    if (
      extraVal !== undefined &&
      extraVal !== null &&
      String(extraVal).trim() !== '' &&
      !(extraXmlKey in comicInfoObj)
    ) {
      comicInfoObj[extraXmlKey] = String(extraVal).trim();
    }
  }

  const xmlBody = xmlBuilder.build({ ComicInfo: comicInfoObj });
  return `<?xml version="1.0" encoding="utf-8"?>\n${xmlBody}`;
}

/**
 * Inspects a Manga or Comic file (.cbz, .cbr, .epub, .pdf).
 */
export async function inspectComicOrMangaFile(
  filePath: string,
  allowedTemplateTags: string[],
  whitelistedExtraTags: string[] = []
): Promise<ComicInspectResult> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    return {
      tags: {},
      unwantedTags: {},
      needsConversionToCbz: false,
      isPdfNoInternalTags: true,
    };
  }

  if (ext === '.cbz') {
    try {
      // Fast path: read only Central Directory + ComicInfo.xml entry without loading 100MB+ of image pages
      const fastXmlBuf = readSingleFileFromZipFast(
        filePath,
        (name) => path.basename(name).toLowerCase() === 'comicinfo.xml'
      );
      if (fastXmlBuf) {
        const xmlText = fastXmlBuf.toString('utf8');
        const { tags, unwantedTags } = parseComicInfoXml(
          xmlText,
          allowedTemplateTags,
          whitelistedExtraTags
        );
        return {
          tags,
          unwantedTags,
          needsConversionToCbz: false,
          isPdfNoInternalTags: false,
        };
      }

      // Fallback to AdmZip if ZIP64 or non-standard header
      const zip = new AdmZip(filePath);
      const entry = zip
        .getEntries()
        .find((e) => path.basename(e.entryName).toLowerCase() === 'comicinfo.xml');
      if (entry) {
        const xmlText = entry.getData().toString('utf8');
        const { tags, unwantedTags } = parseComicInfoXml(
          xmlText,
          allowedTemplateTags,
          whitelistedExtraTags
        );
        return {
          tags,
          unwantedTags,
          needsConversionToCbz: false,
          isPdfNoInternalTags: false,
        };
      }
    } catch {
      // ignore corrupted zip during inspect
    }
    return {
      tags: {},
      unwantedTags: {},
      needsConversionToCbz: false,
      isPdfNoInternalTags: false,
    };
  }

  if (ext === '.epub') {
    const epubMeta = inspectEpubMetadataForComic(
      filePath,
      allowedTemplateTags,
      whitelistedExtraTags
    );
    return {
      ...epubMeta,
      needsConversionToCbz: true,
      isPdfNoInternalTags: false,
    };
  }

  if (ext === '.cbr') {
    const cbrMeta = await inspectCbrComicInfo(
      filePath,
      allowedTemplateTags,
      whitelistedExtraTags
    );
    return {
      ...cbrMeta,
      needsConversionToCbz: true,
      isPdfNoInternalTags: false,
    };
  }

  return {
    tags: {},
    unwantedTags: {},
    needsConversionToCbz: false,
    isPdfNoInternalTags: false,
  };
}

/**
 * Reads OPF metadata from an EPUB file to pre-populate Comic/Manga tags before conversion to CBZ.
 */
function inspectEpubMetadataForComic(
  epubPath: string,
  allowedTemplateTags: string[],
  whitelistedExtraTags: string[]
): { tags: Record<string, string>; unwantedTags: Record<string, string> } {
  const allowedSet = new Set(allowedTemplateTags);
  const whitelistSet = new Set(whitelistedExtraTags.map((t) => t.toLowerCase()));
  try {
    const zip = new AdmZip(epubPath);
    const opfEntry = findOpfEntryInZip(zip);
    if (!opfEntry) return { tags: {}, unwantedTags: {} };

    const opfXml = opfEntry.getData().toString('utf8');
    const parsed = xmlParser.parse(opfXml);
    const pkg = parsed?.package || parsed?.['opf:package'];
    const metadata = pkg?.metadata || pkg?.['opf:metadata'];
    if (!metadata) return { tags: {}, unwantedTags: {} };

    const tags: Record<string, string> = {};
    const unwantedTags: Record<string, string> = {};

    const extractText = (node: unknown): string => {
      if (node === undefined || node === null) return '';
      if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
      if (Array.isArray(node)) return extractText(node[0]);
      if (typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
        return String((node as Record<string, unknown>)['#text']).trim();
      }
      return '';
    };

    const title = extractText(metadata['dc:title'] ?? metadata.title);
    const creator = extractText(metadata['dc:creator'] ?? metadata.creator);
    const publisher = extractText(metadata['dc:publisher'] ?? metadata.publisher);
    const date = extractText(metadata['dc:date'] ?? metadata.date);
    const language = extractText(metadata['dc:language'] ?? metadata.language);
    const subject = extractText(metadata['dc:subject'] ?? metadata.subject);

    if (title && allowedSet.has('title')) tags.title = title;
    if (title && allowedSet.has('series') && !tags.series) tags.series = title;
    if (creator && allowedSet.has('writer')) tags.writer = creator;
    if (publisher && allowedSet.has('publisher')) tags.publisher = publisher;
    if (date && allowedSet.has('year')) {
      const m = date.match(/\b(\d{4})\b/);
      if (m) tags.year = m[1];
    }
    if (language && allowedSet.has('language')) tags.language = language;
    if (subject && allowedSet.has('genre')) tags.genre = subject;

    // Any extra dc:* fields not mapped
    for (const [k, v] of Object.entries(metadata)) {
      if (k.startsWith('@_')) continue;
      if (
        ![
          'dc:title',
          'title',
          'dc:creator',
          'creator',
          'dc:publisher',
          'publisher',
          'dc:date',
          'date',
          'dc:language',
          'language',
          'dc:subject',
          'subject',
          'meta',
        ].includes(k)
      ) {
        const val = extractText(v);
        if (val && !whitelistSet.has(k.toLowerCase())) {
          unwantedTags[k] = val;
        }
      }
    }

    return { tags, unwantedTags };
  } catch {
    return { tags: {}, unwantedTags: {} };
  }
}

async function inspectCbrComicInfo(
  cbrPath: string,
  allowedTemplateTags: string[],
  whitelistedExtraTags: string[]
): Promise<{ tags: Record<string, string>; unwantedTags: Record<string, string> }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taggermon-cbr-inspect-'));
  try {
    await extractCbrArchiveToDir(cbrPath, tempDir);
    const files = walkAllFiles(tempDir);
    const comicInfoFile = files.find(
      (f) => path.basename(f).toLowerCase() === 'comicinfo.xml'
    );
    if (comicInfoFile) {
      const xmlText = fs.readFileSync(comicInfoFile, 'utf8');
      return parseComicInfoXml(xmlText, allowedTemplateTags, whitelistedExtraTags);
    }
    return { tags: {}, unwantedTags: {} };
  } catch {
    return { tags: {}, unwantedTags: {} };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function findOpfEntryInZip(zip: AdmZip): AdmZip.IZipEntry | undefined {
  const containerEntry = zip.getEntry('META-INF/container.xml');
  if (containerEntry) {
    try {
      const parsed = xmlParser.parse(containerEntry.getData().toString('utf8'));
      const rootfile =
        parsed?.container?.rootfiles?.rootfile ||
        parsed?.container?.rootfiles?.['opf:rootfile'];
      const rf = Array.isArray(rootfile) ? rootfile[0] : rootfile;
      const fullPath = rf?.['@_full-path'];
      if (fullPath) {
        const entry = zip.getEntry(fullPath);
        if (entry) return entry;
      }
    } catch {
      // fallback to scanning for .opf
    }
  }
  return zip
    .getEntries()
    .find((e) => e.entryName.toLowerCase().endsWith('.opf'));
}

/**
 * Extracts images from an EPUB in true reading order by following `<spine>` -> `<manifest>` -> HTML `<img>`/`<image>` tags,
 * falling back to natural sort of image entries if spine references images directly or has no HTML wrappers.
 */
export function extractImagesFromEpubInReadingOrder(
  epubPath: string
): Array<{ buffer: Buffer; ext: string }> {
  const zip = new AdmZip(epubPath);
  const opfEntry = findOpfEntryInZip(zip);
  const orderedImageEntryNames: string[] = [];
  const seenEntries = new Set<string>();

  const addImageEntry = (entryName: string) => {
    const normalized = entryName.replace(/\\/g, '/').replace(/^\//, '');
    if (seenEntries.has(normalized)) return;
    const ext = path.extname(normalized).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return;
    if (zip.getEntry(normalized)) {
      seenEntries.add(normalized);
      orderedImageEntryNames.push(normalized);
    }
  };

  if (opfEntry) {
    try {
      const opfDir = path.posix.dirname(opfEntry.entryName);
      const resolveRelative = (baseDir: string, href: string): string => {
        const cleanHref = decodeURIComponent(href.split('#')[0].split('?')[0]);
        if (baseDir === '.' || baseDir === '') return cleanHref;
        return path.posix.normalize(path.posix.join(baseDir, cleanHref));
      };

      const opfXml = opfEntry.getData().toString('utf8');
      const parsed = xmlParser.parse(opfXml);
      const pkg = parsed?.package || parsed?.['opf:package'];
      const manifestItemsRaw =
        pkg?.manifest?.item || pkg?.['opf:manifest']?.['opf:item'] || [];
      const manifestItems = Array.isArray(manifestItemsRaw)
        ? manifestItemsRaw
        : [manifestItemsRaw];

      const idToItem = new Map<
        string,
        { href: string; mediaType: string; properties?: string }
      >();
      for (const item of manifestItems) {
        if (item && item['@_id'] && item['@_href']) {
          idToItem.set(String(item['@_id']), {
            href: String(item['@_href']),
            mediaType: String(item['@_media-type'] || ''),
            properties: item['@_properties']
              ? String(item['@_properties'])
              : undefined,
          });
        }
      }

      // Check for cover image in metadata/manifest first if not in spine
      const spineRefsRaw =
        pkg?.spine?.itemref || pkg?.['opf:spine']?.['opf:itemref'] || [];
      const spineRefs = Array.isArray(spineRefsRaw)
        ? spineRefsRaw
        : [spineRefsRaw];

      for (const ref of spineRefs) {
        const idref = ref?.['@_idref'];
        if (!idref) continue;
        const manifestItem = idToItem.get(String(idref));
        if (!manifestItem) continue;

        const targetEntryPath = resolveRelative(opfDir, manifestItem.href);
        const ext = path.extname(targetEntryPath).toLowerCase();

        if (IMAGE_EXTENSIONS.has(ext)) {
          addImageEntry(targetEntryPath);
        } else {
          // Parse HTML/XHTML page to find <img src="..."> or SVG <image xlink:href="..." / href="...">
          const pageEntry = zip.getEntry(targetEntryPath);
          if (pageEntry) {
            const pageDir = path.posix.dirname(targetEntryPath);
            const html = pageEntry.getData().toString('utf8');
            const imgRegex =
              /(?:<img[^>]+src|<image[^>]+(?:xlink:)?href)\s*=\s*["']([^"']+)["']/gi;
            let match: RegExpExecArray | null;
            while ((match = imgRegex.exec(html)) !== null) {
              const imgPath = resolveRelative(pageDir, match[1]);
              addImageEntry(imgPath);
            }
          }
        }
      }
    } catch {
      // fallback below
    }
  }

  // Also append any remaining images in the EPUB sorted naturally (or if spine didn't yield all pages)
  const allImageEntries = zip
    .getEntries()
    .filter(
      (e) =>
        !e.isDirectory &&
        IMAGE_EXTENSIONS.has(path.extname(e.entryName).toLowerCase())
    )
    .map((e) => e.entryName)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  for (const entryName of allImageEntries) {
    addImageEntry(entryName);
  }

  return orderedImageEntryNames.map((entryName) => {
    const entry = zip.getEntry(entryName)!;
    const ext = path.extname(entryName).toLowerCase();
    return {
      buffer: entry.getData(),
      ext: ext === '.jpeg' ? '.jpg' : ext,
    };
  });
}

/**
 * Extracts a CBR archive (RAR or ZIP misnamed as .cbr) into `targetDir`.
 * Uses system `unrar` / `7z` / `bsdtar`, or AdmZip if the file is actually a PKZIP archive,
 * with `node-unrar-js` WASM fallback.
 */
async function extractCbrArchiveToDir(
  cbrPath: string,
  targetDir: string
): Promise<void> {
  const header = Buffer.alloc(4);
  const fd = fs.openSync(cbrPath, 'r');
  fs.readSync(fd, header, 0, 4, 0);
  fs.closeSync(fd);

  // If the .cbr is actually a ZIP archive (PK\x03\x04)
  if (header[0] === 0x50 && header[1] === 0x4b) {
    const zip = new AdmZip(cbrPath);
    zip.extractAllTo(targetDir, true);
    return;
  }

  // Try system `unrar` first
  try {
    await execFileAsync('unrar', ['x', '-y', '-idq', cbrPath, `${targetDir}/`]);
    return;
  } catch {
    // Try `7z` or `bsdtar` or `node-unrar-js`
  }

  try {
    await execFileAsync('7z', ['x', '-y', `-o${targetDir}`, cbrPath]);
    return;
  } catch {
    // Fallback to node-unrar-js in-memory extractor
  }

  const { createExtractorFromFile } = await import('node-unrar-js');
  const extractor = await createExtractorFromFile({
    filepath: cbrPath,
    targetPath: targetDir,
  });
  const extracted = extractor.extract();
  // Consume iterator to trigger extraction
  Array.from(extracted.files);
}

function walkAllFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkAllFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Processes a Manga or Comic file:
 * - If `.pdf`: dispenses internal tags and strictly moves/copies to destinationPath.
 * - If `.epub`: extracts images in reading order (`<spine>`), renames sequentially (`0001.jpg`, `0002.jpg`...) and writes `ComicInfo.xml` at root of new `.cbz`.
 * - If `.cbr`: extracts RAR pages sorted naturally, renames sequentially (`0001.jpg`, `0002.jpg`...) and writes `ComicInfo.xml` at root of new `.cbz`.
 * - If `.cbz`: writes/updates clean `ComicInfo.xml` at root of `.cbz` and removes any unwanted tag fields.
 */
export async function processComicOrMangaFile(options: {
  sourcePath: string;
  destinationPath: string;
  tags: Record<string, string>;
  preservedExtraTags?: Record<string, string>;
  removeSourceAfterWrite?: boolean;
}): Promise<string> {
  const {
    sourcePath,
    destinationPath,
    tags,
    preservedExtraTags = {},
    removeSourceAfterWrite = false,
  } = options;

  const sourceExt = path.extname(sourcePath).toLowerCase();

  // PDF files skip internal tags and keep .pdf extension
  if (sourceExt === '.pdf') {
    const finalPdfDest = destinationPath.replace(/\.(cbz|cbr|epub)$/i, '.pdf');
    fs.mkdirSync(path.dirname(finalPdfDest), { recursive: true });
    if (path.resolve(sourcePath) !== path.resolve(finalPdfDest)) {
      fs.copyFileSync(sourcePath, finalPdfDest);
      if (removeSourceAfterWrite) {
        fs.unlinkSync(sourcePath);
      }
    }
    return finalPdfDest;
  }

  // All non-PDF comic/manga formats (.cbz, .cbr, .epub) output as .cbz
  const finalCbzDest = destinationPath.replace(/\.(cbr|epub)$/i, '.cbz');
  fs.mkdirSync(path.dirname(finalCbzDest), { recursive: true });

  const outZip = new AdmZip();
  let pageCount = 0;

  if (sourceExt === '.epub') {
    const orderedImages = extractImagesFromEpubInReadingOrder(sourcePath);
    pageCount = orderedImages.length;
    orderedImages.forEach((img, index) => {
      const pageNum = String(index + 1).padStart(4, '0');
      outZip.addFile(`${pageNum}${img.ext}`, img.buffer);
    });
  } else if (sourceExt === '.cbr') {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taggermon-cbr-'));
    try {
      await extractCbrArchiveToDir(sourcePath, tempDir);
      const imageFiles = walkAllFiles(tempDir)
        .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

      pageCount = imageFiles.length;
      imageFiles.forEach((imgPath, index) => {
        const ext = path.extname(imgPath).toLowerCase();
        const normalizedExt = ext === '.jpeg' ? '.jpg' : ext;
        const pageNum = String(index + 1).padStart(4, '0');
        outZip.addFile(`${pageNum}${normalizedExt}`, fs.readFileSync(imgPath));
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } else {
    // Source is already .cbz
    const inZip = new AdmZip(sourcePath);
    for (const entry of inZip.getEntries()) {
      if (entry.isDirectory) continue;
      if (path.basename(entry.entryName).toLowerCase() === 'comicinfo.xml') {
        continue;
      }
      if (IMAGE_EXTENSIONS.has(path.extname(entry.entryName).toLowerCase())) {
        pageCount++;
      }
      outZip.addFile(entry.entryName, entry.getData());
    }
  }

  const comicInfoXml = buildComicInfoXml(tags, preservedExtraTags, pageCount);
  outZip.addFile('ComicInfo.xml', Buffer.from(comicInfoXml, 'utf8'));

  const tempOut = `${finalCbzDest}.tmp_${Date.now()}`;
  outZip.writeZip(tempOut);
  fs.renameSync(tempOut, finalCbzDest);

  if (
    removeSourceAfterWrite &&
    path.resolve(sourcePath) !== path.resolve(finalCbzDest) &&
    fs.existsSync(sourcePath)
  ) {
    fs.unlinkSync(sourcePath);
  }

  return finalCbzDest;
}
