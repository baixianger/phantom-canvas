# AGENTS.md

CLI tool and HTTP API for AI image/video generation via Gemini Web.

## What this tool does

Phantom Canvas wraps Gemini Web as a programmable CLI and HTTP API. It launches Chrome via CDP, automates Gemini's web UI, and exposes generation capabilities for AI agents, scripts, and applications.

## How to use

```bash
bun add -g phantom-canvas       # or: npm install -g phantom-canvas
phantom-canvas generate "your prompt" -o output.png --headed  # first time: login in Chrome
phantom-canvas generate "your prompt" -o output.png           # after that: headless
```

See [SKILL.md](SKILL.md) for complete agent instructions.

## Architecture

- `index.ts` — CLI entry point (chrome / generate / serve)
- `lib/browser.ts` — Browser automation (Chrome CDP + Playwright)
- `lib/tasks.ts` — Async task queue
- `dist/index.js` — Compiled Node.js bundle

## Session

Chrome stores login in `~/.phantom-canvas/chrome-profile/`. First time requires `--headed` to login interactively. After that, login persists and headless mode works.
