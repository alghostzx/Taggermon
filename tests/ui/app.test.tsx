// @vitest-environment jsdom
import React from 'react';
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import App from '../../src/client/App.js';
import { ALL_MEDIA_TYPES, MEDIA_TYPES_CONFIG } from '../../src/shared/constants.js';
import {
  ClusterScanResult,
  MediaTemplate,
  MediaType,
} from '../../src/shared/types.js';

function buildDefaultTemplatesMap(): Record<MediaType, MediaTemplate> {
  const map = {} as Record<MediaType, MediaTemplate>;
  for (const mt of ALL_MEDIA_TYPES) {
    const cfg = MEDIA_TYPES_CONFIG[mt];
    map[mt] = {
      mediaType: mt,
      pathTemplate: cfg.defaultPathTemplate,
      filenameTemplate: cfg.defaultFilenameTemplate,
      requiredTags: cfg.availableTags.map((t) => t.key),
      whitelistedExtraTags: [],
      stripContainerTagsByDefault: true,
      updatedAt: '2026-11-20T00:00:00.000Z',
    };
  }
  return map;
}

const mockMusicCluster: ClusterScanResult = {
  sourceRoot: 'downloads',
  clusterRelativePath: 'Pink Floyd - 1973 - Dark Side',
  clusterName: 'Pink Floyd - 1973 - Dark Side',
  detectedMediaType: 'music',
  detectionConfidence: 0.95,
  mediaFiles: [
    {
      relativePath: '01 - Speak to Me.flac',
      filename: '01 - Speak to Me.flac',
      ext: 'flac',
      sizeBytes: 12000000,
      tags: {
        album_artist: 'Pink Floyd',
        artist: 'Pink Floyd',
        album: 'The Dark Side of the Moon',
        year: '1973',
        track: '1',
        title: 'Speak to Me',
      },
      unwantedTags: {
        comment: 'Downloaded from PirateTracker',
        encoded_by: 'SpamEncoder',
      },
      hasEmbeddedCover: true,
    },
    {
      relativePath: '02 - Breathe.flac',
      filename: '02 - Breathe.flac',
      ext: 'flac',
      sizeBytes: 18000000,
      tags: {
        album_artist: 'Pink Floyd',
        artist: 'Pink Floyd',
        album: 'The Dark Side of the Moon',
        year: '1973',
        track: '2',
        title: 'Breathe',
      },
      unwantedTags: {},
      hasEmbeddedCover: true,
    },
  ],
  extraFiles: [
    {
      relativePath: 'cover.png',
      filename: 'cover.png',
      ext: 'png',
      sizeBytes: 450000,
      isImage: true,
      imageWidth: 1500,
      imageHeight: 1500,
      imageFormat: 'png',
      defaultAction: 'use_as_cover',
    },
    {
      relativePath: 'rip.log',
      filename: 'rip.log',
      ext: 'log',
      sizeBytes: 2048,
      isImage: false,
      defaultAction: 'move',
    },
  ],
  subtitles: [],
};

const mockSeriesCluster: ClusterScanResult = {
  sourceRoot: 'downloads',
  clusterRelativePath: 'Severance.S01',
  clusterName: 'Severance.S01',
  detectedMediaType: 'series',
  detectionConfidence: 0.92,
  mediaFiles: [
    {
      relativePath: 'Severance.S01E01.1080p.mkv',
      filename: 'Severance.S01E01.1080p.mkv',
      ext: 'mkv',
      sizeBytes: 50000000,
      tags: {
        series: 'Severance',
        season: '1',
        episode: '1',
        title: 'Good News About Hell',
      },
      unwantedTags: {
        title: 'RARBG.COM - Severance.S01E01',
      },
    },
  ],
  extraFiles: [],
  subtitles: [
    {
      relativePath: 'Severance.S01E01.pt-BR.forced.srt',
      filename: 'Severance.S01E01.pt-BR.forced.srt',
      ext: 'srt',
      matchedVideoRelativePath: 'Severance.S01E01.1080p.mkv',
      languageCode: 'pt-BR',
      isForced: true,
      isSdh: false,
    },
  ],
};

