import React, { useEffect, useMemo, useState } from 'react';
import {
  Sparkles,
  Save,
  Plus,
  X,
  CheckCircle2,
  FolderSearch,
  RefreshCw,
  Tag,
} from 'lucide-react';
import {
  DiscoveredTagSuggestion,
  MediaTemplate,
  MediaType,
  MediaTypeMetadata,
  TagFieldDefinition,
  TemplateSuggestion,
} from '../../shared/types';
import { ALL_MEDIA_TYPES, MEDIA_TYPES_CONFIG } from '../../shared/constants';

interface TemplateManagerProps {
  templates: Record<MediaType, MediaTemplate>;
  onTemplateUpdated: (updated: MediaTemplate) => void;
}

function extractTokensFromTemplateStr(tpl: string): string[] {
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

export const TemplateManager: React.FC<TemplateManagerProps> = ({
  templates,
  onTemplateUpdated,
}) => {
  const [selectedType, setSelectedType] = useState<MediaType>('music');
  const currentTpl = templates[selectedType];
  const meta: MediaTypeMetadata = MEDIA_TYPES_CONFIG[selectedType];

  const [pathTemplate, setPathTemplate] = useState('');
  const [filenameTemplate, setFilenameTemplate] = useState('');
  const [requiredTags, setRequiredTags] = useState<string[]>([]);
  const [customTagInput, setCustomTagInput] = useState('');
  const [whitelistedExtra, setWhitelistedExtra] = useState<string[]>([]);
  const [newWhitelistTag, setNewWhitelistTag] = useState('');
  const [stripByDefault, setStripByDefault] = useState(true);

  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [sampleSize, setSampleSize] = useState<number>(40);
  const [suggestions, setSuggestions] = useState<TemplateSuggestion[] | null>(
    null
  );
  const [discoveredTags, setDiscoveredTags] = useState<
    DiscoveredTagSuggestion[]
  >([]);

  useEffect(() => {
    if (currentTpl) {
      setPathTemplate(currentTpl.pathTemplate);
      setFilenameTemplate(currentTpl.filenameTemplate);
      setRequiredTags(currentTpl.requiredTags || []);
      setWhitelistedExtra(currentTpl.whitelistedExtraTags || []);
      setStripByDefault(currentTpl.stripContainerTagsByDefault);
      setSampleSize(40);
      setSuggestions(null);
      setDiscoveredTags([]);
    }
  }, [selectedType, currentTpl]);

  // Tokens currently referenced inside pathTemplate or filenameTemplate
  const tokensUsedInPathOrFilename = useMemo(() => {
    return new Set([
      ...extractTokensFromTemplateStr(pathTemplate),
      ...extractTokensFromTemplateStr(filenameTemplate),
    ]);
  }, [pathTemplate, filenameTemplate]);

  // Combined list of known available tags + any custom or discovered tags currently in requiredTags
  const allDisplayTagDefinitions = useMemo<TagFieldDefinition[]>(() => {
    const standardMap = new Map<string, TagFieldDefinition>();
    for (const t of meta.availableTags) {
      standardMap.set(t.key, t);
    }
    const list = [...meta.availableTags];
    for (const rk of requiredTags) {
      if (!standardMap.has(rk)) {
        list.push({
          key: rk,
          label: rk,
          isClusterLevel: false,
        });
      }
    }
    return list;
  }, [meta.availableTags, requiredTags]);

  const toggleRequiredTag = (tagKey: string) => {
    setRequiredTags((prev) =>
      prev.includes(tagKey)
        ? prev.filter((k) => k !== tagKey)
        : [...prev, tagKey]
    );
  };

  const handleAddCustomRequiredTag = () => {
    const clean = customTagInput
      .trim()
      .replace(/^\{|\}$/g, '')
      .replace(/[^a-zA-Z0-9_:-]/g, '_');
    if (!clean) return;
    if (!requiredTags.includes(clean)) {
      setRequiredTags((prev) => [...prev, clean]);
    }
    setCustomTagInput('');
  };

  const handleSave = async () => {
    setSaving(true);
    setSavedNotice(false);
    try {
      const mergedTags = Array.from(
        new Set([...requiredTags, ...tokensUsedInPathOrFilename])
      );
      const resp = await fetch(`/api/templates/${selectedType}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pathTemplate,
          filenameTemplate,
          requiredTags: mergedTags,
          whitelistedExtraTags: whitelistedExtra,
          stripContainerTagsByDefault: stripByDefault,
        }),
      });
      if (resp.ok) {
        const updated = (await resp.json()) as MediaTemplate;
        onTemplateUpdated(updated);
        setSavedNotice(true);
        setTimeout(() => setSavedNotice(false), 3000);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDiscoverFromLibrary = async (overrideSampleSize?: number) => {
    const activeMax = overrideSampleSize ?? sampleSize;
    if (overrideSampleSize !== undefined) {
      setSampleSize(overrideSampleSize);
    }
    setLoadingSuggestions(true);
    try {
      const resp = await fetch(
        `/api/templates/${selectedType}/suggestions?maxSamples=${activeMax}`
      );
      if (resp.ok) {
        const data = await resp.json();
        setSuggestions(data.suggestions || []);
        setDiscoveredTags(data.discoveredTags || []);
      }
    } finally {
      setLoadingSuggestions(false);
    }
  };

  const handleIncreaseSample = () => {
    const nextSize = Math.min(500, sampleSize + 40);
    handleDiscoverFromLibrary(nextSize);
  };

  const handleApplyAllDiscoveredTags = () => {
    if (discoveredTags.length === 0) return;
    const discoveredKeys = discoveredTags.map((d) => d.key);
    setRequiredTags(
      Array.from(
        new Set([...discoveredKeys, ...tokensUsedInPathOrFilename])
      )
    );
  };

  const addWhitelist = () => {
    const clean = newWhitelistTag.trim();
    if (clean && !whitelistedExtra.includes(clean)) {
      setWhitelistedExtra([...whitelistedExtra, clean]);
      setNewWhitelistTag('');
    }
  };

  const insertToken = (
    target: 'path' | 'file',
    tokenKey: string,
    isNumeric?: boolean
  ) => {
    if (!requiredTags.includes(tokenKey)) {
      setRequiredTags((prev) => [...prev, tokenKey]);
    }
    const tokenStr =
      isNumeric && tokenKey !== 'year' ? `{${tokenKey}:02}` : `{${tokenKey}}`;
    if (target === 'path') {
      setPathTemplate(
        (prev) => `${prev}${prev.endsWith('/') || !prev ? '' : '/'}${tokenStr}`
      );
    } else {
      setFilenameTemplate((prev) => {
        if (prev.endsWith('.{ext}')) {
          return `${prev.slice(0, -6)} - ${tokenStr}.{ext}`;
        }
        return `${prev}${tokenStr}`;
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Media type selector tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-4">
        {ALL_MEDIA_TYPES.map((mt) => (
          <button
            key={mt}
            onClick={() => setSelectedType(mt)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              selectedType === mt
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                : 'bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            {MEDIA_TYPES_CONFIG[mt].label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Template Editor Card */}
        <div className="lg:col-span-2 bg-slate-900/90 border border-slate-800 rounded-xl p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-white">
                Template Único — {meta.label}
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Ponto de montagem:{' '}
                <code className="text-indigo-400">{meta.defaultMountPath}</code>{' '}
                ({meta.mountEnv})
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs">
                <label
                  htmlFor="sample-size-select"
                  className="text-slate-400 font-medium"
                >
                  Amostra:
                </label>
                <select
                  id="sample-size-select"
                  value={sampleSize}
                  onChange={(e) => setSampleSize(Number(e.target.value))}
                  className="bg-transparent text-amber-300 font-mono font-semibold focus:outline-none"
                >
                  {[40, 80, 120, 200, 350, 500].map((sz) => (
                    <option key={sz} value={sz} className="bg-slate-900">
                      {sz} arqs
                    </option>
                  ))}
                  {![40, 80, 120, 200, 350, 500].includes(sampleSize) && (
                    <option value={sampleSize} className="bg-slate-900">
                      {sampleSize} arqs
                    </option>
                  )}
                </select>
              </div>
              <button
                type="button"
                onClick={() => handleDiscoverFromLibrary()}
                disabled={loadingSuggestions}
                className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 hover:bg-amber-500/20 text-xs font-medium transition"
              >
                {loadingSuggestions ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                Detectar Sugestões da Biblioteca Existente (Por Amostragem)
              </button>
              <button
                type="button"
                onClick={handleIncreaseSample}
                disabled={loadingSuggestions || sampleSize >= 500}
                title="Ampliar a zona de busca (+40 arquivos aleatórios) e re-executar amostragem"
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/20 disabled:opacity-40 text-xs font-medium transition"
              >
                <Plus className="w-3.5 h-3.5" />
                Aumentar Amostra (+40)
              </button>
            </div>
          </div>

          {/* Path Template */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-300">
              Formato do Caminho (Pastas dentro de{' '}
              <code>{meta.defaultMountPath}</code>)
            </label>
            <input
              type="text"
              value={pathTemplate}
              onChange={(e) => setPathTemplate(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 font-mono text-sm focus:border-indigo-500 focus:outline-none"
              placeholder={meta.defaultPathTemplate}
            />
            <p className="text-xs text-slate-400">
              Use <code>[bloco opcional]</code> para segmentos que só devem
              existir se a tag estiver preenchida (ex:{' '}
              <code>[/Vol. {'{volume:02}'}]</code>).
            </p>
          </div>

          {/* Filename Template */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-300">
              Formato do Nome do Arquivo
            </label>
            <input
              type="text"
              value={filenameTemplate}
              onChange={(e) => setFilenameTemplate(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 font-mono text-sm focus:border-indigo-500 focus:outline-none"
              placeholder={meta.defaultFilenameTemplate}
            />
            <p className="text-xs text-slate-400">
              Use <code>:02</code> ou <code>:03</code> para zero-padding
              numérico (ex: <code>{'{track:02}'}</code> → <code>01</code>,{' '}
              <code>{'{number:03}'}</code> → <code>001</code>).
            </p>
          </div>

          {/* Template Tags Selection & Manual Add/Remove */}
          <div className="space-y-3 pt-3 border-t border-slate-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <Tag className="w-3.5 h-3.5 text-indigo-400" />
                  Tags do Template ({requiredTags.length} selecionadas)
                </span>
                <p className="text-xs text-slate-400 mt-0.5">
                  Marque ou adicione as tags que fazem parte do template de{' '}
                  {meta.label}. Tags presentes nos arquivos que não estiverem
                  selecionadas aqui serão tratadas como{' '}
                  <strong className="text-rose-300">tags indesejadas</strong> no
                  editor para limpeza.
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() =>
                    setRequiredTags(meta.availableTags.map((t) => t.key))
                  }
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  Selecionar Padrões
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setRequiredTags(Array.from(tokensUsedInPathOrFilename))
                  }
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                  title="Manter apenas as tags usadas no caminho e nome do arquivo acima"
                >
                  Apenas Usadas no Caminho/Nome
                </button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {allDisplayTagDefinitions.map((tag) => {
                const isSelected =
                  requiredTags.includes(tag.key) ||
                  tokensUsedInPathOrFilename.has(tag.key);
                const isUsedInTpl = tokensUsedInPathOrFilename.has(tag.key);

                return (
                  <div
                    key={tag.key}
                    className={`flex items-center rounded-lg overflow-hidden text-xs border transition ${
                      isSelected
                        ? 'bg-indigo-950/40 border-indigo-500/60'
                        : 'bg-slate-950/60 border-slate-800 opacity-60 hover:opacity-100'
                    }`}
                  >
                    <label
                      className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer select-none"
                      title={
                        isUsedInTpl
                          ? 'Esta tag está sendo usada no formato de caminho/nome acima'
                          : 'Clique para incluir ou remover esta tag do template'
                      }
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRequiredTag(tag.key)}
                        className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="font-mono text-indigo-300">
                        {`{${tag.key}${
                          tag.isNumeric && tag.key !== 'year' ? ':02' : ''
                        }}`}
                      </span>
                      {tag.label !== tag.key && (
                        <span className="text-slate-300">{tag.label}</span>
                      )}
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        insertToken('path', tag.key, tag.isNumeric)
                      }
                      title="Inserir no Caminho"
                      className="px-2 py-1.5 bg-slate-900/90 hover:bg-indigo-600/30 text-slate-300 border-l border-slate-800 transition"
                    >
                      +Pasta
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        insertToken('file', tag.key, tag.isNumeric)
                      }
                      title="Inserir no Nome do Arquivo"
                      className="px-2 py-1.5 bg-slate-900/90 hover:bg-indigo-600/30 text-slate-300 border-l border-slate-800 transition"
                    >
                      +Arq
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Manual Custom Tag Input */}
            <div className="flex gap-2 pt-1">
              <input
                type="text"
                value={customTagInput}
                onChange={(e) => setCustomTagInput(e.target.value)}
                onKeyDown={(e) =>
                  e.key === 'Enter' && handleAddCustomRequiredTag()
                }
                placeholder="Adicionar tag personalizada ao template (ex: count, translator, Penciller)..."
                className="flex-1 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-100 font-mono"
              />
              <button
                type="button"
                onClick={handleAddCustomRequiredTag}
                className="px-3 py-1.5 rounded-lg bg-indigo-600/20 border border-indigo-500/40 hover:bg-indigo-600/30 text-indigo-200 text-xs font-medium flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Adicionar Tag ao Template
              </button>
            </div>
          </div>

          {/* Tag Cleaning & Whitelist settings */}
          {meta.supportsInternalTags ? (
            <div className="space-y-3 pt-4 border-t border-slate-800">
              <label className="block text-sm font-medium text-slate-300">
                Whitelist Global de Tags Extras (Preservar sem marcar como
                indesejada)
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newWhitelistTag}
                  onChange={(e) => setNewWhitelistTag(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addWhitelist()}
                  placeholder="Ex: replaygain_track_gain, replaygain_album_gain"
                  className="flex-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-100"
                />
                <button
                  type="button"
                  onClick={addWhitelist}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm flex items-center gap-1"
                >
                  <Plus className="w-4 h-4" /> Adicionar
                </button>
              </div>
              {whitelistedExtra.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {whitelistedExtra.map((w) => (
                    <span
                      key={w}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 text-xs font-mono text-slate-200"
                    >
                      {w}
                      <button
                        type="button"
                        onClick={() =>
                          setWhitelistedExtra(
                            whitelistedExtra.filter((item) => item !== w)
                          )
                        }
                        className="text-slate-400 hover:text-rose-400"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="pt-4 border-t border-slate-800">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={stripByDefault}
                  onChange={(e) => setStripByDefault(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-sm text-slate-200">
                  Ativar toggle{' '}
                  <strong>
                    "Limpar tags internas do container (via ffmpeg/mkvpropedit)"
                  </strong>{' '}
                  por padrão ao abrir {meta.label}
                </span>
              </label>
            </div>
          )}

          {/* Save Button */}
          <div className="flex items-center justify-between pt-4 border-t border-slate-800">
            <div>
              {savedNotice && (
                <span className="inline-flex items-center gap-1.5 text-sm text-emerald-400">
                  <CheckCircle2 className="w-4 h-4" /> Template salvo com
                  sucesso!
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm shadow-lg shadow-indigo-600/25 transition"
            >
              <Save className="w-4 h-4" />
              {saving ? 'Salvando...' : 'Salvar Template'}
            </button>
          </div>
        </div>

        {/* Heuristic Suggestions & Discovered Tags Side Panel */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-amber-400 font-semibold text-sm">
              <FolderSearch className="w-5 h-5" />
              <span>Sugestões por Amostragem da Biblioteca</span>
            </div>
            {suggestions && (
              <button
                type="button"
                onClick={handleIncreaseSample}
                disabled={loadingSuggestions || sampleSize >= 500}
                className="px-2.5 py-1 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-300 hover:bg-amber-500/20 disabled:opacity-40 text-[11px] font-medium flex items-center gap-1 transition"
              >
                <Plus className="w-3 h-3" />
                Ampliar Amostra ({sampleSize} → {Math.min(500, sampleSize + 40)})
              </button>
            )}
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            O Taggermon analisa até <strong>{sampleSize}</strong> arquivos
            aleatórios em{' '}
            <code className="text-slate-300">{meta.defaultMountPath}</code>, lê
            as tags internas e cruza heuristicamente com a estrutura de pastas e
            nomes de arquivos existentes para sugerir o template e as tags
            encontradas.
          </p>

          {/* Discovered Tags from Sampled Library Files */}
          {discoveredTags.length > 0 && (
            <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-indigo-300">
                  Tags Encontradas na Amostragem ({discoveredTags.length})
                </span>
                <button
                  type="button"
                  onClick={handleApplyAllDiscoveredTags}
                  className="px-2 py-1 rounded bg-indigo-600/20 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-600/30 text-[11px] font-medium"
                >
                  Usar Tags Encontradas
                </button>
              </div>
              <p className="text-[11px] text-slate-400">
                Clique em uma tag abaixo para ativá-la ou desativá-la no seu
                template:
              </p>
              <div className="flex flex-wrap gap-1.5">
                {discoveredTags.map((dt) => {
                  const isActive =
                    requiredTags.includes(dt.key) ||
                    tokensUsedInPathOrFilename.has(dt.key);
                  return (
                    <button
                      key={dt.key}
                      type="button"
                      onClick={() => toggleRequiredTag(dt.key)}
                      title={
                        dt.sampleValues.length > 0
                          ? `Exemplos: ${dt.sampleValues.join(' | ')}`
                          : undefined
                      }
                      className={`px-2 py-1 rounded text-[11px] font-mono border transition flex items-center gap-1 ${
                        isActive
                          ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200'
                          : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <span>{dt.key}</span>
                      <span className="text-[10px] opacity-75">
                        ({Math.round(dt.frequency * 100)}%)
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {!suggestions ? (
            <div className="p-6 rounded-lg bg-slate-950/60 border border-dashed border-slate-800 text-center text-xs text-slate-500">
              Clique em{' '}
              <strong>
                "Detectar Sugestões da Biblioteca Existente"
              </strong>{' '}
              para analisar sua biblioteca atual.
            </div>
          ) : suggestions.length === 0 ? (
            <div className="p-4 rounded-lg bg-slate-950 text-xs text-slate-400">
              Nenhum arquivo encontrado na biblioteca no momento.
            </div>
          ) : (
            <div className="space-y-3">
              {suggestions.map((sug, idx) => (
                <div
                  key={idx}
                  className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 space-y-2.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-amber-300">
                      Candidato #{idx + 1}{' '}
                      {sug.totalSampled > 0
                        ? `(${sug.matchCount}/${
                            sug.totalSampled
                          } arquivos — ${Math.round(sug.confidence * 100)}%)`
                        : '(Template Padrão)'}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setPathTemplate(sug.pathTemplate);
                        setFilenameTemplate(sug.filenameTemplate);
                        if (
                          sug.suggestedTags &&
                          sug.suggestedTags.length > 0
                        ) {
                          setRequiredTags(
                            Array.from(
                              new Set([
                                ...sug.suggestedTags,
                                ...extractTokensFromTemplateStr(
                                  sug.pathTemplate
                                ),
                                ...extractTokensFromTemplateStr(
                                  sug.filenameTemplate
                                ),
                              ])
                            )
                          );
                        }
                      }}
                      className="px-2.5 py-1 rounded bg-indigo-600/20 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-600/30 text-xs font-medium"
                    >
                      Usar este
                    </button>
                  </div>
                  <div className="text-xs font-mono space-y-1">
                    <div className="text-slate-400">
                      Pasta:{' '}
                      <span className="text-slate-200">{sug.pathTemplate}</span>
                    </div>
                    <div className="text-slate-400">
                      Arquivo:{' '}
                      <span className="text-slate-200">
                        {sug.filenameTemplate}
                      </span>
                    </div>
                  </div>
                  {sug.suggestedTags && sug.suggestedTags.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {sug.suggestedTags.map((st) => (
                        <span
                          key={st}
                          className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-[10px] font-mono text-indigo-300"
                        >
                          {`{${st}}`}
                        </span>
                      ))}
                    </div>
                  )}
                  {sug.samplePreviews.length > 0 && (
                    <div className="pt-2 border-t border-slate-900 text-[11px] text-slate-400 space-y-1">
                      <div className="font-medium text-slate-500">
                        Exemplo detectado na biblioteca:
                      </div>
                      <div className="font-mono text-slate-300 break-words leading-relaxed">
                        {sug.samplePreviews[0].originalPath}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
