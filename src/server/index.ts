import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { getAllMountPaths } from './config.js';
import { registerApiRoutes } from './routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function buildServer() {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    bodyLimit: 50 * 1024 * 1024, // 50MB for high-res uncompressed cover images
  });

  await app.register(cors, {
    origin: true,
  });

  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024,
    },
  });

  // Ensure SQLite database and mount directories exist
  getDb();
  const mounts = getAllMountPaths();
  for (const dirPath of Object.values(mounts)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  await registerApiRoutes(app);

  // Serve compiled React frontend in production if dist/client exists
  const clientDistPath = path.resolve(__dirname, '../client');
  if (fs.existsSync(clientDistPath) && fs.existsSync(path.join(clientDistPath, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: clientDistPath,
      prefix: '/',
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        reply.status(404).send({ error: 'API route not found' });
      } else {
        reply.sendFile('index.html');
      }
    });
  }

  return app;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';
  buildServer()
    .then((app) => app.listen({ port, host }))
    .then(() => {
      console.log(`Taggermon server listening on http://${host}:${port}`);
    })
    .catch((err) => {
      console.error('Failed to start Taggermon server:', err);
      process.exit(1);
    });
}
