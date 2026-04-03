---
name: phantom-canvas
description: CLI tool and HTTP API for Gemini image/video generation via Chrome CDP. Text-to-image, img2img with reference upload, multi-turn conversation, video generation. No API keys — uses Chrome's persistent login. Built for AI agents.
metadata:
  author: baixianger
  version: 2.0.1
  tags: [gemini, image-generation, video-generation, browser-automation, pixel-art, game-assets, ai-agent, chrome-cdp]
  repository: https://github.com/baixianger/phantom-canvas
allowed-tools: Bash
---

# Phantom Canvas

CLI + HTTP API for image and video generation through Gemini Web. No API keys — uses Chrome's persistent Google login.

## Install

```bash
bun add -g phantom-canvas    # or: npm install -g phantom-canvas
```

## Session

Chrome stores login in `~/.phantom-canvas/chrome-profile/`. First time use:

```bash
# Open Chrome, login to Google in the window that opens
phantom-canvas chrome

# Or just run generate — Chrome auto-launches
phantom-canvas generate "test" --headed
```

Login persists across sessions. No export/import needed.

When you see "Session expired", tell the user to run `phantom-canvas chrome` and re-login. Do NOT automate login — it requires human interaction with Google auth.

## CLI Generate (for agents and scripts)

Output is JSON on stdout. Logs go to stderr. Images downloaded at full resolution (1024px).

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
| `--headed` | Show browser window (default: headless) |
| `--cdp <url>` | Chrome DevTools URL (default: http://127.0.0.1:9222) |

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

## Tips

- Use `#00FF00` green background instead of "transparent" — Gemini draws checkerboard patterns for transparent
- Green screen is easy to chroma-key in post-processing
- For game sprites, generate single characters first, then use `--ref` for multi-angle sheets
- Headless mode works but may be slower — use `--headed` for faster/more reliable generation

## Error Handling

| Exit code / Error | Action |
|---|---|
| Chrome failed to start | Install Chrome or set path |
| "Session expired" | Run `phantom-canvas chrome`, re-login |
| Timeout / empty images | Retry with different prompt or longer `--timeout` |
| Video quota | Wait until tomorrow |
