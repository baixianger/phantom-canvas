/**
 * Phantom Canvas — Your Gemini web app as a service
 *
 * Commands:
 *   phantom-canvas login                    — login to Google, save session
 *   phantom-canvas generate "prompt"        — one-shot generation (for agents/scripts)
 *   phantom-canvas serve                    — start HTTP API server
 */

import { Hono } from "hono";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { GeminiBrowser } from "./lib/browser";
import { TaskQueue } from "./lib/tasks";

// ── Config ──────────────────────────────────────────────────────
const DATA_DIR = join(homedir(), ".phantom-canvas");
const SESSION_PATH = join(DATA_DIR, "session.json");
const OUTPUT_DIR = join(DATA_DIR, "output");
const HEADED = Bun.argv.includes("--headed");
const USE_CHROME = Bun.argv.includes("--chrome");
const CDP_URL = Bun.argv.find((_, i, a) => a[i - 1] === "--cdp") ?? "http://127.0.0.1:9222";
const PORT = parseInt(Bun.argv.find((_, i, a) => a[i - 1] === "--port") ?? "8420");

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

const MODE = Bun.argv[2]; // "login", "generate", "serve", or undefined

// ── Helpers ─────────────────────────────────────────────────────
function requireSession() {
  if (USE_CHROME) return; // Chrome mode uses browser's own session
  if (!existsSync(SESSION_PATH)) {
    console.error("\n  No session found. Run first:\n\n    phantom-canvas login\n");
    process.exit(1);
  }
}

function parseArg(flag: string): string | undefined {
  const i = Bun.argv.indexOf(flag);
  return i !== -1 && i + 1 < Bun.argv.length ? Bun.argv[i + 1] : undefined;
}

