import React, { useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  Image as ImageIcon,
  Upload,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { ExtraFileItem, MediaType } from '../../shared/types';

export interface SelectedCoverState {
  mode: 'none' | 'extra_file' | 'cov_url' | 'uploaded_base64';
  extraFileRelativePath?: string;
  covImageUrl?: string;
  uploadedBase64?: string;
  previewUrl?: string;
  label?: string;
  width?: number;
  height?: number;
  format?: string;
  sizeBytes?: number;
}

interface CoverPickerModalProps {
  sourceRoot: 'downloads' | MediaType;
  clusterRelativePath: string;
  mediaType: MediaType;
  artistQuery: string;
  albumQuery: string;
  extraImages: ExtraFileItem[];
  hasEmbeddedCoverInFirstFile: boolean;
  firstFileRelativePath?: string;
  selectedCover: SelectedCoverState;
  onSelectCover: (cover: SelectedCoverState) => void;
}

export const CoverSection: React.FC<CoverPickerModalProps> = ({
  sourceRoot,
  clusterRelativePath,
  mediaType,
  artistQuery,
  albumQuery,
  extraImages,
  hasEmbeddedCoverInFirstFile,
  firstFileRelativePath,
  selectedCover,
  onSelectCover,
}) => {
  const [covStatus, setCovStatus] = useState<string | null>(null);
  const [covLoading, setCovLoading] = useState(false);
  const [covError, setCovError] = useState<string | null>(null);
  const [manualCovUrl, setManualCovUrl] = useState('');
  const covPopupRef = useRef<Window | null>(null);
  const onSelectCoverRef = useRef(onSelectCover);
  onSelectCoverRef.current = onSelectCover;

  // Listen for COV Remote Protocol (`remote.port=browser`) window.postMessage events
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      if (!event.origin.includes('musichoarders.xyz')) {
        return;
      }

      let data: unknown = event.data;
      if (!data) return;

      // covers.musichoarders.xyz sends `JSON.stringify({ type: "pick", action: "primary", bigCoverUrl, smallCoverUrl, ... })`
      if (typeof data === 'string') {
        const trimmed = data.trim();
        if (trimmed.startsWith('{')) {
          try {
            data = JSON.parse(trimmed);
          } catch {
            return;
          }
        }
      }

      // Extract cover URL from COV remote protocol message payload
      let pickedUrl = '';
      if (typeof data === 'string' && /^https?:\/\//i.test(data)) {
        pickedUrl = data;
      } else if (typeof data === 'object' && data !== null) {
        const obj = data as Record<string, any>;
        pickedUrl =
          obj.bigCoverUrl ||
          obj.smallCoverUrl ||
          obj.url ||
          obj.bigUrl ||
          obj.image ||
          obj.cover?.bigCoverUrl ||
          obj.cover?.bigUrl ||
          obj.cover?.url ||
          obj.data?.bigCoverUrl ||
          obj.data?.bigUrl ||
          obj.data?.url ||
          '';
      }

      if (pickedUrl && /^https?:\/\//i.test(pickedUrl)) {
        const ok = await inspectAndApplyCovUrl(pickedUrl);
        if (ok) {
          // Close the COV puppet tab via protocol message `{ type: "close" }`
          try {
            if (covPopupRef.current && !covPopupRef.current.closed) {
              covPopupRef.current.postMessage({ type: 'close' }, '*');
              covPopupRef.current.close();
            }
          } catch {
            // ignore
          }
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const inspectAndApplyCovUrl = async (imageUrl: string): Promise<boolean> => {
    setCovLoading(true);
    setCovError(null);
    setCovStatus('Baixando capa original sem downscale do COV...');
    try {
      const resp = await fetch('/api/cov/inspect-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || 'Falha ao obter imagem do COV');
      }
      const info = await resp.json();
      onSelectCoverRef.current({
        mode: 'cov_url',
        covImageUrl: imageUrl,
        previewUrl: info.dataUrl,
        label: `Capa COV (${info.width}x${info.height} ${info.format?.toUpperCase()})`,
        width: info.width,
        height: info.height,
        format: info.format,
        sizeBytes: info.sizeBytes,
      });
      setCovStatus(
        `Capa COV carregada em resolução original (${info.width}×${info.height}px, ${(
          info.sizeBytes / 1024
        ).toFixed(1)} KB)`
      );
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setCovError(errMsg);
      setCovStatus(null);
      try {
        if (covPopupRef.current && !covPopupRef.current.closed) {
          covPopupRef.current.postMessage({ type: 'error', text: errMsg }, '*');
        }
      } catch {
        // ignore
      }
      return false;
    } finally {
      setCovLoading(false);
    }
  };

  const handleOpenCOV = () => {
    setCovError(null);
    const params = new URLSearchParams();
    params.set('theme', 'dark');
    params.set('remote.port', 'browser');
    params.set('remote.agent', 'Taggermon/1.0');
    params.set(
      'remote.text',
      'Taggermon conectado! Clique na capa desejada para enviá-la em resolução original.'
    );
    if (artistQuery.trim()) params.set('artist', artistQuery.trim());
    if (albumQuery.trim()) params.set('album', albumQuery.trim());

    const covUrl = `https://covers.musichoarders.xyz/?${params.toString()}`;
    const popup = window.open(covUrl, 'TaggermonCOV', 'width=1280,height=860');
    covPopupRef.current = popup;
    setCovStatus(
      'Janela do COV aberta! Escolha a capa lá (ou cole a URL / arraste a imagem abaixo).'
    );
  };

  const handleLocalFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => {
        onSelectCover({
          mode: 'uploaded_base64',
          uploadedBase64: dataUrl,
          previewUrl: dataUrl,
          label: `Upload: ${file.name}`,
          width: img.naturalWidth,
          height: img.naturalHeight,
          format: file.type.includes('png') ? 'png' : 'jpg',
          sizeBytes: file.size,
        });
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const formatBytes = (bytes?: number) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const embeddedPreviewUrl =
    hasEmbeddedCoverInFirstFile && firstFileRelativePath
      ? `/api/preview-image?source=${encodeURIComponent(
          sourceRoot
        )}&clusterPath=${encodeURIComponent(
          clusterRelativePath
        )}&filePath=${encodeURIComponent(firstFileRelativePath)}&embedded=true`
      : null;

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-indigo-400" />
            Gerenciamento de Capa (Sem Downscale +{' '}
            <code>folder.jpg / folder.png</code>)
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            A capa escolhida será embutida nos arquivos em resolução original e salva na pasta do álbum como{' '}
            <code>folder.jpg</code> ou <code>folder.png</code>.
          </p>
        </div>

        {(mediaType === 'music' || mediaType === 'audiobooks') && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleOpenCOV}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium shadow-md shadow-indigo-600/20 transition"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Buscar Capa no COV (Artista + Álbum preenchidos)
            </button>

            <label className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium cursor-pointer transition">
              <Upload className="w-3.5 h-3.5" />
              Enviar Arquivo
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleLocalFileUpload}
                className="hidden"
              />
            </label>
          </div>
        )}
      </div>

      {/* COV Official Decorum Attribution & URL input fallback */}
      {(mediaType === 'music' || mediaType === 'audiobooks') && (
        <div className="p-3 rounded-lg bg-slate-950/80 border border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="text-slate-400">
            Integração de busca de capas powered by{' '}
            <a
              href="https://covers.musichoarders.xyz"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-400 hover:underline font-medium"
            >
              COV - Cover Search Engine (https://covers.musichoarders.xyz)
            </a>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={manualCovUrl}
              onChange={(e) => setManualCovUrl(e.target.value)}
              placeholder="Ou cole a URL direta da imagem escolhida..."
              className="px-2.5 py-1 rounded bg-slate-900 border border-slate-700 text-slate-200 text-xs w-64"
            />
            <button
              type="button"
              disabled={!manualCovUrl.trim() || covLoading}
              onClick={() => {
                inspectAndApplyCovUrl(manualCovUrl.trim());
                setManualCovUrl('');
              }}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40"
            >
              Carregar URL
            </button>
          </div>
        </div>
      )}

      {covStatus && (
        <div className="flex items-center gap-2 text-xs text-indigo-300 bg-indigo-950/40 border border-indigo-800/40 px-3 py-2 rounded-lg">
          {covLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          )}
          <span>{covStatus}</span>
        </div>
      )}

      {covError && (
        <div className="flex items-center gap-2 text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 px-3 py-2 rounded-lg">
          <AlertCircle className="w-4 h-4" />
          <span>{covError}</span>
        </div>
      )}

      {/* Candidate Covers Grid (Current Selected + Folder Images + Embedded) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 pt-1">
        {/* Option 1: Keep existing embedded cover */}
        {embeddedPreviewUrl && (
          <div
            onClick={() =>
              onSelectCover({
                mode: 'none',
                previewUrl: embeddedPreviewUrl,
                label: 'Capa Embutida Atual',
              })
            }
            className={`cursor-pointer rounded-lg p-2.5 border transition flex items-center gap-3 ${
              selectedCover.mode === 'none'
                ? 'bg-indigo-950/30 border-indigo-500'
                : 'bg-slate-950 border-slate-800 hover:border-slate-700'
            }`}
          >
            <img
              src={embeddedPreviewUrl}
              alt="Embedded Cover"
              className="w-16 h-16 object-cover rounded bg-slate-900 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-slate-200 break-words">
                Capa Embutida no Áudio
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                Manter tag de imagem original e gerar <code>folder.jpg/png</code>
              </div>
            </div>
          </div>
        )}

        {/* Option 2: Extra image files detected in cluster folder */}
        {extraImages.map((img) => {
          const imgUrl = `/api/preview-image?source=${encodeURIComponent(
            sourceRoot
          )}&clusterPath=${encodeURIComponent(
            clusterRelativePath
          )}&filePath=${encodeURIComponent(img.relativePath)}`;
          const isSelected =
            selectedCover.mode === 'extra_file' &&
            selectedCover.extraFileRelativePath === img.relativePath;

          return (
            <div
              key={img.relativePath}
              onClick={() =>
                onSelectCover({
                  mode: 'extra_file',
                  extraFileRelativePath: img.relativePath,
                  previewUrl: imgUrl,
                  label: img.filename,
                  width: img.imageWidth,
                  height: img.imageHeight,
                  format: img.imageFormat,
                  sizeBytes: img.sizeBytes,
                })
              }
              className={`cursor-pointer rounded-lg p-2.5 border transition flex items-center gap-3 ${
                isSelected
                  ? 'bg-indigo-950/30 border-indigo-500 ring-1 ring-indigo-500/40'
                  : 'bg-slate-950 border-slate-800 hover:border-slate-700'
              }`}
            >
              <img
                src={imgUrl}
                alt={img.filename}
                className="w-16 h-16 object-cover rounded bg-slate-900 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-slate-200 break-words leading-snug">
                  {img.relativePath}
                </div>
                <div className="text-[11px] text-emerald-400 font-mono mt-0.5">
                  {img.imageWidth && img.imageHeight
                    ? `${img.imageWidth}×${img.imageHeight}px`
                    : 'Imagem'}{' '}
                  ({img.imageFormat?.toUpperCase()})
                </div>
                <div className="text-[11px] text-slate-400">
                  {formatBytes(img.sizeBytes)}
                </div>
              </div>
            </div>
          );
        })}

        {/* Option 3: Selected from COV or Local Upload */}
        {(selectedCover.mode === 'cov_url' ||
          selectedCover.mode === 'uploaded_base64') &&
          selectedCover.previewUrl && (
            <div className="rounded-lg p-2.5 border bg-indigo-950/30 border-indigo-500 ring-1 ring-indigo-500/40 flex items-center gap-3">
              <img
                src={selectedCover.previewUrl}
                alt="Selected Cover"
                className="w-16 h-16 object-cover rounded bg-slate-900 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-indigo-200 break-words leading-snug">
                  {selectedCover.label}
                </div>
                {selectedCover.width && selectedCover.height ? (
                  <div className="text-[11px] text-emerald-400 font-mono mt-0.5">
                    {selectedCover.width}×{selectedCover.height}px (
                    {selectedCover.format?.toUpperCase()})
                  </div>
                ) : null}
                <div className="text-[11px] text-slate-400">
                  {formatBytes(selectedCover.sizeBytes)} — Original sem downscale
                </div>
              </div>
            </div>
          )}
      </div>
    </div>
  );
};
