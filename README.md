# Taggermon

All-purpose web media tag editor and library organizer built with **Node.js + TypeScript + Fastify + React + TailwindCSS + SQLite**.

Taggermon picks up single-media folder clusters from a `/downloads` directory (or existing libraries), lets you edit/clean tags, fetch high-resolution album covers via the official **COV - Cover Search Engine (`https://covers.musichoarders.xyz`)** Remote Protocol without downscaling, converts `.cbr`/`.epub` comics & manga into `.cbz` with `ComicInfo.xml`, matches and renames movie/series subtitles, and moves files into their respective library mount points according to customizable templates.

---

## Supported Media Types & Mount Points

| Media Type | Mount Point | Tagging & Conversion Behavior |
| :--- | :--- | :--- |
| **Music** | `/library/music` | Reads/writes template audio tags, cleans unwanted tags, integrates with **COV (`covers.musichoarders.xyz`)** via `remote.port=browser`, embeds original cover without downscale + writes `folder.jpg` / `folder.png`, and manages extra files (`.cue`, `.log`, `.nfo`, images). |
| **Audiobooks** | `/library/audiobooks` | Supports multi-file (`.mp3`, `.m4a`, `.flac`) and single-file (`.m4b`) audiobooks with `{author}`, `{narrator}`, `{series}`, `{series_part}`, `{book_title}`, cover embedding without downscale + `folder.jpg` / `folder.png`, and extra file management. |
| **Books** | `/library/books` | Edits `.epub` internal OPF (`content.opf`) metadata & cover, supports `.mobi` metadata/conversion, and organizes `.pdf` paths/filenames (skipping internal tags for PDFs). |
| **Comics** | `/library/comics` | Reads/writes clean `ComicInfo.xml` inside `.cbz`. Automatically converts `.cbr` and `.epub` (extracting pages in `<spine>` reading order as `0001.jpg`, `0002.jpg`...) to `.cbz`. Organizes `.pdf` paths/filenames without internal tags. |
| **Manga** | `/library/manga` | Reads/writes clean `ComicInfo.xml` inside `.cbz`. Automatically converts `.cbr` and `.epub` (in `<spine>` reading order) to `.cbz`. Organizes `.pdf` paths/filenames without internal tags. |
| **Movies** | `/library/movies` | No tag editing; includes toggle (on by default) to strip container metadata via `ffmpeg` / `mkvpropedit`. Auto-matches and renames accompanying subtitles (`<video>[.<lang>][.sdh][.forced].<ext>`). |
| **Series** | `/library/series` | No tag editing; includes toggle (on by default) to strip container metadata via `ffmpeg` / `mkvpropedit`. Auto-matches subtitles by episode (`SxxExx`) and renames them alongside each episode. |

---

## Template Syntax & Heuristic Discovery from Existing Libraries

- **Tokens & Zero-Padding**: `{album_artist}/{year} - {album}/[{disc:02}-]{track:02} - {title}.{ext}`
- **Conditional Optional Blocks `[...]`**: Anything wrapped in `[...]` is rendered only when all tokens inside the block are non-empty.
- **Heuristic Library Sampler**: On the **Templates & Amostragem** tab, click **"Detectar Sugestões da Biblioteca Existente"** to sample up to 40 existing files from that library mount point, cross-reference internal tags with directory/filename structure, and rank template suggestions.

---

## Deployment with Docker Compose

```yaml
services:
  taggermon:
    image: ghcr.io/alghostzx/taggermon:latest
    container_name: taggermon
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - /path/to/config:/config
      - /path/to/downloads:/downloads
      - /path/to/music:/library/music
      - /path/to/audiobooks:/library/audiobooks
      - /path/to/books:/library/books
      - /path/to/comics:/library/comics
      - /path/to/manga:/library/manga
      - /path/to/movies:/library/movies
      - /path/to/series:/library/series
```

Run:
```bash
docker compose up -d
```
Then open `http://localhost:3000` in your browser.

---

## Credits

- Album artwork search integration powered by **[COV - Cover Search Engine](https://covers.musichoarders.xyz)** (`https://covers.musichoarders.xyz`) using its official browser Remote Protocol.
