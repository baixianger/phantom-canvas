<p align="center">
  <img src="https://raw.githubusercontent.com/baixianger/phantom-canvas/main/logo.png" width="128" alt="Phantom Canvas logo" />
</p>

<h1 align="center">Phantom Canvas</h1>

<p align="center"><strong>Your Gemini web app as a service.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/phantom-canvas"><img src="https://img.shields.io/npm/v/phantom-canvas?color=cb3837&logo=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/phantom-canvas"><img src="https://img.shields.io/npm/dm/phantom-canvas?color=cb3837" alt="npm downloads" /></a>
  <a href="https://github.com/baixianger/phantom-canvas/blob/main/LICENSE"><img src="https://img.shields.io/github/license/baixianger/phantom-canvas" alt="license" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?logo=bun" alt="Bun" /></a>
</p>

Turn the free [Gemini](https://gemini.google.com) web interface into a programmable HTTP API for image and video generation. No API keys, no billing — just your Google account.

<p align="center">
  <img src="https://raw.githubusercontent.com/baixianger/phantom-canvas/main/diagram.png" width="700" alt="Your App → HTTP → Phantom Canvas → browser → Gemini Web (your subscription)" />
</p>

A persistent Chrome browser runs in the background via CDP, automating Gemini's web UI. You send prompts via HTTP, Phantom Canvas handles the rest — typing, uploading reference images, waiting for generation, and downloading the result.

Already paying for Google AI / Gemini Advanced? Turn your subscription into your own private API — save on per-call billing while keeping the same generation quality.

Built with **Bun + Playwright + Hono + Chrome CDP**.

## Quick start

```bash
# 1. Install
bun add -g phantom-canvas

# 2. Generate (Chrome auto-launches, no setup needed)
phantom-canvas generate "pixel art knight, isometric"
phantom-canvas serve                 # HTTP API server

# First time: login to Google in the Chrome window that opens
# After that, everything is automatic — your login persists
```

## Commands

| Command | Description |
|---|---|
| `phantom-canvas chrome` | Manually start Chrome (usually not needed) |
| `phantom-canvas generate "prompt"` | One-shot generation |
| `phantom-canvas serve` | Start HTTP API server |

### Generate options

| Flag | Description |
|---|---|
| `--ref <file>` | Reference image (img2img) |
| `--video` | Generate video instead of image |
| `-o, --output <file>` | Output file path |
| `--conversation <id>` | Continue previous conversation |
| `--timeout <secs>` | Timeout (default: 180/300) |
| `--cdp <url>` | Chrome DevTools URL (default: http://127.0.0.1:9222) |

## API

### `POST /generate`

Submit an image or video generation task. Returns immediately with a task ID.

```bash
# Image
curl -X POST localhost:8420/generate \
  -d '{"prompt": "pixel art knight, isometric view, green #00FF00 bg"}'

# With reference image (img2img)
curl -X POST localhost:8420/generate \
  -d '{
    "prompt": "same character from 4 angles in a 2x2 grid",
    "reference_images": ["/path/to/sprite.png"]
  }'

# Video
curl -X POST localhost:8420/generate \
  -d '{"prompt": "knight walking in place, looping", "type": "video", "timeout_secs": 300}'
```

**Parameters:**

| Field | Type | Default | Description |
|---|---|---|---|
| `prompt` | string | required | Generation prompt |
| `type` | `"image"` \| `"video"` | `"image"` | Output type |
| `reference_images` | string[] | — | Local file paths to upload as context |
| `num_images` | number | 1 | How many images to generate |
| `timeout_secs` | number | 180 / 300 | Timeout (image / video) |
| `callback_url` | string | — | Webhook URL, POST on completion |

### `GET /task/:id`

Check task status.

```json
{
  "task_id": "abc123",
  "status": "completed",
  "images": [{"index": 0, "url": "/task/abc123/image/0", "type": "image"}],
  "elapsed_secs": 45.3
}
```

### `GET /task/:id/image/:index`

Raw file download (image or video).

### `GET /health`

Server status.

### `POST /session/refresh`

Reload Gemini page.

### `POST /session/save`

Save current session to disk.

### `POST /debug/eval`

Execute JS in the browser (debugging).

### `GET /debug/screenshot`

Capture browser page as PNG.

## Game asset pipeline

Built for the [AI Game Asset Pipeline](../ai-game-asset-pipeline.md) — generating Final Fantasy Tactics-style isometric sprites without paid API keys.

```bash
# Stage 1: anchor sprite
curl -X POST localhost:8420/generate \
  -d '{"prompt": "SE-facing isometric pixel art knight, FFT style, #00FF00 bg"}'

# Stage 2: cardinal facings (with reference)
curl -X POST localhost:8420/generate \
  -d '{"prompt": "2x2 grid: N, E, S, SE views of same character", "reference_images": ["anchor.png"]}'

# Stage 5: walk animation
curl -X POST localhost:8420/generate \
  -d '{"prompt": "looping walk cycle", "reference_images": ["anchor.png"], "type": "video"}'
```

## Limitations

- Gemini has daily generation quotas (especially video)
- One request at a time (serial queue)
- Session cookies expire periodically
- Image quality depends on Gemini's model

## License

MIT
