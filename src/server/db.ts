import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getConfigDir } from './config.js';
import { ALL_MEDIA_TYPES, MEDIA_TYPES_CONFIG } from '../shared/constants.js';
import { MediaTemplate, MediaType } from '../shared/types.js';

let dbInstance: Database.Database | null = null;

export function extractTokensFromTemplateString(tpl: string): string[] {
  const regex = /\{([a-zA-Z0-9_]+)(?::\d+)?\}/g;
  const tokens = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(tpl)) !== null) {
    if (match[1] !== 'ext') {
      tokens.add(match[1]);
    }
  }
  return Array.from(tokens);
}

export function getDb(customDbPath?: string): Database.Database {
  if (dbInstance && !customDbPath) {
    return dbInstance;
  }

  const dbPath =
    customDbPath || path.join(getConfigDir(), 'taggermon.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS media_templates (
      media_type TEXT PRIMARY KEY,
      path_template TEXT NOT NULL,
      filename_template TEXT NOT NULL,
      required_tags TEXT NOT NULL,
      whitelisted_extra_tags TEXT NOT NULL,
      strip_container_tags_by_default INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
  `);

  seedDefaultTemplates(db);

  if (!customDbPath) {
    dbInstance = db;
  }
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function seedDefaultTemplates(db: Database.Database): void {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO media_templates (
      media_type,
      path_template,
      filename_template,
      required_tags,
      whitelisted_extra_tags,
      strip_container_tags_by_default,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  for (const mediaType of ALL_MEDIA_TYPES) {
    const cfg = MEDIA_TYPES_CONFIG[mediaType];
    const tokens = Array.from(
      new Set([
        ...extractTokensFromTemplateString(cfg.defaultPathTemplate),
        ...extractTokensFromTemplateString(cfg.defaultFilenameTemplate),
        ...cfg.availableTags.map((t) => t.key),
      ])
    );

    insertStmt.run(
      mediaType,
      cfg.defaultPathTemplate,
      cfg.defaultFilenameTemplate,
      JSON.stringify(tokens),
      JSON.stringify([]),
      1,
      now
    );
  }
}

interface TemplateRow {
  media_type: MediaType;
  path_template: string;
  filename_template: string;
  required_tags: string;
  whitelisted_extra_tags: string;
  strip_container_tags_by_default: number;
  updated_at: string;
}

function rowToTemplate(row: TemplateRow): MediaTemplate {
  return {
    mediaType: row.media_type,
    pathTemplate: row.path_template,
    filenameTemplate: row.filename_template,
    requiredTags: JSON.parse(row.required_tags),
    whitelistedExtraTags: JSON.parse(row.whitelisted_extra_tags),
    stripContainerTagsByDefault: Boolean(row.strip_container_tags_by_default),
    updatedAt: row.updated_at,
  };
}

export function getAllTemplates(db = getDb()): Record<MediaType, MediaTemplate> {
  const rows = db
    .prepare('SELECT * FROM media_templates')
    .all() as TemplateRow[];
  const result = {} as Record<MediaType, MediaTemplate>;
  for (const row of rows) {
    result[row.media_type] = rowToTemplate(row);
  }
  return result;
}

export function getTemplateByMediaType(
  mediaType: MediaType,
  db = getDb()
): MediaTemplate {
  const row = db
    .prepare('SELECT * FROM media_templates WHERE media_type = ?')
    .get(mediaType) as TemplateRow | undefined;
  if (!row) {
    throw new Error(`Template not found for media type: ${mediaType}`);
  }
  return rowToTemplate(row);
}

export function updateTemplate(
  mediaType: MediaType,
  update: {
    pathTemplate: string;
    filenameTemplate: string;
    requiredTags?: string[];
    whitelistedExtraTags?: string[];
    stripContainerTagsByDefault?: boolean;
  },
  db = getDb()
): MediaTemplate {
  const existing = getTemplateByMediaType(mediaType, db);
  const pathTokens = extractTokensFromTemplateString(update.pathTemplate);
  const fileTokens = extractTokensFromTemplateString(update.filenameTemplate);
  const mergedRequired = Array.from(
    new Set([
      ...(update.requiredTags ?? existing.requiredTags),
      ...pathTokens,
      ...fileTokens,
    ])
  );

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE media_templates
    SET path_template = ?,
        filename_template = ?,
        required_tags = ?,
        whitelisted_extra_tags = ?,
        strip_container_tags_by_default = ?,
        updated_at = ?
    WHERE media_type = ?
  `).run(
    update.pathTemplate,
    update.filenameTemplate,
    JSON.stringify(mergedRequired),
    JSON.stringify(update.whitelistedExtraTags ?? existing.whitelistedExtraTags),
    (update.stripContainerTagsByDefault ?? existing.stripContainerTagsByDefault) ? 1 : 0,
    now,
    mediaType
  );

  return getTemplateByMediaType(mediaType, db);
}