describe('UI: React Application, ClusterEditor, COV Remote Protocol & TemplateManager', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let lastProcessedPayload: unknown = null;

  beforeEach(() => {
    lastProcessedPayload = null;
    const templatesMap = buildDefaultTemplatesMap();

    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.startsWith('/api/config')) {
        return new Response(
          JSON.stringify({
            mediaTypes: MEDIA_TYPES_CONFIG,
            allMediaTypes: ALL_MEDIA_TYPES,
            mounts: {
              downloads: '/downloads',
              music: '/library/music',
              audiobooks: '/library/audiobooks',
              books: '/library/books',
              comics: '/library/comics',
              manga: '/library/manga',
              movies: '/library/movies',
              series: '/library/series',
            },
            templates: templatesMap,
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('/api/folders')) {
        if (url.includes('source=series')) {
          return new Response(
            JSON.stringify({
              source: 'series',
              parentPath: '',
              folders: [
                {
                  name: 'Severance',
                  relativePath: 'Severance',
                  hasSubfolders: true,
                  fileCount: 9,
                  suggestedMediaType: 'series',
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            source: 'downloads',
            parentPath: '',
            folders: [
              {
                name: 'Pink Floyd - 1973 - Dark Side',
                relativePath: 'Pink Floyd - 1973 - Dark Side',
                hasSubfolders: false,
                fileCount: 4,
                suggestedMediaType: 'music',
              },
              {
                name: 'Severance.S01',
                relativePath: 'Severance.S01',
                hasSubfolders: false,
                fileCount: 2,
                suggestedMediaType: 'series',
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('/api/cluster')) {
        if (url.includes('Severance')) {
          return new Response(JSON.stringify(mockSeriesCluster), {
            status: 200,
          });
        }
        return new Response(JSON.stringify(mockMusicCluster), { status: 200 });
      }

      if (url.startsWith('/api/preview-destinations')) {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(
          JSON.stringify({
            previews: (body.files || []).map((f: { relativePath: string }) => ({
              relativePath: f.relativePath,
              destinationDirectory: 'Pink Floyd/1973 - The Dark Side of the Moon',
              destinationFilename: f.relativePath,
              destinationFullRelativePath: `Pink Floyd/1973 - The Dark Side of the Moon/${f.relativePath}`,
            })),
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('/api/parse-pattern')) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: '01 - Speak to Me.flac',
                extracted: { track: '1', title: 'Speak to Me (Parsed)' },
              },
              {
                id: '02 - Breathe.flac',
                extracted: { track: '2', title: 'Breathe (Parsed)' },
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('/api/cov/inspect-url')) {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(
          JSON.stringify({
            imageUrl: body.imageUrl,
            sizeBytes: 980000,
            width: 3000,
            height: 3000,
            format: 'png',
            dataUrl:
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4z8DAwAAABgAB/7/1KAAAAABJRU5ErkJggg==',
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('/api/process-cluster')) {
        lastProcessedPayload = JSON.parse(String(init?.body || '{}'));
        return new Response(
          JSON.stringify({
            success: true,
            targetMediaType: 'music',
            destinationRoot: '/library/music',
            processedFiles: [
              {
                sourceRelativePath: '01 - Speak to Me.flac',
                destinationRelativePath:
                  'Pink Floyd/1973 - The Dark Side of the Moon/01 - Speak to Me.flac',
              },
            ],
            folderCoverSavedAs:
              'Pink Floyd/1973 - The Dark Side of the Moon/folder.png',
            movedExtras: ['rip.log'],
            deletedExtras: [],
            sourceFolderRemoved: true,
          }),
          { status: 200 }
        );
      }

      if (url.includes('/suggestions')) {
        return new Response(
          JSON.stringify({
            discoveredTags: [
              {
                key: 'album_artist',
                count: 40,
                totalSampled: 40,
                frequency: 1,
                sampleValues: ['Pink Floyd'],
                isStandardTag: true,
              },
              {
                key: 'custom_sampled_tag',
                count: 20,
                totalSampled: 40,
                frequency: 0.5,
                sampleValues: ['Value1'],
                isStandardTag: false,
              },
            ],
            suggestions: [
              {
                pathTemplate: '{album_artist}/[{year} - ]{album}',
                filenameTemplate: '{track:02} - {title}.{ext}',
                confidence: 0.95,
                matchCount: 38,
                totalSampled: 40,
                suggestedTags: ['album_artist', 'year', 'album', 'track', 'title'],
                samplePreviews: [
                  {
                    originalPath:
                      'Pink Floyd/1973 - The Dark Side of the Moon/01 - Speak to Me.flac',
                    extractedTags: { album_artist: 'Pink Floyd' },
                  },
                ],
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('/api/templates/') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            ...templatesMap.music,
            ...body,
          }),
          { status: 200 }
        );
      }

      return new Response(JSON.stringify({}), { status: 200 });
    });

    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists Download clusters, opens Music ClusterEditor, handles batch tag editing, filename pattern parsing, unwanted tag toggling, and COV Remote Protocol postMessage flow', async () => {
    const mockPopup = {
      closed: false,
      postMessage: vi.fn(),
      close: vi.fn(),
    };
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(mockPopup as unknown as Window);

    render(<App />);

    // Wait for Downloads folder list to render
    await waitFor(() => {
      expect(
        screen.getByText('Pink Floyd - 1973 - Dark Side')
      ).toBeInTheDocument();
    });

    // Click on the music cluster
    fireEvent.click(screen.getByText('Pink Floyd - 1973 - Dark Side'));

    // Verify ClusterEditor loaded with tags, cover image resolution, and unwanted tags
    await waitFor(() => {
      expect(screen.getByDisplayValue('Speak to Me')).toBeInTheDocument();
    });
    expect(screen.getAllByText(/1500×1500px/i).length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText(/Downloaded from PirateTracker/i)
    ).toBeInTheDocument();

    // 1. Test Official COV Integration (`remote.port=browser` + `window.open` + `postMessage` + `{type: 'close'}`)
    const covButton = screen.getByText(
      /Buscar Capa no COV \(Artista \+ Álbum preenchidos\)/i
    );
    fireEvent.click(covButton);

    expect(openSpy).toHaveBeenCalledTimes(1);
    const openedCovUrl = String(openSpy.mock.calls[0][0]);
    expect(openedCovUrl).toContain('https://covers.musichoarders.xyz/?');
    expect(openedCovUrl).toContain('remote.port=browser');
    expect(openedCovUrl).toContain('remote.agent=Taggermon');
    expect(openedCovUrl).toContain('artist=Pink+Floyd');
    expect(openedCovUrl).toContain('album=The+Dark+Side+of+the+Moon');

    // Simulate user picking a 3000x3000 cover on covers.musichoarders.xyz via window.postMessage
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://covers.musichoarders.xyz',
        data: {
          bigUrl: 'https://covers.musichoarders.xyz/highres_3000x3000.png',
        },
      })
    );

    await waitFor(() => {
      expect(mockPopup.postMessage).toHaveBeenCalledWith(
        { type: 'close' },
        '*'
      );
      expect(
        screen.getAllByText(/3000×3000px/i).length
      ).toBeGreaterThanOrEqual(1);
    });

    // 2. Test "Extrair do Nome do Arquivo" tool
    fireEvent.click(screen.getByText(/Extrair do Nome do Arquivo/i));
    fireEvent.click(screen.getByText(/Aplicar Extração em Lote/i));
    await waitFor(() => {
      expect(
        screen.getByDisplayValue('Speak to Me (Parsed)')
      ).toBeInTheDocument();
    });

    // 3. Test Auto-Numeração button
    fireEvent.click(screen.getByText(/Auto-Numerar/i));

    // 4. Test preserving an unwanted tag by clicking "Preservar Todas" then "Marcar Todas para Limpeza"
    fireEvent.click(screen.getByText('Preservar Todas'));
    fireEvent.click(screen.getByText('Marcar Todas para Limpeza'));

    // 5. Submit cluster processing
    const submitBtn = screen.getByText(
      /Aplicar Tags e Mover para Biblioteca de Músicas/i
    );
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(lastProcessedPayload).not.toBeNull();
    });

    const payload = lastProcessedPayload as {
      targetMediaType: string;
      coverSelection: { mode: string; covImageUrl: string };
      files: Array<{ tags: Record<string, string> }>;
    };
    expect(payload.targetMediaType).toBe('music');
    expect(payload.coverSelection.mode).toBe('cov_url');
    expect(payload.coverSelection.covImageUrl).toBe(
      'https://covers.musichoarders.xyz/highres_3000x3000.png'
    );
    expect(payload.files[0].tags.title).toBe('Speak to Me (Parsed)');
  });

  it('opens Series cluster with container tag strip toggle and subtitle language/flag editor', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Severance.S01')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Severance.S01'));

    await waitFor(() => {
      expect(
        screen.getByText(
          /Limpar tags internas do container \(via ffmpeg\/mkvpropedit\)/i
        )
      ).toBeInTheDocument();
    });

    // Verify subtitle row is displayed with detected pt-BR and .forced
    expect(
      screen.getByText('Severance.S01E01.pt-BR.forced.srt')
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('pt-BR')).toBeInTheDocument();
  });

  it('navigates between Libraries tab (7 mount points) and Templates & Amostragem tab with random heuristic suggestions and collapsible sidebars', async () => {
    render(<App />);

    // 0. Verify responsive top navigation buttons collapse text to icon-only on narrow screens (< md)
    const downloadsNavBtn = screen.getByRole('button', {
      name: /Pasta de Downloads/i,
    });
    const librariesNavBtn = screen.getByRole('button', {
      name: /Editar Bibliotecas \(7 Pontos\)/i,
    });
    const templatesNavBtn = screen.getByRole('button', {
      name: /Templates & Amostragem/i,
    });
    expect(downloadsNavBtn.querySelector('span.hidden.md\\:inline')).not.toBeNull();
    expect(librariesNavBtn.querySelector('span.hidden.md\\:inline')).not.toBeNull();
    expect(templatesNavBtn.querySelector('span.hidden.md\\:inline')).not.toBeNull();

    // Test collapsing and re-opening the Downloads explorer sidebar (starts open by default)
    await waitFor(() => {
      expect(screen.getByText('Clusters em Downloads')).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByTitle('Ocultar barra lateral do explorador de pastas')
    );
    expect(screen.queryByText('Clusters em Downloads')).not.toBeInTheDocument();
    const reopenDownloadsBtn = screen.getByText(
      /Mostrar Explorador de Downloads/i
    );
    expect(reopenDownloadsBtn).toBeInTheDocument();
    fireEvent.click(reopenDownloadsBtn);
    expect(screen.getByText('Clusters em Downloads')).toBeInTheDocument();

    // 1. Switch to "Editar Bibliotecas (7 Pontos)" (starts open by default)
    fireEvent.click(screen.getByText(/Editar Bibliotecas \(7 Pontos\)/i));
    await waitFor(() => {
      expect(screen.getByText('Selecionar Biblioteca')).toBeInTheDocument();
    });

    // Switch library source to Series
    fireEvent.click(screen.getByText('Séries'));
    await waitFor(() => {
      expect(screen.getByText('Severance')).toBeInTheDocument();
    });

    // Test collapsing and re-opening the Library explorer sidebar
    fireEvent.click(
      screen.getByTitle('Ocultar barra lateral do explorador de pastas')
    );
    expect(screen.queryByText('Selecionar Biblioteca')).not.toBeInTheDocument();
    const reopenLibBtn = screen.getByText(
      /Mostrar Explorador de Biblioteca \(Séries\)/i
    );
    fireEvent.click(reopenLibBtn);
    expect(screen.getByText('Selecionar Biblioteca')).toBeInTheDocument();

    // 2. Switch to "Templates & Amostragem" (sampling sidebar starts open by default)
    fireEvent.click(screen.getByText(/Templates & Amostragem/i));
    await waitFor(() => {
      expect(
        screen.getByText(/Template Único — Músicas/i)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Sugestões por Amostragem da Biblioteca/i)
      ).toBeInTheDocument();
    });

    // Test collapsing and re-opening the Template Sampling sidebar
    fireEvent.click(
      screen.getByTitle('Ocultar painel lateral de amostragem')
    );
    expect(
      screen.queryByText(/Sugestões por Amostragem da Biblioteca/i)
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/Mostrar Painel de Amostragem/i));
    expect(
      screen.getByText(/Sugestões por Amostragem da Biblioteca/i)
    ).toBeInTheDocument();

    // Click "Detectar Sugestões da Biblioteca Existente (Por Amostragem)"
    fireEvent.click(
      screen.getByText(
        /Detectar Sugestões da Biblioteca Existente \(Por Amostragem\)/i
      )
    );

    await waitFor(() => {
      expect(screen.getByText(/38\/40 arquivos — 95%/i)).toBeInTheDocument();
      expect(
        screen.getByText(/Tags Encontradas na Amostragem/i)
      ).toBeInTheDocument();
      expect(screen.getByText('custom_sampled_tag')).toBeInTheDocument();
    });

    // Test adding a custom tag manually and applying discovered tags
    const customInput = screen.getByPlaceholderText(
      /Adicionar tag personalizada ao template/i
    );
    fireEvent.change(customInput, { target: { value: 'translator' } });
    fireEvent.click(screen.getByText(/Adicionar Tag ao Template/i));
    expect(screen.getByText('{translator}')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Usar Tags Encontradas'));

    // Test "Aumentar Amostra (+40)" button to expand the search zone from 40 to 80 files
    fireEvent.click(screen.getByText(/Aumentar Amostra \(\+40\)/i));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/templates/music/suggestions?maxSamples=80')
      );
    });

    // Apply suggested template ("Usar este") and Save
    fireEvent.click(screen.getByText('Usar este'));
    fireEvent.click(screen.getByText('Salvar Template'));

    await waitFor(() => {
      expect(
        screen.getByText(/Template salvo com sucesso!/i)
      ).toBeInTheDocument();
    });
  });
});
