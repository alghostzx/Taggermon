# Stage 1: Build Frontend & Backend
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json vite.config.ts tailwind.config.js postcss.config.js ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

# Stage 2: Runtime Container with Media Tools
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    mkvtoolnix \
    p7zip-full \
    unrar-free \
    calibre-bin \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    CONFIG_DIR=/config \
    DOWNLOADS_DIR=/downloads \
    LIBRARY_MUSIC_DIR=/library/music \
    LIBRARY_AUDIOBOOKS_DIR=/library/audiobooks \
    LIBRARY_BOOKS_DIR=/library/books \
    LIBRARY_COMICS_DIR=/library/comics \
    LIBRARY_MANGA_DIR=/library/manga \
    LIBRARY_MOVIES_DIR=/library/movies \
    LIBRARY_SERIES_DIR=/library/series

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN mkdir -p \
    /config \
    /downloads \
    /library/music \
    /library/audiobooks \
    /library/books \
    /library/comics \
    /library/manga \
    /library/movies \
    /library/series

VOLUME [ \
  "/config", \
  "/downloads", \
  "/library/music", \
  "/library/audiobooks", \
  "/library/books", \
  "/library/comics", \
  "/library/manga", \
  "/library/movies", \
  "/library/series" \
]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/config || exit 1

CMD ["node", "dist/server/index.js"]
