import AdmZip from 'adm-zip';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

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

export interface BookInspectResult {
  tags: Record<string, string>;
  unwantedTags: Record<string, string>;
  hasEmbeddedCover: boolean;
  isPdfNoInternalTags: boolean;
}

function findOpfEntry(zip: AdmZip): AdmZip.IZipEntry | undefined {
  const containerEntry = zip.getEntry('META-INF/container.xml');
  if (containerEntry) {
    try {
      const parsed = xmlParser.parse(containerEntry.getData().toString('utf8'));
      const rf =
        parsed?.container?.rootfiles?.rootfile ||
        parsed?.container?.rootfiles?.['opf:rootfile'];
      const firstRf = Array.isArray(rf) ? rf[0] : rf;
      const fullPath = firstRf?.['@_full-path'];
      if (fullPath) {
        const entry = zip.getEntry(fullPath);
        if (entry) return entry;
      }
    } catch {
      // fallback
    }
  }
  return zip
    .getEntries()
    .find((e) => e.entryName.toLowerCase().endsWith('.opf'));
}

function extractTextFromNode(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).trim();
  }
  if (Array.isArray(node)) {
    return extractTextFromNode(node[0]);
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if ('#text' in obj) {
      return String(obj['#text']).trim();
    }
  }
  return '';
}

/**
 * Inspects a Book file (.epub, .mobi, .pdf).
 * PDF files dispense internal tags.
 */
