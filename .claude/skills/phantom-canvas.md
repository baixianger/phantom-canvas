# Phantom Canvas — AI Image/Video Generation via Gemini Web

Use this skill when the user wants to generate images or videos using Phantom Canvas (the `phantom-canvas` CLI or HTTP API that wraps Gemini Web).

## Prerequisites

```bash
bun install -g phantom-canvas
```

If not installed, guide the user to install it first.

## Session Management

Phantom Canvas requires a Google login session stored at `~/.phantom-canvas/session.json`.

### Check if session exists

```bash
test -f ~/.phantom-canvas/session.json && echo "session exists" || echo "no session"
```

### Session expired or missing

When you see any of these errors:
- `"No session found"`
- `"Session expired"`
- Exit code 1 from generate/serve

Tell the user:

> Your Phantom Canvas session needs a refresh. Please run:
> ```
> phantom-canvas login
> ```
> This opens a browser — log into your Google account, then press Enter in the terminal.

**Do NOT attempt to automate the login** — it requires human interaction with Google's auth flow.

### Remote server / SSH session

If the user is on a remote server without a display:
1. Run `phantom-canvas login` on a **local machine** with a browser
2. Copy the session file to the remote server:
   ```bash
   scp ~/.phantom-canvas/session.json user@remote:~/.phantom-canvas/session.json
   ```
3. Session cookies expire periodically — repeat when needed

## CLI Mode (for agents and scripts)

### Text-to-Image

```bash
phantom-canvas generate "pixel art knight, isometric, green #00FF00 background" -o knight.png
```

Output is JSON on stdout:
```json
{"status":"completed","path":"/path/to/knight.png","type":"image","conversation_id":"abc123"}
```

### Image-to-Image (with reference)

```bash
phantom-canvas generate "4 directions of this character in a 2x2 grid" --ref ./knight.png -o sheet.png
```

### Multi-Turn (iterative design)

```bash
# First generation
RESULT=$(phantom-canvas generate "pixel art knight, green bg")
CONV=$(echo $RESULT | jq -r .conversation_id)

# Continue in same conversation
phantom-canvas generate "make the sword bigger" --conversation $CONV -o refined.png

# Further iteration
phantom-canvas generate "show 4 directions" --conversation $CONV -o sheet.png
```

### Video Generation

```bash
phantom-canvas generate "looping walk cycle of this knight" --video --ref knight.png -o walk.mp4
```

Note: Video generation takes 1-2 minutes. Gemini has daily video quotas.

## Server Mode (for HTTP API consumers)

```bash
# Start server (background)
phantom-canvas serve &

# Or with visible browser for debugging
phantom-canvas serve --headed
```

### API calls

```bash
# Generate
curl -X POST localhost:8420/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "...", "reference_images": ["/path/to/ref.png"]}'

# Check status
curl localhost:8420/task/{task_id}

# Download result
curl localhost:8420/task/{task_id}/image/0 -o result.png
```

## Error Handling

| Error | Cause | Action |
|---|---|---|
| Exit code 1 + "no session" | Not logged in | Run `phantom-canvas login` |
| Exit code 1 + "session expired" | Cookies expired | Run `phantom-canvas login` |
| Empty images array | Generation failed or wrong detection | Retry with different prompt |
| Timeout | Gemini slow or quota hit | Increase `--timeout` or wait |
| "Video quota" | Daily Gemini video limit | Wait until tomorrow |

## Tips

- Use `--headed` flag to see what the browser is doing (debugging)
- Each `generate` call without `--conversation` starts a fresh Gemini chat
- Multi-turn with `--conversation` keeps Gemini's visual context — better for iterative design
- Reference images must be **absolute paths**
- Logs go to stderr, JSON output to stdout — safe to parse programmatically
