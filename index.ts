/**
 * Phantom Canvas — Your Gemini web app as a service
 *
 * Commands:
 *   phantom-canvas login                    — login to Google, save session
 *   phantom-canvas generate "prompt"        — one-shot generation (for agents/scripts)
 *   phantom-canvas serve                    — start HTTP API server
 */

import { Hono } from "hono";
import { mkdirSync, readFileSync, copyFileSync } from "fs";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { GeminiBrowser } from "./lib/browser";
import { TaskQueue } from "./lib/tasks";

const __dirname = dirname(fileURLToPath(import.meta.url));

function showLogo() {
  try {
    const logo = readFileSync(join(__dirname, "lib", "logo.ansi"), "utf-8");
    console.log(logo);
  } catch {}
}

// ── Config ──────────────────────────────────────────────────────
const DATA_DIR = join(homedir(), ".phantom-canvas");
const OUTPUT_DIR = join(DATA_DIR, "output");
const HEADED = process.argv.includes("--headed");
const CDP_URL = process.argv.find((_, i, a) => a[i - 1] === "--cdp") ?? "http://127.0.0.1:9222";
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? "8420");

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

const MODE = process.argv[2]; // "login", "generate", "serve", or undefined

// ── Helpers ─────────────────────────────────────────────────────
function parseArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

// ═══════════════════════════════════════════════════════════════
//  CHROME (manually launch Chrome — usually not needed)
// ═══════════════════════════════════════════════════════════════
if (MODE === "chrome") {
  const { platform: plat } = await import("os");
  const { spawn } = await import("child_process");

  const profileDir = join(homedir(), ".phantom-canvas", "chrome-profile");
  mkdirSync(profileDir, { recursive: true });

  const bins: Record<string, string> = {
    darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    win32: "chrome.exe",
    linux: "google-chrome",
  };
  const bin = bins[plat()] ?? bins.linux;

  showLogo();
  console.log("  Phantom Canvas — Chrome\n");
  console.log(`  Profile: ${profileDir}`);
  console.log("  Port:    9222\n");
  console.log("  First time? Login to Google after Chrome opens.");
  console.log("  Next time Chrome will auto-launch — no setup needed.\n");

  const child = spawn(bin, [
    "--remote-debugging-port=9222",
    `--user-data-dir=${profileDir}`,
  ], { stdio: "ignore", detached: true });
  child.unref();
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════
//  GENERATE (CLI one-shot mode for agents)
// ═══════════════════════════════════════════════════════════════
if (MODE === "generate") {


  // Parse CLI args
  const prompt = process.argv[3];
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
  const isVideo = process.argv.includes("--video");
  const outputFile = parseArg("--output") || parseArg("-o");
  const timeout = parseInt(parseArg("--timeout") ?? (isVideo ? "300" : "180"));
  const conversationId = parseArg("--conversation");

  console.error("[phantom-canvas] Starting browser...");
  const browser = new GeminiBrowser("", OUTPUT_DIR, !HEADED, CDP_URL);
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
    copyFileSync(finalPath, outPath);
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


  showLogo();
  console.log(`  Phantom Canvas — http://localhost:${PORT}\n`);

  const browser = new GeminiBrowser("", OUTPUT_DIR, !HEADED, CDP_URL);
  const tasks = new TaskQueue();

  console.log("[INIT] Starting browser...");
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

    const data = readFileSync(img.path);
    return new Response(data, {
      headers: { "Content-Type": img.mimeType || "image/png" },
    });
  });

  app.post("/session/refresh", async (c) => {
    await browser.navigateToGemini();
    return c.json({ status: "refreshed" });
  });

  app.post("/session/save", async (c) => {
    // Chrome mode persists via user-data-dir — no explicit save needed
    return c.json({ status: "ok", note: "Chrome mode uses persistent profile" });
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
    while (browser.busy) await new Promise(r => setTimeout(r, 1000));

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

  if (typeof globalThis.Bun !== "undefined") {
    const server = Bun.serve({ port: PORT, fetch: app.fetch });
    console.log(`[SERVER] Listening on http://localhost:${server.port}`);
  } else {
    const { serve } = await import("@hono/node-server");
    serve({ fetch: app.fetch, port: PORT }, (info) => {
      console.log(`[SERVER] Listening on http://localhost:${info.port}`);
    });
  }

} else {
  // ═════════════════════════════════════════════════════════════
  //  HELP (default)
  // ═════════════════════════════════════════════════════════════
  showLogo();
  console.log(`
  Phantom Canvas — Your Gemini web app as a service

  Commands:
    phantom-canvas chrome                        Manually start Chrome (usually not needed)
    phantom-canvas generate "prompt" [options]   One-shot generation (for agents)
    phantom-canvas serve [--port 8420]           Start HTTP API server

  Generate options:
    --ref <file>          Reference image (img2img)
    --video               Generate video instead of image
    -o, --output <file>   Output file path
    --conversation <id>   Continue previous conversation
    --timeout <secs>      Timeout (default: 180/300)
    --headed              Show browser window
    --cdp <url>           Chrome DevTools URL (default: http://127.0.0.1:9222)

  Examples:
    phantom-canvas generate "pixel art knight"   # just works
    phantom-canvas serve --port 3000

    # First time only: login to Google in the Chrome window that opens
    # After that, everything is automatic
`);
}
