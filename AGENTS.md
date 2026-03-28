# AGENTS.md

This repository is an AI agent tool for image and video generation.

## What this tool does

Phantom Canvas wraps Gemini Web as a programmable API. It launches an anti-detection browser (camoufox), automates Gemini's web UI, and exposes generation capabilities via CLI and HTTP API.

## How to use

```bash
bun install -g phantom-canvas
phantom-canvas login          # first time
phantom-canvas generate "your prompt" -o output.png
```

See [SKILL.md](SKILL.md) for complete agent instructions.

## Architecture

- `index.ts` — CLI entry point (login / generate / serve / import / export)
- `lib/browser.ts` — Browser automation (camoufox + Playwright)
- `lib/tasks.ts` — Async task queue

## Session

Stored at `~/.phantom-canvas/session.json`. Requires `phantom-canvas login` (human interaction with Google auth). For remote servers, use `export` + `import`.