export async function inspectBookFile(
  filePath: string,
  allowedTemplateTags: string[],
  whitelistedExtraTags: string[] = []
): Promise<BookInspectResult> {
  const ext = path.extname(filePath).toLowerCase();
  const allowedSet = new Set(allowedTemplateTags);
  const whitelistSet = new Set(whitelistedExtraTags.map((t) => t.toLowerCase()));

  if (ext === '.pdf') {
    return {
      tags: {},
      unwantedTags: {},
      hasEmbeddedCover: false,
      isPdfNoInternalTags: true,
    };
  }

  if (ext === '.epub') {
    try {
      const zip = new AdmZip(filePath);
      const opfEntry = findOpfEntry(zip);
      if (!opfEntry) {
        return {
          tags: {},
          unwantedTags: {},
          hasEmbeddedCover: false,
          isPdfNoInternalTags: false,
        };
      }

      const opfXml = opfEntry.getData().toString('utf8');
      const parsed = xmlParser.parse(opfXml);
      const pkg = parsed?.package || parsed?.['opf:package'];
      const metadata = pkg?.metadata || pkg?.['opf:metadata'] || {};

      const tags: Record<string, string> = {};
      const unwantedTags: Record<string, string> = {};

      const title = extractTextFromNode(metadata['dc:title'] ?? metadata.title);
      const author = extractTextFromNode(
        metadata['dc:creator'] ?? metadata.creator
      );
      const publisher = extractTextFromNode(
        metadata['dc:publisher'] ?? metadata.publisher
      );
      const date = extractTextFromNode(metadata['dc:date'] ?? metadata.date);
      const language = extractTextFromNode(
        metadata['dc:language'] ?? metadata.language
      );
      const genre = extractTextFromNode(
        metadata['dc:subject'] ?? metadata.subject
      );

      if (title && allowedSet.has('title')) tags.title = title;
      if (author && allowedSet.has('author')) tags.author = author;
      if (publisher && allowedSet.has('publisher')) tags.publisher = publisher;
      if (date && allowedSet.has('year')) {
        const yMatch = date.match(/\b(\d{4})\b/);
        tags.year = yMatch ? yMatch[1] : date;
      }
      if (language && allowedSet.has('language')) tags.language = language;
      if (genre && allowedSet.has('genre')) tags.genre = genre;

      // Check identifiers for ISBN
      const identifiersRaw = metadata['dc:identifier'] ?? metadata.identifier;
      const identifiers = Array.isArray(identifiersRaw)
        ? identifiersRaw
        : identifiersRaw
        ? [identifiersRaw]
        : [];
      for (const idNode of identifiers) {
        const text = extractTextFromNode(idNode);
        const scheme =
          typeof idNode === 'object' && idNode !== null
            ? String(
                (idNode as Record<string, unknown>)['@_opf:scheme'] ||
                  (idNode as Record<string, unknown>)['@_scheme'] ||
                  ''
              ).toLowerCase()
            : '';
        if (
          allowedSet.has('isbn') &&
          (scheme === 'isbn' || /^(97[89])?\d{9}[\dXx]$/.test(text.replace(/[-\s]/g, '')))
        ) {
          tags.isbn = text;
        }
      }

      // Check <meta> elements for calibre:series / calibre:series_index / cover
      const metasRaw = metadata.meta ?? metadata['opf:meta'];
      const metas = Array.isArray(metasRaw)
        ? metasRaw
        : metasRaw
        ? [metasRaw]
        : [];
      let hasEmbeddedCover = false;
      for (const m of metas) {
        if (!m || typeof m !== 'object') continue;
        const mObj = m as Record<string, unknown>;
        const name = String(mObj['@_name'] || mObj['@_property'] || '').toLowerCase();
        const content = String(mObj['@_content'] ?? mObj['#text'] ?? '').trim();
        if (name === 'cover') {
          hasEmbeddedCover = true;
        } else if (
          (name === 'calibre:series' || name === 'belongs-to-collection') &&
          allowedSet.has('series') &&
          content
        ) {
          tags.series = content;
        } else if (
          (name === 'calibre:series_index' || name === 'group-position') &&
          allowedSet.has('series_part') &&
          content
        ) {
          tags.series_part = content;
        } else if (name && content && !whitelistSet.has(name)) {
          unwantedTags[name] = content;
        }
      }

      // Check remaining dc:* elements not part of our core template mapping
      const knownDcKeys = new Set([
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
        'dc:identifier',
        'identifier',
        'meta',
        'opf:meta',
      ]);

      for (const [k, v] of Object.entries(metadata)) {
        if (k.startsWith('@_') || knownDcKeys.has(k)) continue;
        const val = extractTextFromNode(v);
        if (val && !whitelistSet.has(k.toLowerCase())) {
          unwantedTags[k] = val;
        }
      }

      return {
        tags,
        unwantedTags,
        hasEmbeddedCover,
        isPdfNoInternalTags: false,
      };
    } catch {
      return {
        tags: {},
        unwantedTags: {},
        hasEmbeddedCover: false,
        isPdfNoInternalTags: false,
      };
    }
  }

  if (ext === '.mobi' || ext === '.azw3') {
    try {
      const { stdout } = await execFileAsync('ebook-meta', [filePath]);
      const tags: Record<string, string> = {};
      const unwantedTags: Record<string, string> = {};
      for (const line of stdout.split('\n')) {
        const sepIdx = line.indexOf(':');
        if (sepIdx === -1) continue;
        const rawKey = line.slice(0, sepIdx).trim();
        const rawVal = line.slice(sepIdx + 1).trim();
        if (!rawVal) continue;
        const lower = rawKey.toLowerCase();
        if (lower === 'title' && allowedSet.has('title')) tags.title = rawVal;
        else if (lower.startsWith('author') && allowedSet.has('author'))
          tags.author = rawVal.replace(/\s*\[[^\]]+\]$/, '');
        else if (lower === 'publisher' && allowedSet.has('publisher'))
          tags.publisher = rawVal;
        else if (lower === 'published' && allowedSet.has('year')) {
          const ym = rawVal.match(/\b(\d{4})\b/);
          if (ym) tags.year = ym[1];
        } else if (lower === 'languages' && allowedSet.has('language'))
          tags.language = rawVal;
        else if (lower === 'tags' && allowedSet.has('genre'))
          tags.genre = rawVal;
        else if (lower === 'series' && allowedSet.has('series')) {
          const sm = rawVal.match(/^(.+?)(?:\s+#(\d+(?:\.\d+)?))?$/);
          if (sm) {
            tags.series = sm[1].trim();
            if (sm[2] && allowedSet.has('series_part')) tags.series_part = sm[2];
          }
        } else if (!whitelistSet.has(lower)) {
          unwantedTags[rawKey] = rawVal;
        }
      }
      return {
        tags,
        unwantedTags,
        hasEmbeddedCover: false,
        isPdfNoInternalTags: false,
      };
    } catch {
      return {
        tags: {},
        unwantedTags: {},
        hasEmbeddedCover: false,
        isPdfNoInternalTags: false,
      };
    }
  }

  return {
    tags: {},
    unwantedTags: {},
    hasEmbeddedCover: false,
    isPdfNoInternalTags: false,
  };
}

/**
 * Processes a Book file (.epub, .mobi, .pdf):
 * - If `.pdf`: skips internal tag modification and moves/copies to destinationPath.
 * - If `.epub`: updates `content.opf` XML directly with template tags, removes unwanted metadata nodes, and optionally replaces cover image.
 * - If `.mobi`: updates metadata via Calibre `ebook-meta` (if available) or converts to `.epub` if `convertMobiToEpub` is requested.
 */
export async function processBookFile(options: {
  sourcePath: string;
  destinationPath: string;
  tags: Record<string, string>;
  preservedExtraTags?: Record<string, string>;
  coverImagePath?: string | null;
  convertMobiToEpub?: boolean;
  removeSourceAfterWrite?: boolean;
}): Promise<string> {
  const {
    sourcePath,
    destinationPath,
    tags,
    preservedExtraTags = {},
    coverImagePath,
    convertMobiToEpub = false,
    removeSourceAfterWrite = false,
  } = options;

  const sourceExt = path.extname(sourcePath).toLowerCase();

  if (sourceExt === '.pdf') {
    const finalPdfDest = destinationPath.replace(/\.(epub|mobi|azw3)$/i, '.pdf');
    fs.mkdirSync(path.dirname(finalPdfDest), { recursive: true });
    if (path.resolve(sourcePath) !== path.resolve(finalPdfDest)) {
      fs.copyFileSync(sourcePath, finalPdfDest);
      if (removeSourceAfterWrite) {
        fs.unlinkSync(sourcePath);
      }
    }
    return finalPdfDest;
  }

  if (sourceExt === '.mobi' || sourceExt === '.azw3') {
    if (convertMobiToEpub) {
      const epubDest = destinationPath.replace(/\.(mobi|azw3)$/i, '.epub');
      fs.mkdirSync(path.dirname(epubDest), { recursive: true });
      await execFileAsync('ebook-convert', [sourcePath, epubDest]);
      await updateEpubOpfAndCover(
        epubDest,
        epubDest,
        tags,
        preservedExtraTags,
        coverImagePath
      );
      if (removeSourceAfterWrite && fs.existsSync(sourcePath)) {
        fs.unlinkSync(sourcePath);
      }
      return epubDest;
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (path.resolve(sourcePath) !== path.resolve(destinationPath)) {
      fs.copyFileSync(sourcePath, destinationPath);
    }

    // Try updating via Calibre ebook-meta CLI if installed
    try {
      const args: string[] = [destinationPath];
      if (tags.title) args.push('--title', tags.title);
      if (tags.author) args.push('--authors', tags.author);
      if (tags.publisher) args.push('--publisher', tags.publisher);
      if (tags.year) args.push('--date', `${tags.year}-01-01`);
      if (tags.language) args.push('--language', tags.language);
      if (tags.genre) args.push('--tags', tags.genre);
      if (tags.series) args.push('--series', tags.series);
      if (tags.series_part) args.push('--index', tags.series_part);
      if (tags.isbn) args.push('--isbn', tags.isbn);
      if (coverImagePath && fs.existsSync(coverImagePath)) {
        args.push('--cover', coverImagePath);
      }
      await execFileAsync('ebook-meta', args);
    } catch {
      // If ebook-meta is not installed on host, file is still organized at destinationPath
    }

    if (
      removeSourceAfterWrite &&
      path.resolve(sourcePath) !== path.resolve(destinationPath) &&
      fs.existsSync(sourcePath)
    ) {
      fs.unlinkSync(sourcePath);
    }
    return destinationPath;
  }

  // Standard .epub handling
  const finalEpubDest = destinationPath.replace(/\.(mobi|azw3|pdf)$/i, '.epub');
  await updateEpubOpfAndCover(
    sourcePath,
    finalEpubDest,
    tags,
    preservedExtraTags,
    coverImagePath
  );

  if (
    removeSourceAfterWrite &&
    path.resolve(sourcePath) !== path.resolve(finalEpubDest) &&
    fs.existsSync(sourcePath)
  ) {
    fs.unlinkSync(sourcePath);
  }

  return finalEpubDest;
}

async function updateEpubOpfAndCover(
  sourceEpubPath: string,
  destEpubPath: string,
  tags: Record<string, string>,
  preservedExtraTags: Record<string, string>,
  coverImagePath?: string | null
): Promise<void> {
  fs.mkdirSync(path.dirname(destEpubPath), { recursive: true });
  const zip = new AdmZip(sourceEpubPath);
  const opfEntry = findOpfEntry(zip);

  if (opfEntry) {
    const opfXml = opfEntry.getData().toString('utf8');
    const parsed = xmlParser.parse(opfXml);
    const pkgKey = parsed.package ? 'package' : 'opf:package';
    const pkg = parsed[pkgKey] || {};
    const metaKey = pkg.metadata ? 'metadata' : 'opf:metadata';
    const existingMeta = pkg[metaKey] || {};

    // Rebuild clean metadata object keeping XML namespace attributes
    const cleanMeta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(existingMeta)) {
      if (k.startsWith('@_')) {
        cleanMeta[k] = v;
      }
    }
    if (!cleanMeta['@_xmlns:dc']) {
      cleanMeta['@_xmlns:dc'] = 'http://purl.org/dc/elements/1.1/';
    }
    if (!cleanMeta['@_xmlns:opf']) {
      cleanMeta['@_xmlns:opf'] = 'http://www.idpf.org/2007/opf';
    }

    if (tags.title) cleanMeta['dc:title'] = tags.title;
    if (tags.author) {
      cleanMeta['dc:creator'] = {
        '#text': tags.author,
        '@_opf:role': 'aut',
      };
    }
    if (tags.publisher) cleanMeta['dc:publisher'] = tags.publisher;
    if (tags.year) cleanMeta['dc:date'] = tags.year;
    if (tags.language) cleanMeta['dc:language'] = tags.language;
    if (tags.genre) cleanMeta['dc:subject'] = tags.genre;

    // Preserve primary unique-identifier so EPUB validation stays valid, plus ISBN if provided
    const identifiers: Array<Record<string, unknown> | string> = [];
    if (tags.isbn) {
      identifiers.push({
        '#text': tags.isbn,
        '@_id': 'BookId',
        '@_opf:scheme': 'ISBN',
      });
    } else if (existingMeta['dc:identifier']) {
      const firstId = Array.isArray(existingMeta['dc:identifier'])
        ? existingMeta['dc:identifier'][0]
        : existingMeta['dc:identifier'];
      identifiers.push(firstId);
    } else {
      identifiers.push({
        '#text': `urn:uuid:taggermon-${Date.now()}`,
        '@_id': 'BookId',
      });
    }
    cleanMeta['dc:identifier'] =
      identifiers.length === 1 ? identifiers[0] : identifiers;

    const metaList: Array<Record<string, string>> = [];
    if (tags.series) {
      metaList.push({
        '@_name': 'calibre:series',
        '@_content': tags.series,
      });
    }
    if (tags.series_part) {
      metaList.push({
        '@_name': 'calibre:series_index',
        '@_content': tags.series_part,
      });
    }

    // Handle optional cover replacement in EPUB
    if (coverImagePath && fs.existsSync(coverImagePath)) {
      const coverBuf = fs.readFileSync(coverImagePath);
      const coverExt =
        path.extname(coverImagePath).toLowerCase() === '.png' ? '.png' : '.jpg';
      const coverMime = coverExt === '.png' ? 'image/png' : 'image/jpeg';
      const opfDir = path.posix.dirname(opfEntry.entryName);
      const coverHref = `taggermon_cover${coverExt}`;
      const coverZipPath =
        opfDir === '.' || opfDir === ''
          ? coverHref
          : path.posix.join(opfDir, coverHref);

      zip.addFile(coverZipPath, coverBuf);

      // Ensure manifest contains item id="cover-image"
      const manifestKey = pkg.manifest ? 'manifest' : 'opf:manifest';
      if (pkg[manifestKey]) {
        const itemsRaw = pkg[manifestKey].item || [];
        const items = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];
        const filtered = items.filter(
          (it: Record<string, unknown>) =>
            it?.['@_id'] !== 'cover-image' &&
            it?.['@_properties'] !== 'cover-image'
        );
        filtered.push({
          '@_id': 'cover-image',
          '@_href': coverHref,
          '@_media-type': coverMime,
          '@_properties': 'cover-image',
        });
        pkg[manifestKey].item = filtered;
      }

      metaList.push({
        '@_name': 'cover',
        '@_content': 'cover-image',
      });
    }

    for (const [k, v] of Object.entries(preservedExtraTags)) {
      if (k.startsWith('dc:')) {
        cleanMeta[k] = v;
      } else {
        metaList.push({
          '@_name': k,
          '@_content': v,
        });
      }
    }

    if (metaList.length > 0) {
      cleanMeta.meta = metaList;
    }

    pkg[metaKey] = cleanMeta;
    parsed[pkgKey] = pkg;

    const newOpfXml = `<?xml version="1.0" encoding="utf-8"?>\n${xmlBuilder.build(
      parsed
    )}`;
    zip.updateFile(opfEntry.entryName, Buffer.from(newOpfXml, 'utf8'));
  }

  const tempOut = `${destEpubPath}.tmp_${Date.now()}`;
  zip.writeZip(tempOut);
  fs.renameSync(tempOut, destEpubPath);
}
