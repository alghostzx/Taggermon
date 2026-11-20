export type MediaType =
  | 'music'
  | 'audiobooks'
  | 'books'
  | 'comics'
  | 'manga'
  | 'movies'
  | 'series';

export interface MediaTypeMetadata {
  type: MediaType;
  label: string;
  mountEnv: string;
  defaultMountPath: string;
  supportsInternalTags: boolean;
  supportsCover: boolean;
  supportsCOV: boolean;
  supportsSubtitles: boolean;
  supportsTagCleaningOnly: boolean;
  availableTags: TagFieldDefinition[];
  defaultPathTemplate: string;
  defaultFilenameTemplate: string;
}

export interface TagFieldDefinition {
  key: string;
  label: string;
  isClusterLevel: boolean; // True if shared across folder (e.g. album, series, author), False if per-file (e.g. track, title, episode)
  isNumeric?: boolean;
  placeholder?: string;
}

export interface MediaTemplate {
  mediaType: MediaType;
  pathTemplate: string;
  filenameTemplate: string;
  requiredTags: string[]; // JSON array of tag keys included in template
  whitelistedExtraTags: string[]; // Extra tags allowed not to be cleaned automatically
  stripContainerTagsByDefault: boolean; // Used for movies/series (and optional for others)
  updatedAt: string;
}

export type ExtraFileAction = 'move' | 'use_as_cover' | 'ignore' | 'delete';

export interface ExtraFileItem {
  relativePath: string;
  filename: string;
  ext: string;
  sizeBytes: number;
  isImage: boolean;
  imageWidth?: number;
  imageHeight?: number;
  imageFormat?: string;
  defaultAction: ExtraFileAction;
}

export interface SubtitleItem {
  relativePath: string;
  filename: string;
  ext: string;
  matchedVideoRelativePath: string | null;
  languageCode: string; // e.g. 'pt-BR', 'en', ''
  isForced: boolean;
  isSdh: boolean;
}

export interface MediaFileItem {
  relativePath: string;
  filename: string;
  ext: string;
  sizeBytes: number;
  tags: Record<string, string>;
  unwantedTags: Record<string, string>;
  hasEmbeddedCover?: boolean;
  embeddedCoverMime?: string;
  needsConversionToCbz?: boolean;
  isPdfNoInternalTags?: boolean;
}

export interface ClusterScanResult {
  sourceRoot: 'downloads' | MediaType;
  clusterRelativePath: string;
  clusterName: string;
  detectedMediaType: MediaType;
  detectionConfidence: number;
  mediaFiles: MediaFileItem[];
  extraFiles: ExtraFileItem[];
  subtitles: SubtitleItem[];
}

export interface DiscoveredTagSuggestion {
  key: string;
  count: number;
  totalSampled: number;
  frequency: number;
  sampleValues: string[];
  isStandardTag: boolean;
}

export interface TemplateSuggestion {
  pathTemplate: string;
  filenameTemplate: string;
  confidence: number;
  matchCount: number;
  totalSampled: number;
  suggestedTags: string[];
  samplePreviews: Array<{
    originalPath: string;
    extractedTags: Record<string, string>;
  }>;
}
