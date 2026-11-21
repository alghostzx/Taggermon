import React, { useEffect, useState } from 'react';
import {
  Folder,
  FolderOpen,
  Download,
  Library,
  Settings,
  RefreshCw,
  ChevronRight,
  Tags,
  Music,
  Headphones,
  BookOpen,
  Layers,
  Film,
  Tv,
  Search,
} from 'lucide-react';
import {
  ClusterScanResult,
  MediaTemplate,
  MediaType,
} from '../shared/types';
import { ALL_MEDIA_TYPES, MEDIA_TYPES_CONFIG } from '../shared/constants';
import { TemplateManager } from './components/TemplateManager';
import { ClusterEditor } from './components/ClusterEditor';

interface FolderItem {
  name: string;
  relativePath: string;
  hasSubfolders: boolean;
  fileCount: number;
  suggestedMediaType?: MediaType;
}

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<
    'downloads' | 'libraries' | 'templates'
  >('downloads');

  const [selectedLibrarySource, setSelectedLibrarySource] =
    useState<MediaType>('music');
  const [currentParentPath, setCurrentParentPath] = useState('');
  const [folderSearch, setFolderSearch] = useState('');
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);

  const [templates, setTemplates] = useState<
    Record<MediaType, MediaTemplate>
  >({} as Record<MediaType, MediaTemplate>);
  const [mounts, setMounts] = useState<Record<string, string>>({});

  const [activeScan, setActiveScan] = useState<ClusterScanResult | null>(null);
  const [loadingCluster, setLoadingCluster] = useState(false);
  const [wideSidebar, setWideSidebar] = useState(false);

  const currentSourceRoot: 'downloads' | MediaType =
    activeTab === 'libraries' ? selectedLibrarySource : 'downloads';

  useEffect(() => {
    fetchConfig();
  }, []);

  useEffect(() => {
    if (activeTab === 'downloads' || activeTab === 'libraries') {
      fetchFolders(currentSourceRoot, currentParentPath);
    }
  }, [activeTab, selectedLibrarySource, currentParentPath]);

  const fetchConfig = async () => {
    const resp = await fetch('/api/config');
    if (resp.ok) {
      const data = await resp.json();
      setTemplates(data.templates);
      setMounts(data.mounts || {});
    }
  };

  const fetchFolders = async (
    source: 'downloads' | MediaType,
    parentPath = ''
  ) => {
    setLoadingFolders(true);
    try {
      const resp = await fetch(
        `/api/folders?source=${encodeURIComponent(
          source
        )}&parentPath=${encodeURIComponent(parentPath)}`
      );
      if (resp.ok) {
        const data = await resp.json();
        setFolders(data.folders || []);
      }
    } finally {
      setLoadingFolders(false);
    }
  };

  const handleOpenCluster = async (
    relativePath: string,
    overrideType?: MediaType
  ) => {
    setLoadingCluster(true);
    try {
      const typeParam = overrideType
        ? `&mediaType=${encodeURIComponent(overrideType)}`
        : '';
      const resp = await fetch(
        `/api/cluster?source=${encodeURIComponent(
          currentSourceRoot
        )}&path=${encodeURIComponent(relativePath)}${typeParam}`
      );
      if (resp.ok) {
        const data = (await resp.json()) as ClusterScanResult;
        setActiveScan(data);
      }
    } finally {
      setLoadingCluster(false);
    }
  };

  const getMediaIcon = (type?: MediaType) => {
    switch (type) {
      case 'music':
        return <Music className="w-3.5 h-3.5 text-indigo-400" />;
      case 'audiobooks':
        return <Headphones className="w-3.5 h-3.5 text-amber-400" />;
      case 'books':
        return <BookOpen className="w-3.5 h-3.5 text-emerald-400" />;
      case 'comics':
      case 'manga':
        return <Layers className="w-3.5 h-3.5 text-pink-400" />;
      case 'movies':
        return <Film className="w-3.5 h-3.5 text-cyan-400" />;
      case 'series':
        return <Tv className="w-3.5 h-3.5 text-purple-400" />;
      default:
        return <Folder className="w-3.5 h-3.5 text-slate-400" />;
    }
  };

  const filteredFolders = folders.filter((f) =>
    f.name.toLowerCase().includes(folderSearch.toLowerCase())
  );

  const breadcrumbs = currentParentPath
    ? currentParentPath.split('/').filter(Boolean)
    : [];

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-20">
        <div className="w-full max-w-[1920px] mx-auto px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Tags className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight text-white">
                Taggermon
              </h1>
              <p className="text-[11px] text-slate-400">
                All-Purpose Media Tag Editor & Library Organizer
              </p>
            </div>
          </div>

          <nav className="flex items-center gap-2">
            <button
              onClick={() => {
                setActiveTab('downloads');
                setCurrentParentPath('');
                setActiveScan(null);
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition ${
                activeTab === 'downloads'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Download className="w-4 h-4" />
              Pasta de Downloads
            </button>

            <button
              onClick={() => {
                setActiveTab('libraries');
                setCurrentParentPath('');
                setActiveScan(null);
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition ${
                activeTab === 'libraries'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Library className="w-4 h-4" />
              Editar Bibliotecas (7 Pontos)
            </button>

            <button
              onClick={() => setActiveTab('templates')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition ${
                activeTab === 'templates'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Settings className="w-4 h-4" />
              Templates & Amostragem
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 w-full max-w-[1920px] mx-auto px-6 py-6">
        {activeTab === 'templates' ? (
          Object.keys(templates).length > 0 && (
            <TemplateManager
              templates={templates}
              onTemplateUpdated={(updated) =>
                setTemplates((prev) => ({
                  ...prev,
                  [updated.mediaType]: updated,
                }))
              }
            />
          )
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left Sidebar: Folder / Cluster Navigator */}
            <aside
              className={`${
                wideSidebar ? 'lg:col-span-5' : 'lg:col-span-3'
              } space-y-4 transition-all`}
            >
              {activeTab === 'libraries' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-3 space-y-2">
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Selecionar Biblioteca
                  </label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {ALL_MEDIA_TYPES.map((mt) => (
                      <button
                        key={mt}
                        onClick={() => {
                          setSelectedLibrarySource(mt);
                          setCurrentParentPath('');
                          setActiveScan(null);
                        }}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition ${
                          selectedLibrarySource === mt
                            ? 'bg-indigo-600 text-white'
                            : 'bg-slate-950 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                        }`}
                      >
                        {getMediaIcon(mt)}
                        <span className="break-words text-left">
                          {MEDIA_TYPES_CONFIG[mt].label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-[160px] flex-1">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                      {activeTab === 'downloads'
                        ? 'Clusters em Downloads'
                        : `Biblioteca: ${MEDIA_TYPES_CONFIG[selectedLibrarySource].label}`}
                    </h2>
                    <p className="text-[11px] font-mono text-slate-500 break-words">
                      {mounts[currentSourceRoot] || `/${currentSourceRoot}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => setWideSidebar(!wideSidebar)}
                      className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-300"
                      title="Alternar largura da barra lateral de pastas"
                    >
                      {wideSidebar ? '⇤ Reduzir' : '⇔ Expandir'}
                    </button>
                    <button
                      onClick={() =>
                        fetchFolders(currentSourceRoot, currentParentPath)
                      }
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                      title="Atualizar pastas"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${
                          loadingFolders ? 'animate-spin' : ''
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Search filter */}
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={folderSearch}
                    onChange={(e) => setFolderSearch(e.target.value)}
                    placeholder="Filtrar pasta..."
                    className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                {/* Breadcrumbs for subfolder navigation */}
                <div className="flex flex-wrap items-center gap-1 text-xs text-slate-400 bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-800/80">
                  <button
                    onClick={() => setCurrentParentPath('')}
                    className="hover:text-indigo-400 font-mono"
                  >
                    raiz
                  </button>
                  {breadcrumbs.map((seg, i) => {
                    const subPath = breadcrumbs.slice(0, i + 1).join('/');
                    return (
                      <React.Fragment key={subPath}>
                        <ChevronRight className="w-3 h-3 text-slate-600 shrink-0" />
                        <button
                          onClick={() => setCurrentParentPath(subPath)}
                          className="hover:text-indigo-400 font-mono break-words text-left"
                        >
                          {seg}
                        </button>
                      </React.Fragment>
                    );
                  })}
                </div>

                {/* Folder List */}
                <div className="space-y-1.5 max-h-[65vh] overflow-y-auto pr-1">
                  {filteredFolders.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-lg">
                      Nenhuma pasta encontrada neste nível.
                    </div>
                  ) : (
                    filteredFolders.map((folder) => {
                      const isSelected =
                        activeScan?.clusterRelativePath === folder.relativePath;
                      return (
                        <div
                          key={folder.relativePath}
                          className={`p-2.5 rounded-lg border transition flex items-start justify-between gap-2 ${
                            isSelected
                              ? 'bg-indigo-950/40 border-indigo-500 text-white'
                              : 'bg-slate-950/70 border-slate-800/80 hover:border-slate-700 text-slate-300'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              handleOpenCluster(folder.relativePath)
                            }
                            className="flex items-start gap-2.5 min-w-0 flex-1 text-left"
                          >
                            {isSelected ? (
                              <FolderOpen className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                            ) : (
                              <Folder className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-medium break-words leading-snug">
                                {folder.name}
                              </div>
                              <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400 mt-1">
                                <span>{folder.fileCount} arq(s)</span>
                                {folder.suggestedMediaType && (
                                  <span className="inline-flex items-center gap-1 text-indigo-300">
                                    • {getMediaIcon(folder.suggestedMediaType)}
                                    {
                                      MEDIA_TYPES_CONFIG[
                                        folder.suggestedMediaType
                                      ].label
                                    }
                                  </span>
                                )}
                              </div>
                            </div>
                          </button>

                          {folder.hasSubfolders && (
                            <button
                              type="button"
                              onClick={() =>
                                setCurrentParentPath(folder.relativePath)
                              }
                              title="Entrar nas subpastas"
                              className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-[11px] text-slate-400 hover:text-white shrink-0"
                            >
                              Subpastas →
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </aside>

            {/* Right Workspace: Cluster Tag & Path Editor */}
            <section
              className={`${
                wideSidebar ? 'lg:col-span-7' : 'lg:col-span-9'
              } transition-all`}
            >
              {loadingCluster ? (
                <div className="h-96 bg-slate-900/50 border border-slate-800 rounded-xl flex items-center justify-center text-sm text-slate-400">
                  Lendo arquivos, tags internas e metadados do cluster...
                </div>
              ) : activeScan && Object.keys(templates).length > 0 ? (
                <ClusterEditor
                  scan={activeScan}
                  templates={templates}
                  onChangeMediaType={(newType) =>
                    handleOpenCluster(activeScan.clusterRelativePath, newType)
                  }
                  onProcessComplete={() => {
                    setActiveScan(null);
                    fetchFolders(currentSourceRoot, currentParentPath);
                  }}
                />
              ) : (
                <div className="h-96 bg-slate-900/40 border border-dashed border-slate-800 rounded-xl flex flex-col items-center justify-center p-8 text-center">
                  <FolderOpen className="w-10 h-10 text-slate-600 mb-3" />
                  <h3 className="text-sm font-semibold text-slate-300">
                    Selecione uma pasta à esquerda para editar tags e organizar
                  </h3>
                  <p className="text-xs text-slate-500 max-w-md mt-1">
                    Cada pasta ou subpasta selecionada é tratada como um cluster de mídia única. Você poderá revisar e limpar tags indesejadas, buscar capas no COV (sem downscale + <code>folder.jpg/png</code>), converter <code>.cbr/.epub</code> em <code>.cbz</code> e mover para o ponto de montagem da biblioteca.
                  </p>
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
