# Phantom Canvas

Anti-detection browser wrapped as an HTTP API for AI image/video generation. Uses [Gemini Web](https://gemini.google.com) through [camoufox](https://github.com/daijro/camoufox) — no API keys needed.

Built with **Bun + camoufox-js + Hono**.

## How it works

```
Your app  ──HTTP──>  Phantom Canvas  ──browser──>  Gemini Web
                     (camoufox)                    (free tier)
```

Phantom Canvas keeps a persistent anti-detection Firefox browser running in the background. When you send a prompt via HTTP, it types into Gemini's input, waits for the generated image/video, downloads it, and returns the result — all through DOM automation with a real browser session.

## Quick start

```bash
# Install
bun install
bun run setup     # downloads camoufox browser binary

# First run — login interactively
bun run dev       # opens browser window
# Login to Google in the browser, then:
curl -X POST localhost:8420/session/save \
  -d '{"path": "./sessions/my-session.json"}'

# Production — headless with saved session
GEMINI_SESSION=./sessions/my-session.json bun start
```

## Configuration

| Env / Flag | Description | Default |
|---|---|---|
| `GEMINI_SESSION` or `--session <path>` | Path to Playwright storageState JSON | none (login required) |
| `PORT` or `--port <n>` | HTTP server port | `8420` |
| `HEADED` or `--headed` | Show browser window | `false` |
| `OUTPUT_DIR` | Where to save generated files | `./output` |

## API

### `POST /generate`

Submit an image or video generation task. Returns immediately with a task ID.

```bash
# Image generation
curl -X POST localhost:8420/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "pixel art knight, isometric, green #00FF00 background",
    "type": "image",
    "timeout_secs": 180
  }'
# => {"task_id": "abc123", "status": "queued"}

# With reference image (img2img)
curl -X POST localhost:8420/generate \
  -d '{
    "prompt": "same character from 4 angles in a 2x2 grid",
    "reference_images": ["/path/to/sprite.png"],
    "type": "image"
  }'

# Video generation
curl -X POST localhost:8420/generate \
  -d '{
    "prompt": "pixel art knight walking in place, looping animation",
    "type": "video",
    "timeout_secs": 300
  }'
```

**Parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | Generation prompt |
| `type` | `"image"` \| `"video"` | no | Default: `"image"` |
| `reference_images` | string[] | no | Local file paths to upload as context |
| `num_images` | number | no | How many images to generate (default: 1) |
| `timeout_secs` | number | no | Timeout per generation (default: 180 for image, 300 for video) |
| `callback_url` | string | no | Webhook URL — POST when task completes |

### `GET /task/:id`

Check task status and get results.

```bash
curl localhost:8420/task/abc123
```

```json
{
  "task_id": "abc123",
  "status": "completed",
  "prompt": "...",
  "images": [
    {"index": 0, "path": "/output/sprite_123_0.png", "url": "/task/abc123/image/0"}
  ],
  "elapsed_secs": 45.3
}
```

Status values: `queued` | `running` | `completed` | `failed`

### `GET /task/:id/image/:index`

Get the raw generated file (image or video).

```bash
# Save to file
curl localhost:8420/task/abc123/image/0 -o result.png

# Open directly
open "http://localhost:8420/task/abc123/image/0"
```

### `GET /health`

```bash
curl localhost:8420/health
# => {"status": "ready", "busy": false, "tasks": {"pending": 0, "completed": 3}}
```

### `POST /session/login`

Navigate to Gemini login page (use with `--headed` mode).

### `POST /session/save`

Save current browser session to disk.

```bash
curl -X POST localhost:8420/session/save \
  -d '{"path": "./sessions/my-account.json"}'
```

### `POST /session/refresh`

Reload Gemini page (recovery from stuck state).

### `POST /debug/eval`

Execute JavaScript in the browser page (debugging only).

```bash
curl -X POST localhost:8420/debug/eval \
  -d '{"script": "document.title"}'
```

### `GET /debug/screenshot`

Capture current browser page as PNG.

## Game asset pipeline

Phantom Canvas was built to replace paid API calls (fal.ai) in the [AI Game Asset Pipeline](../ai-game-asset-pipeline.md) for generating Final Fantasy Tactics-style isometric sprites.

### Pipeline stages

```
Stage 1: Anchor sprite       POST /generate  (text prompt)
Stage 2: Cardinal facings    POST /generate  (prompt + reference_images)
Stage 3: Diagonal facings    POST /generate  (prompt + reference_images)
Stage 4: Assembly            Local code (PIL/Sharp — crop, mirror, normalize)
Stage 5: Walk animation      POST /generate  (type: "video" + reference_images)
```

### Example: full turnaround

```bash
# Stage 1 — generate anchor
TASK=$(curl -s -X POST localhost:8420/generate -d '{
  "prompt": "SE-facing isometric pixel art knight, FFT style, green #00FF00 bg"
}' | jq -r .task_id)

# Wait and download
sleep 60
curl localhost:8420/task/$TASK/image/0 -o anchor.png

# Stage 2 — generate 4 cardinal facings from anchor
TASK=$(curl -s -X POST localhost:8420/generate -d "{
  \"prompt\": \"Using uploaded character, create 2x2 grid: N (back), E (right), S (front), SE (same). Same style, green bg.\",
  \"reference_images\": [\"$(pwd)/anchor.png\"]
}" | jq -r .task_id)

sleep 60
curl localhost:8420/task/$TASK/image/0 -o cardinals.png

# Stage 5 — walk animation
TASK=$(curl -s -X POST localhost:8420/generate -d "{
  \"prompt\": \"Looping walk cycle of this pixel art knight, isometric view\",
  \"reference_images\": [\"$(pwd)/anchor.png\"],
  \"type\": \"video\",
  \"timeout_secs\": 300
}" | jq -r .task_id)

sleep 120
curl localhost:8420/task/$TASK/image/0 -o walk.mp4
```

## Architecture

```
index.ts              Hono HTTP server + task queue runner
lib/
  browser.ts          GeminiBrowser — camoufox lifecycle, DOM automation
  tasks.ts            In-memory task queue with status tracking
```

**Key design decisions:**

- **Persistent browser** — camoufox stays open between requests, avoiding 60-100s SPA cold-start
- **Async tasks** — generation takes 30-120s, so requests return immediately with a task ID
- **DOM automation** — types into Gemini's input, waits for generated media, downloads results
- **Upload preview exclusion** — detects generated images by filtering out avatars, upload previews, and icons
- **Multi-locale** — selectors support English, Danish, German, and other Gemini UI languages

## Limitations

- Gemini has daily generation quotas (especially for video)
- One request at a time (serial queue — browser can only do one thing)
- Session cookies expire periodically — re-login needed
- Generated image quality depends on Gemini's model, not configurable

## License

MIT