// ═══════════════════════════════════════════════════════════════
//  CHROME (launch Chrome with debugging port)
// ═══════════════════════════════════════════════════════════════
if (MODE === "chrome") {
  const { platform: plat } = await import("os");
  const { execSync } = await import("child_process");
  const dataDir = parseArg("--user-data-dir") ?? join(homedir(), ".phantom-canvas", "chrome-profile");
  mkdirSync(dataDir, { recursive: true });

  const cmds: Record<string, string> = {
    darwin: `/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir="${dataDir}"`,
    win32: `start chrome.exe --remote-debugging-port=9222 --user-data-dir="${dataDir}"`,
    linux: `google-chrome --remote-debugging-port=9222 --user-data-dir="${dataDir}"`,
  };
  const cmd = cmds[plat()] ?? cmds.linux;

  console.log("\n  Phantom Canvas — Chrome Mode\n");
  console.log(`  Starting Chrome with debugging port...\n`);
  console.log(`  Data dir: ${dataDir}\n`);
  console.log("  Login to Google in Chrome, then use:\n");
  console.log("    phantom-canvas generate \"your prompt\" --chrome");
  console.log("    phantom-canvas serve --chrome\n");

  execSync(cmd, { stdio: "inherit" });
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════
//  LOGIN
// ═══════════════════════════════════════════════════════════════
if (MODE === "login") {
  console.log("\n  Phantom Canvas — Login\n");
  console.log("  Starting browser...");

  const browser = new GeminiBrowser("", OUTPUT_DIR, false, USE_CHROME, CDP_URL);
  await browser.launch();

  console.log("  Opening Gemini — please login in the browser.\n");
  const page = browser.getPage()!;
  await page.goto("https://gemini.google.com/app", {
    waitUntil: "domcontentloaded", timeout: 60_000,
  }).catch(() => {});

  process.stdout.write("  Press ENTER after you have logged in > ");
  for await (const _ of console) break;

  // Verify login before saving
  const url = page.url();
  const title = await page.title();
  const isLoggedIn = url.includes("gemini.google.com")
    && !url.includes("accounts.google.com")
    && !title.includes("Error");
  if (!isLoggedIn) {
    const reason = title.includes("Error") ? `Server error (${title})` : "Login not detected";
    console.error(`\n  ${reason} — session NOT saved. Please try again.\n`);
    await browser.close();
    process.exit(1);
  }

  await page.context().storageState({ path: SESSION_PATH });
  console.log(`\n  Session saved to ${SESSION_PATH}\n`);
  await browser.close();
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════
//  SESSION EXPORT (copy session out for transfer)
// ═══════════════════════════════════════════════════════════════
if (MODE === "export") {
  requireSession();
  const dest = Bun.argv[3];
  if (!dest) {
    console.error("\n  Usage: phantom-canvas export <output-path>\n");
    console.error("  Example:");
    console.error("    phantom-canvas export ./session.json");
    console.error("    scp ./session.json user@remote:/tmp/session.json\n");
    process.exit(1);
  }
  await Bun.write(resolve(dest), Bun.file(SESSION_PATH));
  console.log(`\n  Session exported to ${resolve(dest)}\n`);
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════
//  SESSION IMPORT (for remote servers)
// ═══════════════════════════════════════════════════════════════
if (MODE === "import") {
  const source = Bun.argv[3];
  if (!source) {
    console.error("\n  Usage: phantom-canvas import <session.json>\n");
    console.error("  Copy a session file from another machine:\n");
    console.error("    # On local machine:");
    console.error("    scp ~/.phantom-canvas/session.json user@remote:/tmp/session.json\n");
    console.error("    # On remote server:");
    console.error("    phantom-canvas import /tmp/session.json\n");
    process.exit(1);
  }

  if (!existsSync(resolve(source))) {
    console.error(`\n  File not found: ${source}\n`);
    process.exit(1);
  }

  const data = await Bun.file(resolve(source)).text();
  // Basic validation
  try {
    const parsed = JSON.parse(data);
    if (!parsed.cookies) throw new Error("invalid format");
  } catch {
    console.error("\n  Invalid session file — must be a Playwright storageState JSON.\n");
    process.exit(1);
  }

  await Bun.write(SESSION_PATH, data);
  console.log(`\n  Session imported to ${SESSION_PATH}\n`);
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════
//  GENERATE (CLI one-shot mode for agents)
// ═══════════════════════════════════════════════════════════════
if (MODE === "generate") {
  requireSession();

  // Parse CLI args
  const prompt = Bun.argv[3];
  if (!prompt || prompt.startsWith("-")) {
    console.error(`
  Usage: phantom-canvas generate "your prompt" [options]

  Options:
    --ref <file>        Reference image path (img2img)
    --video             Generate video instead of image
    --output, -o <file> Output file path (default: auto)
    --headed            Show browser window
    --timeout <secs>    Timeout (default: 180 for image, 300 for video)
    --conversation <id> Continue a previous conversation

  Examples:
    phantom-canvas generate "pixel art knight, isometric, green bg"
    phantom-canvas generate "4 directions of this character" --ref knight.png
    phantom-canvas generate "walk cycle animation" --video -o walk.mp4
`);
    process.exit(1);
  }

  const refImage = parseArg("--ref");
  const isVideo = Bun.argv.includes("--video");
  const outputFile = parseArg("--output") || parseArg("-o");
  const timeout = parseInt(parseArg("--timeout") ?? (isVideo ? "300" : "180"));
  const conversationId = parseArg("--conversation");

  console.error("[phantom-canvas] Starting browser...");
  const browser = new GeminiBrowser(SESSION_PATH, OUTPUT_DIR, !HEADED, USE_CHROME, CDP_URL);
  await browser.launch();

  console.error("[phantom-canvas] Navigating to Gemini...");
  await browser.navigateToGemini();

  console.error(`[phantom-canvas] Generating: ${prompt.slice(0, 60)}...`);
  const results = await browser.generateImages({
    prompt,
    referenceImages: refImage ? [resolve(refImage)] : undefined,
    numImages: 1,
    timeoutSecs: timeout,
    type: isVideo ? "video" : "image",
    conversationId,
  });

  const convId = browser.getConversationId();
  await browser.close();

  if (results.length === 0) {
    console.error("[phantom-canvas] Generation failed — no output produced.");
    process.exit(1);
  }

  // Copy to output file if specified
  let finalPath = results[0].path;
  if (outputFile) {
    const outPath = resolve(outputFile);
    await Bun.write(outPath, Bun.file(finalPath));
    finalPath = outPath;
  }

  // Output JSON to stdout (agent-friendly)
  const output = {
    status: "completed",
    path: finalPath,
    type: results[0].type,
    conversation_id: convId,
  };
  console.log(JSON.stringify(output));
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════
//  SERVE (HTTP API server)
// ═══════════════════════════════════════════════════════════════
if (MODE === "serve") {
  requireSession();

  console.log(`
 ╔═══════════════════════════════════╗
 ║  Phantom Canvas                   ║
 ║  http://localhost:${PORT}            ║
 ╚═══════════════════════════════════╝
`);

  const browser = new GeminiBrowser(SESSION_PATH, OUTPUT_DIR, !HEADED, USE_CHROME, CDP_URL);
  const tasks = new TaskQueue();

  console.log("[INIT] Starting camoufox...");
  await browser.launch();
  console.log("[INIT] Navigating to Gemini...");
  await browser.navigateToGemini();
  console.log("[INIT] Ready!\n");

  // ── Routes ────────────────────────────────────────────────────
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      status: browser.ready ? "ready" : "starting",
      busy: browser.busy,
      tasks: { pending: tasks.pending(), completed: tasks.completed() },
    })
  );

  app.post("/generate", async (c) => {
    const body = await c.req.json<{
      prompt: string;
      reference_images?: string[];
      num_images?: number;
      timeout_secs?: number;
      callback_url?: string;
      type?: "image" | "video";
      conversation_id?: string;
    }>();

    if (!body.prompt) return c.json({ error: "prompt is required" }, 400);

    const taskId = tasks.create({
      prompt: body.prompt,
      referenceImages: body.reference_images,
      numImages: body.num_images ?? 1,
      timeoutSecs: body.timeout_secs ?? (body.type === "video" ? 300 : 180),
      callbackUrl: body.callback_url,
      type: body.type ?? "image",
      conversationId: body.conversation_id,
    });

    runTask(taskId);
    return c.json({ task_id: taskId, status: "queued" });
  });

  app.get("/task/:id", (c) => {
    const task = tasks.get(c.req.param("id"));
    if (!task) return c.json({ error: "task not found" }, 404);

    return c.json({
      task_id: task.id,
      status: task.status,
      prompt: task.input.prompt,
      conversation_id: task.conversationId,
      images: task.images?.map((img, i) => ({
        index: i,
        path: img.path,
        type: img.type,
        url: `/task/${task.id}/image/${i}`,
      })),
      error: task.error,
      elapsed_secs: task.completedAt
        ? (task.completedAt - task.createdAt) / 1000
        : (Date.now() - task.createdAt) / 1000,
    });
  });

  app.get("/task/:id/image/:index", async (c) => {
    const task = tasks.get(c.req.param("id"));
    if (!task) return c.json({ error: "task not found" }, 404);

    const img = task.images?.[parseInt(c.req.param("index"))];
    if (!img) return c.json({ error: "image not found" }, 404);

    return new Response(Bun.file(img.path), {
      headers: { "Content-Type": img.mimeType || "image/png" },
    });
  });

  app.post("/session/refresh", async (c) => {
    await browser.navigateToGemini();
    return c.json({ status: "refreshed" });
  });

  app.post("/session/save", async (c) => {
    await browser.getPage()?.context().storageState({ path: SESSION_PATH });
    return c.json({ status: "saved", path: SESSION_PATH });
  });

  app.post("/debug/eval", async (c) => {
    const { script } = await c.req.json<{ script: string }>();
    const page = browser.getPage();
    if (!page) return c.json({ error: "no page" }, 500);
    try {
      return c.json({ result: await page.evaluate(script) });
    } catch (e: any) {
      return c.json({ error: e.message });
    }
  });

  app.get("/debug/screenshot", async (c) => {
    const page = browser.getPage();
    if (!page) return c.json({ error: "no page" }, 500);
    return new Response(await page.screenshot({ type: "png" }), {
      headers: { "Content-Type": "image/png" },
    });
  });

  // ── Task runner ───────────────────────────────────────────────
  async function runTask(taskId: string) {
    const task = tasks.get(taskId)!;
    while (browser.busy) await Bun.sleep(1000);

    tasks.update(taskId, { status: "running" });

    try {
      const images = await browser.generateImages(task.input);
      const convId = browser.getConversationId();
      tasks.update(taskId, {
        status: "completed",
        images,
        conversationId: convId ?? undefined,
        completedAt: Date.now(),
      });

      if (task.input.callbackUrl) {
        fetch(task.input.callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task_id: taskId,
            status: "completed",
            images: images.map((_, i) => ({ index: i, url: `/task/${taskId}/image/${i}` })),
          }),
        }).catch(() => {});
      }

      console.log(`[DONE] Task ${taskId} — ${images.length} image(s)`);
    } catch (err: any) {
      tasks.update(taskId, { status: "failed", error: err.message, completedAt: Date.now() });
      console.error(`[FAIL] Task ${taskId}:`, err.message);
    }
  }

  const server = Bun.serve({ port: PORT, fetch: app.fetch });
  console.log(`[SERVER] Listening on http://localhost:${server.port}`);

} else {
  // ═════════════════════════════════════════════════════════════
  //  HELP (default)
  // ═════════════════════════════════════════════════════════════
  console.log(`
  Phantom Canvas — Your Gemini web app as a service

  Commands:
    phantom-canvas chrome                        Start Chrome with debugging port
    phantom-canvas login                         Login to Google (camoufox mode)
    phantom-canvas generate "prompt" [options]   One-shot generation (for agents)
    phantom-canvas serve [--port 8420]           Start HTTP API server
    phantom-canvas export <file>                  Export session for transfer
    phantom-canvas import <file>                  Import session from another machine

  Generate options:
    --ref <file>          Reference image (img2img)
    --video               Generate video instead of image
    -o, --output <file>   Output file path
    --conversation <id>   Continue previous conversation
    --timeout <secs>      Timeout (default: 180/300)
    --headed              Show browser window
    --chrome              Use your own Chrome (bypasses Google detection)
    --cdp <url>           Chrome DevTools URL (default: http://127.0.0.1:9222)

  Examples:
    phantom-canvas generate "pixel art knight, isometric, green bg"
    phantom-canvas generate "4 directions" --ref knight.png -o sheet.png
    phantom-canvas generate "walk cycle" --video --ref knight.png
    phantom-canvas serve --port 3000

  Chrome mode (recommended for Google):
    # 1. Start Chrome with debugging port:
    phantom-canvas chrome
    # 2. Login to Google in Chrome, then:
    phantom-canvas generate "your prompt" --chrome
    phantom-canvas serve --chrome

  Remote setup:
    # On local machine (has browser):
    phantom-canvas login
    phantom-canvas export ./session.json
    scp ./session.json user@remote:/tmp/session.json

    # On remote server:
    phantom-canvas import /tmp/session.json
    phantom-canvas serve
`);
}
