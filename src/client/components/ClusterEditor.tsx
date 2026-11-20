import React, { useEffect, useMemo, useState } from 'react';
import {
  Wand2,
  Hash,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Film,
  Subtitles,
  Sparkles,
  Play,
  Loader2,
  ArrowRight,
} from 'lucide-react';
import {
  ClusterScanResult,
  ExtraFileAction,
  MediaTemplate,
  MediaType,
  SubtitleItem,
} from '../../shared/types';
import { ALL_MEDIA_TYPES, MEDIA_TYPES_CONFIG } from '../../shared/constants';
import { CoverSection, SelectedCoverState } from './CoverSection';

interface ClusterEditorProps {
  scan: ClusterScanResult;
  templates: Record<MediaType, MediaTemplate>;
  onChangeMediaType: (newType: MediaType) => void;
  onProcessComplete: () => void;
}

export const ClusterEditor: React.FC<ClusterEditorProps> = ({
  scan,
  templates,
  onChangeMediaType,
  onProcessComplete,
}) => {
  const mediaType = scan.detectedMediaType;
  const meta = MEDIA_TYPES_CONFIG[mediaType];
  const currentTemplate = templates[mediaType];

  // Cluster-level shared tag state (e.g. album_artist, album, year, series, author)
  const [clusterTags, setClusterTags] = useState<Record<string, string>>({});

  // Per-file tag state: map of relativePath -> Record<tagKey, value>
  const [fileTagsMap, setFileTagsMap] = useState<
    Record<string, Record<string, string>>
  >({});

  // Unwanted tags state: map of relativePath -> Record<unwantedKey, { value: string; remove: boolean }>
  const [unwantedMap, setUnwantedMap] = useState<
    Record<string, Record<string, { value: string; remove: boolean }>>
  >({});

  // Extra files actions
  const [extraActions, setExtraActions] = useState<
    Record<string, ExtraFileAction>
  >({});

  // Subtitles state
  const [subtitlesState, setSubtitlesState] = useState<SubtitleItem[]>([]);

  // Options
  const [stripContainerTags, setStripContainerTags] = useState(true);
  const [convertMobiToEpub, setConvertMobiToEpub] = useState(false);
  const [
    deleteIgnoredExtrasAndCleanupSource,
    setDeleteIgnoredExtrasAndCleanupSource,
  ] = useState(true);

  // Selected Cover
  const [selectedCover, setSelectedCover] = useState<SelectedCoverState>({
    mode: 'none',
  });

  // Filename pattern parser tool
  const [extractPattern, setExtractPattern] = useState('');
  const [showExtractTool, setShowExtractTool] = useState(false);

  // Destination previews
  const [destPreviews, setDestPreviews] = useState<
    Record<string, string>
  >({});

  // Processing status
  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);
  const [processSuccessMsg, setProcessSuccessMsg] = useState<string | null>(
    null
  );

  // Initialize state when `scan` changes
  useEffect(() => {
    const nextFileTags: Record<string, Record<string, string>> = {};
    const nextUnwanted: Record<
      string,
      Record<string, { value: string; remove: boolean }>
    > = {};
    const nextClusterTags: Record<string, string> = {};

    const clusterLevelKeys = meta.availableTags
      .filter((t) => t.isClusterLevel)
      .map((t) => t.key);

    for (const file of scan.mediaFiles) {
      nextFileTags[file.relativePath] = { ...file.tags };
      for (const ck of clusterLevelKeys) {
        if (!nextClusterTags[ck] && file.tags[ck]) {
          nextClusterTags[ck] = file.tags[ck];
        }
      }

      const uw: Record<string, { value: string; remove: boolean }> = {};
      for (const [uk, uv] of Object.entries(file.unwantedTags)) {
        uw[uk] = { value: uv, remove: true }; // Default: remove unwanted tags
      }
      nextUnwanted[file.relativePath] = uw;
    }

    // Ensure cluster-level values are populated in every file too
    for (const file of scan.mediaFiles) {
      for (const ck of clusterLevelKeys) {
        if (nextClusterTags[ck] && !nextFileTags[file.relativePath][ck]) {
          nextFileTags[file.relativePath][ck] = nextClusterTags[ck];
        }
      }
    }

    const nextExtras: Record<string, ExtraFileAction> = {};
    let defaultCoverImg: string | undefined;
    for (const extra of scan.extraFiles) {
      nextExtras[extra.relativePath] = extra.defaultAction;
      if (extra.defaultAction === 'use_as_cover' && !defaultCoverImg) {
        defaultCoverImg = extra.relativePath;
      }
    }

    if (defaultCoverImg) {
      const imgObj = scan.extraFiles.find(
        (e) => e.relativePath === defaultCoverImg
      );
      setSelectedCover({
        mode: 'extra_file',
        extraFileRelativePath: defaultCoverImg,
        label: imgObj?.filename,
        width: imgObj?.imageWidth,
        height: imgObj?.imageHeight,
        format: imgObj?.imageFormat,
        sizeBytes: imgObj?.sizeBytes,
      });
    } else {
      setSelectedCover({ mode: 'none' });
    }

    setClusterTags(nextClusterTags);
    setFileTagsMap(nextFileTags);
    setUnwantedMap(nextUnwanted);
    setExtraActions(nextExtras);
    setSubtitlesState(scan.subtitles || []);
    setStripContainerTags(
      currentTemplate?.stripContainerTagsByDefault ?? true
    );
    setExtractPattern(
      currentTemplate?.filenameTemplate.replace(/\.\{ext\}$/, '') || ''
    );
    setProcessError(null);
    setProcessSuccessMsg(null);
  }, [scan, mediaType]);

  // Synchronize cover selection with extraFiles action dropdown
  const handleSelectCover = (cover: SelectedCoverState) => {
    setSelectedCover(cover);
    if (cover.mode === 'extra_file' && cover.extraFileRelativePath) {
      setExtraActions((prev) => {
        const updated = { ...prev };
        for (const k of Object.keys(updated)) {
          if (updated[k] === 'use_as_cover') {
            updated[k] = 'ignore';
          }
        }
        updated[cover.extraFileRelativePath!] = 'use_as_cover';
        return updated;
      });
    }
  };

  // Update live destination path previews whenever tags or template change
  useEffect(() => {
    if (!currentTemplate || scan.mediaFiles.length === 0) return;

    const timer = setTimeout(async () => {
      try {
        const resp = await fetch('/api/preview-destinations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mediaType,
            pathTemplate: currentTemplate.pathTemplate,
            filenameTemplate: currentTemplate.filenameTemplate,
            convertMobiToEpub,
            files: scan.mediaFiles.map((f) => ({
              relativePath: f.relativePath,
              ext: f.ext,
              tags: fileTagsMap[f.relativePath] || {},
            })),
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          const map: Record<string, string> = {};
          for (const p of data.previews || []) {
            map[p.relativePath] = p.destinationFullRelativePath;
          }
          setDestPreviews(map);
        }
      } catch {
        // ignore preview error
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [
    fileTagsMap,
    mediaType,
    currentTemplate,
    convertMobiToEpub,
    scan.mediaFiles,
  ]);

  const handleClusterTagChange = (key: string, value: string) => {
    setClusterTags((prev) => ({ ...prev, [key]: value }));
    setFileTagsMap((prev) => {
      const next = { ...prev };
      for (const relPath of Object.keys(next)) {
        next[relPath] = { ...next[relPath], [key]: value };
      }
      return next;
    });
  };

  const handleFileTagChange = (
    relativePath: string,
    key: string,
    value: string
  ) => {
    setFileTagsMap((prev) => ({
      ...prev,
      [relativePath]: {
        ...(prev[relativePath] || {}),
        [key]: value,
      },
    }));
  };

  // Auto-number tracks / chapters / episodes sequentially (1..N)
  const handleAutoNumber = () => {
    const numberKey =
      mediaType === 'series'
        ? 'episode'
        : mediaType === 'comics' || mediaType === 'manga'
        ? 'number'
        : 'track';

    const totalKey =
      mediaType === 'music' || mediaType === 'audiobooks'
        ? 'total_tracks'
        : null;

    const totalCount = String(scan.mediaFiles.length);
    if (totalKey) {
      setClusterTags((prev) => ({ ...prev, [totalKey]: totalCount }));
    }

    setFileTagsMap((prev) => {
      const next = { ...prev };
      scan.mediaFiles.forEach((f, idx) => {
        const updated = {
          ...(next[f.relativePath] || {}),
          [numberKey]: String(idx + 1),
        };
        if (totalKey) {
          updated[totalKey] = totalCount;
        }
        next[f.relativePath] = updated;
      });
      return next;
    });
  };

  // Extract tags from current filenames using pattern
  const handleExtractFromFilenames = async () => {
    if (!extractPattern.trim()) return;
    const inputs = scan.mediaFiles.map((f) => ({
      id: f.relativePath,
      text: f.filename.replace(/\.[^.]+$/, ''),
    }));

    const resp = await fetch('/api/parse-pattern', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: extractPattern.trim(),
        inputs,
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const clusterKeys = new Set(
        meta.availableTags.filter((t) => t.isClusterLevel).map((t) => t.key)
      );
      const discoveredCluster: Record<string, string> = {};

      setFileTagsMap((prev) => {
        const next = { ...prev };
        for (const item of data.results || []) {
          const merged = { ...(next[item.id] || {}), ...item.extracted };
          next[item.id] = merged;
          for (const [k, v] of Object.entries(
            item.extracted as Record<string, string>
          )) {
            if (clusterKeys.has(k) && v && !discoveredCluster[k]) {
              discoveredCluster[k] = v;
            }
          }
        }
        return next;
      });

      if (Object.keys(discoveredCluster).length > 0) {
        setClusterTags((prev) => ({ ...prev, ...discoveredCluster }));
      }
    }
  };

  // Aggregate all distinct unwanted tags across the cluster
  const allUnwantedEntries = useMemo(() => {
    const list: Array<{
      relativePath: string;
      filename: string;
      tagKey: string;
      value: string;
      remove: boolean;
    }> = [];
    for (const f of scan.mediaFiles) {
      const uw = unwantedMap[f.relativePath] || {};
      for (const [k, info] of Object.entries(uw)) {
        list.push({
          relativePath: f.relativePath,
          filename: f.filename,
          tagKey: k,
          value: info.value,
          remove: info.remove,
        });
      }
    }
    return list;
  }, [scan.mediaFiles, unwantedMap]);

  const toggleAllUnwanted = (remove: boolean) => {
    setUnwantedMap((prev) => {
      const next: typeof prev = {};
      for (const [relPath, tags] of Object.entries(prev)) {
        next[relPath] = {};
        for (const [k, info] of Object.entries(tags)) {
          next[relPath][k] = { ...info, remove };
        }
      }
      return next;
    });
  };

  const handleExecuteProcess = async () => {
    setProcessing(true);
    setProcessError(null);
    setProcessSuccessMsg(null);

    try {
      const filesPayload = scan.mediaFiles.map((f) => {
        const uw = unwantedMap[f.relativePath] || {};
        const preservedExtraTags: Record<string, string> = {};
        for (const [k, info] of Object.entries(uw)) {
          if (!info.remove) {
            preservedExtraTags[k] = info.value;
          }
        }
        return {
          relativePath: f.relativePath,
          tags: fileTagsMap[f.relativePath] || {},
          preservedExtraTags,
        };
      });

      const extraFilesPayload = scan.extraFiles.map((ef) => ({
        relativePath: ef.relativePath,
        action: extraActions[ef.relativePath] || ef.defaultAction,
      }));

      const resp = await fetch('/api/process-cluster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceRoot: scan.sourceRoot,
          clusterRelativePath: scan.clusterRelativePath,
          targetMediaType: mediaType,
          pathTemplate: currentTemplate?.pathTemplate,
          filenameTemplate: currentTemplate?.filenameTemplate,
          stripContainerTags,
          convertMobiToEpub,
          deleteIgnoredExtrasAndCleanupSource,
          coverSelection: selectedCover,
          files: filesPayload,
          extraFiles: extraFilesPayload,
          subtitles: subtitlesState,
        }),
      });

      const result = await resp.json();
      if (!resp.ok) {
        throw new Error(result.error || 'Erro ao processar arquivos');
      }

      setProcessSuccessMsg(
        `Processados ${result.processedFiles.length} arquivo(s) para ${meta.defaultMountPath}` +
          (result.folderCoverSavedAs
            ? ` (Capa salva em ${result.folderCoverSavedAs})`
            : '')
      );
      setTimeout(() => {
        onProcessComplete();
      }, 1200);
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing(false);
    }
  };

  const activeRequiredSet = useMemo(
    () =>
      new Set(
        currentTemplate?.requiredTags && currentTemplate.requiredTags.length > 0
          ? currentTemplate.requiredTags
          : meta.availableTags.map((t) => t.key)
      ),
    [currentTemplate, meta.availableTags]
  );

  const allActiveTagDefinitions = useMemo(() => {
    const standardMap = new Map(meta.availableTags.map((t) => [t.key, t]));
    const defs = meta.availableTags.filter((t) => activeRequiredSet.has(t.key));
    for (const rk of activeRequiredSet) {
      if (!standardMap.has(rk)) {
        defs.push({
          key: rk,
          label: rk,
          isClusterLevel: false,
        });
      }
    }
    return defs;
  }, [meta.availableTags, activeRequiredSet]);

  const clusterLevelFields = allActiveTagDefinitions.filter(
    (t) => t.isClusterLevel
  );
  const fileLevelFields = allActiveTagDefinitions.filter(
    (t) => !t.isClusterLevel
  );
  const extraImages = scan.extraFiles.filter((e) => e.isImage);

  return (
    <div className="space-y-6">
      {/* Header Bar: Cluster Title & Media Type Switcher */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              {scan.sourceRoot === 'downloads' ? 'Download' : 'Biblioteca'}
            </span>
            <h2 className="text-lg font-bold text-white truncate">
              {scan.clusterName}
            </h2>
          </div>
          <p className="text-xs text-slate-400 font-mono mt-1">
            Origem: {scan.clusterRelativePath} → Destino:{' '}
            <span className="text-indigo-400">{meta.defaultMountPath}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-slate-400">
              Tipo de Mídia do Cluster:
            </label>
            <select
              value={mediaType}
              onChange={(e) => onChangeMediaType(e.target.value as MediaType)}
              className="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-sm font-medium text-white focus:border-indigo-500 focus:outline-none"
            >
              {ALL_MEDIA_TYPES.map((mt) => (
                <option key={mt} value={mt}>
                  {MEDIA_TYPES_CONFIG[mt].label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => setShowExtractTool(!showExtractTool)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
          >
            <Wand2 className="w-3.5 h-3.5 text-amber-400" />
            Extrair do Nome do Arquivo
          </button>

          {fileLevelFields.some((f) =>
            ['track', 'episode', 'number'].includes(f.key)
          ) && (
            <button
              type="button"
              onClick={handleAutoNumber}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
            >
              <Hash className="w-3.5 h-3.5 text-indigo-400" />
              Auto-Numerar (1..{scan.mediaFiles.length})
            </button>
          )}
        </div>
      </div>

      {/* Extract from Filename Pattern Tool */}
      {showExtractTool && (
        <div className="bg-amber-950/20 border border-amber-500/30 rounded-xl p-4 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[260px]">
            <label className="block text-xs font-medium text-amber-300 mb-1">
              Padrão de Tokens para Extrair do Nome Atual dos Arquivos (sem extensão):
            </label>
            <input
              type="text"
              value={extractPattern}
              onChange={(e) => setExtractPattern(e.target.value)}
              placeholder="Ex: {track:02} - {title} ou {series} - S{season:02}E{episode:02}"
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-xs font-mono text-white"
            />
          </div>
          <button
            type="button"
            onClick={handleExtractFromFilenames}
            className="mt-5 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs transition"
          >
            Aplicar Extração em Lote
          </button>
        </div>
      )}

      {/* Special Notice Banner for Movies/Series, Manga/Comics Conversion, or PDFs */}
      {(mediaType === 'movies' || mediaType === 'series') && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Film className="w-5 h-5 text-indigo-400 shrink-0" />
            <div className="text-xs text-slate-300">
              <strong>{meta.label}:</strong> Dispensa edição de tags internas. Os campos abaixo formatam apenas as pastas e nomes de arquivos (e renomeiam legendas acompanhantes).
            </div>
          </div>
          <label className="flex items-center gap-2.5 cursor-pointer bg-slate-950 px-3.5 py-2 rounded-lg border border-slate-800">
            <input
              type="checkbox"
              checked={stripContainerTags}
              onChange={(e) => setStripContainerTags(e.target.checked)}
              className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-indigo-600"
            />
            <span className="text-xs font-medium text-slate-200">
              Limpar tags internas do container (via ffmpeg/mkvpropedit)
            </span>
          </label>
        </div>
      )}

      {(mediaType === 'comics' || mediaType === 'manga') &&
        scan.mediaFiles.some((f) => f.needsConversionToCbz) && (
          <div className="bg-indigo-950/30 border border-indigo-500/40 rounded-xl p-4 flex items-center gap-3 text-xs text-indigo-200">
            <Sparkles className="w-5 h-5 text-indigo-400 shrink-0" />
            <div>
              <strong>Conversão Automática para .CBZ Ativa:</strong> Arquivos{' '}
              <code>.cbr</code> e <code>.epub</code> deste cluster terão suas páginas extraídas na ordem real de leitura (seguindo a <code>&lt;spine&gt;</code> no EPUB), renomeadas sequencialmente (<code>0001.jpg</code>, <code>0002.jpg</code>...) e empacotadas em <code>.cbz</code> com o <code>ComicInfo.xml</code> limpo.
            </div>
          </div>
        )}

      {scan.mediaFiles.some((f) => f.isPdfNoInternalTags) && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center gap-3 text-xs text-slate-300">
          <FileText className="w-5 h-5 text-amber-400 shrink-0" />
          <div>
            <strong>Arquivos PDF Detectados:</strong> Conforme configurado, arquivos <code>.pdf</code> dispensam gravação de tags internas e terão somente seus caminhos de pasta e nomes de arquivo formatados pelo template.
          </div>
        </div>
      )}

      {/* Cover Section for Music, Audiobooks, and Books */}
      {meta.supportsCover && (
        <CoverSection
          sourceRoot={scan.sourceRoot}
          clusterRelativePath={scan.clusterRelativePath}
          mediaType={mediaType}
          artistQuery={
            clusterTags.album_artist ||
            clusterTags.artist ||
            clusterTags.author ||
            ''
          }
          albumQuery={
            clusterTags.album ||
            clusterTags.book_title ||
            clusterTags.title ||
            scan.clusterName
          }
          extraImages={extraImages}
          hasEmbeddedCoverInFirstFile={Boolean(
            scan.mediaFiles[0]?.hasEmbeddedCover
          )}
          firstFileRelativePath={scan.mediaFiles[0]?.relativePath}
          selectedCover={selectedCover}
          onSelectCover={handleSelectCover}
        />
      )}

      {/* Cluster-Level Shared Fields */}
      {clusterLevelFields.length > 0 && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-white">
            Dados Comuns do Cluster (Aplicados a todos os arquivos da pasta)
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {clusterLevelFields.map((field) => (
              <div key={field.key} className="space-y-1">
                <label className="block text-xs font-medium text-slate-400">
                  {field.label}{' '}
                  <code className="text-indigo-400">{`{${field.key}}`}</code>
                </label>
                <input
                  type="text"
                  value={clusterTags[field.key] || ''}
                  onChange={(e) =>
                    handleClusterTagChange(field.key, e.target.value)
                  }
                  placeholder={field.placeholder}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>
            ))}
          </div>

          {mediaType === 'books' &&
            scan.mediaFiles.some((f) =>
              ['mobi', 'azw3'].includes(f.ext.toLowerCase())
            ) && (
              <div className="pt-2">
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={convertMobiToEpub}
                    onChange={(e) => setConvertMobiToEpub(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-700 bg-slate-950 text-indigo-600"
                  />
                  <span>
                    Converter arquivos <code>.mobi / .azw3</code> para{' '}
                    <code>.epub</code> ao salvar
                  </span>
                </label>
              </div>
            )}
        </div>
      )}

      {/* Per-File Table & Live Path Previews */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">
            Arquivos de Mídia ({scan.mediaFiles.length}) & Preview de Caminho/Nome Final
          </h3>
          <span className="text-xs font-mono text-slate-400">
            Template: {currentTemplate?.pathTemplate}/{currentTemplate?.filenameTemplate}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/60 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                <th className="py-3 px-4">Arquivo Atual</th>
                {fileLevelFields.map((field) => (
                  <th key={field.key} className="py-3 px-3">
                    {field.label} ({`{${field.key}}`})
                  </th>
                ))}
                <th className="py-3 px-4">Preview Destino na Biblioteca</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 text-xs">
              {scan.mediaFiles.map((file) => {
                const fTags = fileTagsMap[file.relativePath] || {};
                const previewDest = destPreviews[file.relativePath] || '...';
                return (
                  <tr
                    key={file.relativePath}
                    className="hover:bg-slate-800/30 transition"
                  >
                    <td className="py-2.5 px-4 font-mono text-slate-300 max-w-[240px] truncate">
                      <div title={file.relativePath} className="truncate">
                        {file.filename}
                      </div>
                      {file.needsConversionToCbz && (
                        <span className="inline-block mt-0.5 px-1.5 py-0.2 rounded text-[10px] bg-indigo-500/20 text-indigo-300">
                          Converter → .cbz
                        </span>
                      )}
                      {file.isPdfNoInternalTags && (
                        <span className="inline-block mt-0.5 px-1.5 py-0.2 rounded text-[10px] bg-amber-500/20 text-amber-300">
                          PDF (Somente Caminho/Nome)
                        </span>
                      )}
                    </td>

                    {fileLevelFields.map((field) => (
                      <td key={field.key} className="py-2 px-3">
                        <input
                          type="text"
                          value={fTags[field.key] || ''}
                          onChange={(e) =>
                            handleFileTagChange(
                              file.relativePath,
                              field.key,
                              e.target.value
                            )
                          }
                          placeholder={field.placeholder}
                          className={`px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-xs text-white focus:border-indigo-500 focus:outline-none ${
                            field.isNumeric ? 'w-20 font-mono' : 'w-full min-w-[160px]'
                          }`}
                        />
                      </td>
                    ))}

                    <td className="py-2.5 px-4 font-mono text-emerald-400 max-w-[340px]">
                      <div
                        className="flex items-center gap-1.5 truncate"
                        title={`${meta.defaultMountPath}/${previewDest}`}
                      >
                        <ArrowRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                        <span className="truncate">{previewDest}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Subtitles Matcher & Renamer Section (for Movies & Series) */}
      {meta.supportsSubtitles && subtitlesState.length > 0 && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Subtitles className="w-4 h-4 text-indigo-400" />
            <span>
              Arquivos de Legenda Acompanhantes ({subtitlesState.length}) — Renomeados e Movidos Automaticamente
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 px-3">Legenda Original</th>
                  <th className="py-2 px-3">Associada ao Vídeo</th>
                  <th className="py-2 px-3">Idioma (ex: pt-BR, en)</th>
                  <th className="py-2 px-3">Flags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {subtitlesState.map((sub, idx) => (
                  <tr key={sub.relativePath}>
                    <td className="py-2 px-3 font-mono text-slate-300">
                      {sub.relativePath}
                    </td>
                    <td className="py-2 px-3">
                      <select
                        value={sub.matchedVideoRelativePath || ''}
                        onChange={(e) => {
                          const val = e.target.value || null;
                          setSubtitlesState((prev) =>
                            prev.map((s, i) =>
                              i === idx
                                ? { ...s, matchedVideoRelativePath: val }
                                : s
                            )
                          );
                        }}
                        className="px-2.5 py-1 rounded bg-slate-950 border border-slate-700 text-xs text-slate-200"
                      >
                        <option value="">-- Ignorar legenda --</option>
                        {scan.mediaFiles.map((mf) => (
                          <option key={mf.relativePath} value={mf.relativePath}>
                            {mf.filename}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="text"
                        value={sub.languageCode}
                        onChange={(e) => {
                          const val = e.target.value;
                          setSubtitlesState((prev) =>
                            prev.map((s, i) =>
                              i === idx ? { ...s, languageCode: val } : s
                            )
                          );
                        }}
                        placeholder="pt-BR"
                        className="w-24 px-2.5 py-1 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-white"
                      />
                    </td>
                    <td className="py-2 px-3 flex items-center gap-4">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={sub.isForced}
                          onChange={(e) => {
                            const val = e.target.checked;
                            setSubtitlesState((prev) =>
                              prev.map((s, i) =>
                                i === idx ? { ...s, isForced: val } : s
                              )
                            );
                          }}
                          className="rounded border-slate-700 bg-slate-950"
                        />
                        <span>.forced</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={sub.isSdh}
                          onChange={(e) => {
                            const val = e.target.checked;
                            setSubtitlesState((prev) =>
                              prev.map((s, i) =>
                                i === idx ? { ...s, isSdh: val } : s
                              )
                            );
                          }}
                          className="rounded border-slate-700 bg-slate-950"
                        />
                        <span>.sdh</span>
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Unwanted / Non-Template Tags Section */}
      {meta.supportsInternalTags && allUnwantedEntries.length > 0 && (
        <div className="bg-rose-950/15 border border-rose-500/30 rounded-xl p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-rose-300 font-semibold text-sm">
              <Trash2 className="w-4 h-4" />
              <span>
                Tags Indesejadas / Fora do Template Detectadas ({allUnwantedEntries.length})
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => toggleAllUnwanted(true)}
                className="px-2.5 py-1 rounded bg-rose-500/20 text-rose-200 hover:bg-rose-500/30"
              >
                Marcar Todas para Limpeza
              </button>
              <button
                type="button"
                onClick={() => toggleAllUnwanted(false)}
                className="px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700"
              >
                Preservar Todas
              </button>
            </div>
          </div>
          <p className="text-xs text-slate-400">
            As tags marcadas abaixo não fazem parte do template de {meta.label} e serão removidas ao salvar (desmarque caso queira preservar alguma específica):
          </p>
          <div className="max-h-48 overflow-y-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 pt-1">
            {allUnwantedEntries.map((item, idx) => (
              <label
                key={`${item.relativePath}-${item.tagKey}-${idx}`}
                className="flex items-start gap-2.5 p-2 rounded-lg bg-slate-950/80 border border-slate-800 text-xs cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={item.remove}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setUnwantedMap((prev) => ({
                      ...prev,
                      [item.relativePath]: {
                        ...(prev[item.relativePath] || {}),
                        [item.tagKey]: {
                          value: item.value,
                          remove: checked,
                        },
                      },
                    }));
                  }}
                  className="mt-0.5 rounded border-slate-700 bg-slate-900 text-rose-600"
                />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-rose-300 truncate">
                    {item.tagKey}:{' '}
                    <span className="text-slate-300">{item.value}</span>
                  </div>
                  <div className="text-[10px] text-slate-500 truncate">
                    {item.filename}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Additional / Extra Files in Cluster Folder */}
      {scan.extraFiles.length > 0 && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white">
              Arquivos Adicionais na Pasta ({scan.extraFiles.length})
            </h3>
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={deleteIgnoredExtrasAndCleanupSource}
                onChange={(e) =>
                  setDeleteIgnoredExtrasAndCleanupSource(e.target.checked)
                }
                className="rounded border-slate-700 bg-slate-950 text-indigo-600"
              />
              <span>
                Limpar arquivos ignorados restantes e apagar pasta de origem após mover para biblioteca
              </span>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {scan.extraFiles.map((extra) => (
              <div
                key={extra.relativePath}
                className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-slate-200 truncate">
                    {extra.relativePath}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {(extra.sizeBytes / 1024).toFixed(1)} KB
                    {extra.isImage && extra.imageWidth
                      ? ` • Imagem ${extra.imageWidth}×${extra.imageHeight}px (${extra.imageFormat?.toUpperCase()})`
                      : ''}
                  </div>
                </div>
                <select
                  value={extraActions[extra.relativePath] || extra.defaultAction}
                  onChange={(e) => {
                    const act = e.target.value as ExtraFileAction;
                    setExtraActions((prev) => ({
                      ...prev,
                      [extra.relativePath]: act,
                    }));
                    if (act === 'use_as_cover') {
                      handleSelectCover({
                        mode: 'extra_file',
                        extraFileRelativePath: extra.relativePath,
                        label: extra.filename,
                        width: extra.imageWidth,
                        height: extra.imageHeight,
                        format: extra.imageFormat,
                        sizeBytes: extra.sizeBytes,
                      });
                    }
                  }}
                  className="px-2.5 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs text-slate-200"
                >
                  <option value="move">Mover junto</option>
                  {extra.isImage && meta.supportsCover && (
                    <option value="use_as_cover">
                      Usar como Capa (folder.jpg/png)
                    </option>
                  )}
                  <option value="ignore">Ignorar</option>
                  <option value="delete">Excluir</option>
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action Footer */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          {processError && (
            <div className="flex items-center gap-2 text-xs text-rose-400">
              <AlertTriangle className="w-4 h-4" />
              <span>{processError}</span>
            </div>
          )}
          {processSuccessMsg && (
            <div className="flex items-center gap-2 text-xs text-emerald-400">
              <CheckCircle2 className="w-4 h-4" />
              <span>{processSuccessMsg}</span>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={handleExecuteProcess}
          disabled={processing || scan.mediaFiles.length === 0}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-sm shadow-lg shadow-emerald-600/25 transition"
        >
          {processing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Play className="w-4 h-4" />
          )}
          {processing
            ? 'Processando e Movendo...'
            : scan.sourceRoot === 'downloads'
            ? `Aplicar Tags e Mover para Biblioteca de ${meta.label}`
            : `Salvar Alterações e Reorganizar na Biblioteca de ${meta.label}`}
        </button>
      </div>
    </div>
  );
};
