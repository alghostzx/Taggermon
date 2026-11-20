import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getDb,
  getAllTemplates,
  getTemplateByMediaType,
  updateTemplate,
  extractTokensFromTemplateString,
} from '../../src/server/db.js';
import { ALL_MEDIA_TYPES } from '../../src/shared/constants.js';
import { createTestWorkspace, TestWorkspace } from '../test-helpers.js';

describe('Unit: SQLite Database & Template Persistence', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace('taggermon-db-unit-');
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('extracts distinct tokens from template strings while ignoring {ext}', () => {
    const tokens = extractTokensFromTemplateString(
      '{album_artist}/{year} - {album}/[{disc:02}-]{track:02} - {title}.{ext}'
    );
    expect(tokens).toEqual([
      'album_artist',
      'year',
      'album',
      'disc',
      'track',
      'title',
    ]);
  });

  it('seeds default templates for all 7 media types on initialization', () => {
    getDb();
    const templates = getAllTemplates();
    expect(Object.keys(templates).sort()).toEqual([...ALL_MEDIA_TYPES].sort());

    for (const mt of ALL_MEDIA_TYPES) {
      const tpl = getTemplateByMediaType(mt);
      expect(tpl.mediaType).toBe(mt);
      expect(tpl.pathTemplate.length).toBeGreaterThan(0);
      expect(tpl.filenameTemplate).toContain('.{ext}');
      expect(Array.isArray(tpl.requiredTags)).toBe(true);
      expect(tpl.stripContainerTagsByDefault).toBe(true);
    }
  });

  it('updates pathTemplate, filenameTemplate, whitelistedExtraTags, and stripContainerTagsByDefault', () => {
    const updatedMusic = updateTemplate('music', {
      pathTemplate: '{album_artist}/({year}) {album}',
      filenameTemplate: '{track:02}. {title} [{custom_tag}].{ext}',
      whitelistedExtraTags: ['replaygain_track_gain', 'replaygain_album_gain'],
      stripContainerTagsByDefault: false,
    });

    expect(updatedMusic.pathTemplate).toBe('{album_artist}/({year}) {album}');
    expect(updatedMusic.filenameTemplate).toBe(
      '{track:02}. {title} [{custom_tag}].{ext}'
    );
    expect(updatedMusic.requiredTags).toContain('custom_tag');
    expect(updatedMusic.whitelistedExtraTags).toEqual([
      'replaygain_track_gain',
      'replaygain_album_gain',
    ]);
    expect(updatedMusic.stripContainerTagsByDefault).toBe(false);

    // Persisted in SQLite
    const fetchedAgain = getTemplateByMediaType('music');
    expect(fetchedAgain.pathTemplate).toBe('{album_artist}/({year}) {album}');
    expect(fetchedAgain.whitelistedExtraTags).toContain(
      'replaygain_track_gain'
    );
  });

  it('throws an error when querying an invalid media type', () => {
    expect(() =>
      // @ts-expect-error testing invalid media type at runtime
      getTemplateByMediaType('invalid_type')
    ).toThrow(/Template not found/);
  });
});
