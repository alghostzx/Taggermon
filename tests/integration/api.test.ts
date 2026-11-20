import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server/index.js';
import {
  detectMediaTypeHeuristic,
  resolveSafePath,
} from '../../src/server/scanner.js';
import {
  createTestWorkspace,
  FIXTURES_DIR,
  TestWorkspace,
} from '../test-helpers.js';

describe('Integration: Fastify REST API, COV Proxy, Scanner & Security', () => {
  let ws: TestWorkspace;
  let app: FastifyInstance;

  beforeEach(async () => {
    ws = createTestWorkspace('taggermon-api-int-');
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    ws.cleanup();
  });

  it('auto-detects all 7 media types heuristically from cluster name and file extensions', () => {
    expect(
      detectMediaTypeHeuristic('Pink Floyd - Dark Side', [
        '01.flac',
        '02.flac',
        'cover.jpg',
      ]).mediaType
    ).toBe('music');

    expect(
      detectMediaTypeHeuristic('LOTR Audiobook', ['book.m4b']).mediaType
    ).toBe('audiobooks');

    expect(
      detectMediaTypeHeuristic('Isaac Asimov - Fundacao', [
        'fundacao.epub',
        'fundacao.mobi',
      ]).mediaType
    ).toBe('books');

    expect(
      detectMediaTypeHeuristic('Sandman Comics', ['issue01.cbz']).mediaType
    ).toBe('comics');

    expect(
      detectMediaTypeHeuristic('Berserk - Cap. 01', ['cap01.cbr']).mediaType
    ).toBe('manga');

    expect(
      detectMediaTypeHeuristic('Berserk Mangá', ['vol01.epub']).mediaType
    ).toBe('manga');

    expect(
      detectMediaTypeHeuristic('Batman Issue #01', ['issue01.pdf']).mediaType
    ).toBe('comics');

    expect(
      detectMediaTypeHeuristic('Blade Runner (1982)', ['Blade.Runner.1080p.mkv'])
        .mediaType
    ).toBe('movies');

    expect(
      detectMediaTypeHeuristic('Severance S01', [
        'Severance.S01E01.mkv',
        'Severance.S01E02.mkv',
      ]).mediaType
    ).toBe('series');
  });

  it('prevents Path Traversal attacks (../) in resolveSafePath and API endpoints', async () => {
    expect(() =>
      resolveSafePath(ws.downloadsDir, '../../etc/passwd')
    ).toThrow(/Invalid path traversal attempt/);

    const badClusterRes = await app.inject({
      method: 'GET',
      url: `/api/cluster?source=downloads&path=${encodeURIComponent(
        '../../etc'
      )}`,
    });
    expect(badClusterRes.statusCode).toBe(404);
    expect(badClusterRes.json().error).toMatch(/Invalid path traversal/);
  });

  it('serves /api/config, /api/templates, and updates templates via PUT /api/templates/:mediaType', async () => {
    const cfgRes = await app.inject({ method: 'GET', url: '/api/config' });
    expect(cfgRes.statusCode).toBe(200);
    const cfg = cfgRes.json();
    expect(cfg.allMediaTypes).toHaveLength(7);

    const tplRes = await app.inject({ method: 'GET', url: '/api/templates' });
    expect(tplRes.statusCode).toBe(200);
    expect(tplRes.json().music.pathTemplate).toBe(
      '{album_artist}/{year} - {album}'
    );

    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/templates/series',
      payload: {
        pathTemplate: '{series}/Temporada {season:02}',
        filenameTemplate: '{series} - S{season:02}E{episode:02}.{ext}',
        stripContainerTagsByDefault: true,
      },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().pathTemplate).toBe('{series}/Temporada {season:02}');

    const badPut = await app.inject({
      method: 'PUT',
      url: '/api/templates/nonexistent',
      payload: { pathTemplate: 'a', filenameTemplate: 'b' },
    });
    expect(badPut.statusCode).toBe(400);
  });

  it('proxies and inspects high-resolution cover art from a COV URL without downscaling and embeds it via /api/process-cluster', async () => {
    // Spin up a local HTTP server simulating a COV cover artwork host
    const highResPngBytes = fs.readFileSync(
      path.join(FIXTURES_DIR, 'extras/cover_highres.png')
    );

    const covMockServer = http.createServer((req, res) => {
      if (req.url === '/artwork/pink_floyd_64x64.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(highResPngBytes);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>((resolve) => covMockServer.listen(0, '127.0.0.1', resolve));
    const addr = covMockServer.address() as { port: number };
    const covImageUrl = `http://127.0.0.1:${addr.port}/artwork/pink_floyd_64x64.png`;

    try {
      // 1. Test /api/cov/inspect-url
      const inspectRes = await app.inject({
        method: 'POST',
        url: '/api/cov/inspect-url',
        payload: { imageUrl: covImageUrl },
      });
      expect(inspectRes.statusCode).toBe(200);
      const inspectJson = inspectRes.json();
      expect(inspectJson.width).toBe(64);
      expect(inspectJson.height).toBe(64);
      expect(inspectJson.format).toBe('png');
      expect(inspectJson.sizeBytes).toBe(highResPngBytes.length);

      // 2. Prepare a music cluster in downloads with extra files (.cue, .log, .nfo)
      const clusterDir = path.join(ws.downloadsDir, 'PinkFloyd_DSOTM');
      ws.copyFixture('audio/sample.mp3', path.join(clusterDir, '01.mp3'));
      ws.copyFixture('extras/album.cue', path.join(clusterDir, 'album.cue'));
      ws.copyFixture('extras/rip.log', path.join(clusterDir, 'rip.log'));
      ws.copyFixture(
        'extras/release.nfo',
        path.join(clusterDir, 'release.nfo')
      );

      // First run with deleteIgnoredExtrasAndCleanupSource = false and release.nfo = 'ignore'
      // to verify the source folder is preserved when an ignored file remains, while 'move' and 'delete' actions work
      const procRes = await app.inject({
        method: 'POST',
        url: '/api/process-cluster',
        payload: {
          sourceRoot: 'downloads',
          clusterRelativePath: 'PinkFloyd_DSOTM',
          targetMediaType: 'music',
          deleteIgnoredExtrasAndCleanupSource: false,
          coverSelection: {
            mode: 'cov_url',
            covImageUrl,
          },
          files: [
            {
              relativePath: '01.mp3',
              tags: {
                album_artist: 'Pink Floyd',
                artist: 'Pink Floyd',
                album: 'The Dark Side of the Moon',
                year: '1973',
                track: '1',
                title: 'Speak to Me',
              },
            },
          ],
          extraFiles: [
            { relativePath: 'album.cue', action: 'move' },
            { relativePath: 'rip.log', action: 'delete' },
            { relativePath: 'release.nfo', action: 'ignore' },
          ],
        },
      });

      expect(procRes.statusCode).toBe(200);
      const procData = procRes.json();
      expect(procData.success).toBe(true);
      expect(procData.movedExtras).toContain(
        'Pink Floyd/1973 - The Dark Side of the Moon/album.cue'
      );
      expect(procData.deletedExtras).toContain('rip.log');
      // Because release.nfo was ignored and deleteIgnoredExtrasAndCleanupSource was false, source folder still exists
      expect(procData.sourceFolderRemoved).toBe(false);
      expect(fs.existsSync(path.join(clusterDir, 'release.nfo'))).toBe(true);

      // Verify folder.png saved in library matches exact original COV bytes (no downscale)
      const savedFolderPng = path.join(
        ws.libraryDirs.music,
        'Pink Floyd/1973 - The Dark Side of the Moon/folder.png'
      );
      expect(fs.existsSync(savedFolderPng)).toBe(true);
      expect(fs.readFileSync(savedFolderPng).equals(highResPngBytes)).toBe(true);

      // 3. Test preview-image endpoint for both folder image and embedded audio cover
      const previewFolderImg = await app.inject({
        method: 'GET',
        url: `/api/preview-image?source=music&clusterPath=${encodeURIComponent(
          'Pink Floyd/1973 - The Dark Side of the Moon'
        )}&filePath=folder.png`,
      });
      expect(previewFolderImg.statusCode).toBe(200);
      expect(previewFolderImg.headers['content-type']).toBe('image/png');

      const previewEmbeddedImg = await app.inject({
        method: 'GET',
        url: `/api/preview-image?source=music&clusterPath=${encodeURIComponent(
          'Pink Floyd/1973 - The Dark Side of the Moon'
        )}&filePath=${encodeURIComponent('01 - Speak to Me.mp3')}&embedded=true`,
      });
      expect(previewEmbeddedImg.statusCode).toBe(200);
    } finally {
      covMockServer.close();
    }
  });

  it('allows editing and reorganizing items already inside a Library mount and cleans up old empty folders', async () => {
    // Place an album in /library/music under a misspelled artist folder
    const oldLibDir = path.join(
      ws.libraryDirs.music,
      'Pnk Floyd/1973 - Dark Side'
    );
    ws.copyFixture('audio/sample.mp3', path.join(oldLibDir, '01 - Speak.mp3'));

    // Scan cluster directly from `music` library source
    const scanRes = await app.inject({
      method: 'GET',
      url: `/api/cluster?source=music&path=${encodeURIComponent(
        'Pnk Floyd/1973 - Dark Side'
      )}`,
    });
    expect(scanRes.statusCode).toBe(200);
    expect(scanRes.json().sourceRoot).toBe('music');

    // Reorganize inside /library/music with corrected artist name
    const procRes = await app.inject({
      method: 'POST',
      url: '/api/process-cluster',
      payload: {
        sourceRoot: 'music',
        clusterRelativePath: 'Pnk Floyd/1973 - Dark Side',
        targetMediaType: 'music',
        deleteIgnoredExtrasAndCleanupSource: true,
        files: [
          {
            relativePath: '01 - Speak.mp3',
            tags: {
              album_artist: 'Pink Floyd',
              artist: 'Pink Floyd',
              album: 'The Dark Side of the Moon',
              year: '1973',
              track: '1',
              title: 'Speak to Me',
            },
          },
        ],
      },
    });
    expect(procRes.statusCode).toBe(200);
    expect(procRes.json().sourceFolderRemoved).toBe(true);

    // Old misspelled artist directory tree (`Pnk Floyd`) was automatically cleaned up
    expect(fs.existsSync(path.join(ws.libraryDirs.music, 'Pnk Floyd'))).toBe(
      false
    );
    expect(
      fs.existsSync(
        path.join(
          ws.libraryDirs.music,
          'Pink Floyd/1973 - The Dark Side of the Moon/01 - Speak to Me.mp3'
        )
      )
    ).toBe(true);
  });

  it('supports /api/parse-pattern and /api/preview-destinations endpoints', async () => {
    const parseRes = await app.inject({
      method: 'POST',
      url: '/api/parse-pattern',
      payload: {
        pattern: '{track:02} - {title}',
        inputs: [
          { id: '1', text: '01 - Speak to Me' },
          { id: '2', text: '02 - Breathe' },
        ],
      },
    });
    expect(parseRes.statusCode).toBe(200);
    expect(parseRes.json().results).toEqual([
      { id: '1', extracted: { track: '1', title: 'Speak to Me' } },
      { id: '2', extracted: { track: '2', title: 'Breathe' } },
    ]);

    const prevRes = await app.inject({
      method: 'POST',
      url: '/api/preview-destinations',
      payload: {
        mediaType: 'manga',
        pathTemplate: '{series}[/Vol. {volume:02}]',
        filenameTemplate: '{series} - Cap. {number:03}.{ext}',
        files: [
          {
            relativePath: 'ch1.cbr',
            ext: 'cbr',
            tags: { series: 'Berserk', volume: '1', number: '1' },
          },
        ],
      },
    });
    expect(prevRes.statusCode).toBe(200);
    // Note: .cbr automatically previews as .cbz
    expect(prevRes.json().previews[0].destinationFullRelativePath).toBe(
      'Berserk/Vol. 01/Berserk - Cap. 001.cbz'
    );
  });
});
