---
name: phantom-canvas
description: Generate images and videos via Gemini Web using an anti-detection browser. Supports text-to-image, img2img with reference upload, multi-turn conversation, and video generation. No API keys needed — uses your Google account session.
metadata:
  author: baixianger
  version: 0.3.3
  tags: [gemini, image-generation, video-generation, browser-automation, pixel-art, game-assets]
  repository: https://github.com/baixianger/phantom-canvas
allowed-tools: Bash
---

# Phantom Canvas

Generate images and videos through Gemini Web. No API keys — uses a saved Google session.

## Install

```bash
bun install -g phantom-canvas
```

## Session

Session is stored at `~/.phantom-canvas/session.json`.

```bash
# Check session
test -f ~/.phantom-canvas/session.json && echo "ready" || echo "need login"

# Login (requires browser)
phantom-canvas login

# Remote: export from local, import on server
phantom-canvas export ./session.json
phantom-canvas import ./session.json
```

When you see "Session expired" or exit code 1, tell the user to run `phantom-canvas login`. Do NOT automate login — it requires human interaction with Google auth.

## CLI Generate (for agents and scripts)

Output is JSON on stdout. Logs go to stderr.

### Text-to-Image

```bash
phantom-canvas generate "pixel art knight, isometric, green #00FF00 bg" -o knight.png
```

```json
{"status":"completed","path":"knight.png","type":"image","conversation_id":"abc123"}
```

### Image-to-Image (reference upload)

```bash
phantom-canvas generate "4 directions of this character in a 2x2 grid" --ref ./knight.png -o sheet.png
```

### Multi-Turn (iterative design)

```bash
# Round 1
RESULT=$(phantom-canvas generate "pixel art knight, green bg")
CONV=$(echo $RESULT | jq -r .conversation_id)

# Round 2 — Gemini remembers the character
phantom-canvas generate "make the sword bigger" --conversation $CONV -o v2.png

# Round 3
phantom-canvas generate "show 4 directions" --conversation $CONV -o sheet.png
```

### Video

```bash
phantom-canvas generate "walk cycle animation" --video --ref knight.png -o walk.mp4
```

Video takes 1-2 min. Gemini has daily video quotas.

## CLI Options

| Flag | Description |
|---|---|
| `-o, --output <file>` | Output file path |
| `--ref <file>` | Reference image (absolute path) |
| `--video` | Generate video instead of image |
| `--conversation <id>` | Continue previous conversation |
| `--timeout <secs>` | Timeout (default: 180 image, 300 video) |
| `--headed` | Show browser window |

## HTTP API (server mode)

```bash
phantom-canvas serve [--port 8420]
```

```bash
# Generate
curl -X POST localhost:8420/generate \
  -d '{"prompt":"...", "reference_images":["/path/to/ref.png"], "type":"image"}'

# Check status
curl localhost:8420/task/{id}

# Download
curl localhost:8420/task/{id}/image/0 -o result.png
```

## Error Handling

| Exit code / Error | Action |
|---|---|
| "No session found" | Run `phantom-canvas login` |
| "Session expired" | Run `phantom-canvas login` |
| Empty images | Retry with different prompt |
| Video quota | Wait until tomorrow |
