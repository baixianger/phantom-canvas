/**
 * Phantom Canvas — Bun + camoufox + Hono
 *
 * Anti-detection browser wrapped as HTTP API for AI image generation.
 * Uses Gemini Web for free image generation, no API keys needed.
 *
 * Usage:
 *   bun start                  # headless, auto-detect session
 *   bun run dev                # headed, for debugging
 *   bun run index.ts login     # login flow — opens browser, saves session
 */

import { Hono } from "hono";
import { existsSync, mkdirSync } from "fs";
import { GeminiBrowser } from "./lib/browser";
import { TaskQueue } from "./lib/tasks";

// ── Config ──────────────────────────────────────────────────────
const PORT = parseInt(Bun.argv.find((_, i, a) => a[i - 1] === "--port") ?? "8420");
const HEADED = Bun.argv.includes("--headed");
const MODE = Bun.argv[2]; // "login" or undefined (serve)
const DATA_DIR = new URL("./data", import.meta.url).pathname;
const SESSION_PATH = `${DATA_DIR}/session.json`;
const OUTPUT_DIR = new URL("./output", import.meta.url).pathname;

mkdirSync(DATA_DIR, { recursive: true });

// ── Login mode ──────────────────────────────────────────────────
if (MODE === "login") {
  console.log(`
 ╔═══════════════════════════════════╗
 ║  Phantom Canvas — Login           ║
 ╚═══════════════════════════════════╝
`);
  console.log("[LOGIN] Starting browser...");

  const browser = new GeminiBrowser("", OUTPUT_DIR, false); // always headed
  await browser.launch();

  console.log("[LOGIN] Opening Gemini — please login in the browser...\n");
  const page = browser.getPage()!;
  await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});

  // Wait for user confirmation via CLI
  process.stdout.write("  Press ENTER after you have logged in > ");
  for await (const line of console) {
    break; // any input = confirmed
  }

  // Save session
  await page.context().storageState({ path: SESSION_PATH });
  console.log(`\n[LOGIN] Session saved to ${SESSION_PATH}`);
  console.log("[LOGIN] Start the server with: bun start\n");
  await browser.close();
  process.exit(0);
}

// ── Server mode ─────────────────────────────────────────────────
const hasSession = existsSync(SESSION_PATH);

if (!hasSession) {
  console.log(`
 ╔═══════════════════════════════════╗
 ║  Phantom Canvas                   ║
 ╚═══════════════════════════════════╝

  No session found. Please login first:

    bun run index.ts login

  This will open a browser for you to sign in to Google.
  The session will be saved and used automatically.
`);
  process.exit(1);
}

console.log(`
 ╔═══════════════════════════════════╗
 ║  Phantom Canvas                   ║
 ║  http://localhost:${PORT}            ║
 ╚═══════════════════════════════════╝
`);

const browser = new GeminiBrowser(SESSION_PATH, OUTPUT_DIR, !HEADED);
const tasks = new TaskQueue();

console.log("[INIT] Starting camoufox...");
await browser.launch();
console.log("[INIT] Navigating to Gemini...");
await browser.navigateToGemini();
console.log("[INIT] Ready!\n");

// ── Routes ──────────────────────────────────────────────────────
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
  }>();

  if (!body.prompt) return c.json({ error: "prompt is required" }, 400);

  const taskId = tasks.create({
    prompt: body.prompt,
    referenceImages: body.reference_images,
    numImages: body.num_images ?? 1,
    timeoutSecs: body.timeout_secs ?? (body.type === "video" ? 300 : 180),
    callbackUrl: body.callback_url,
    type: body.type ?? "image",
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

// Session management
app.post("/session/refresh", async (c) => {
  await browser.navigateToGemini();
  return c.json({ status: "refreshed" });
});

app.post("/session/save", async (c) => {
  await browser.getPage()?.context().storageState({ path: SESSION_PATH });
  return c.json({ status: "saved", path: SESSION_PATH });
});

// Debug
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

// ── Task runner ─────────────────────────────────────────────────
async function runTask(taskId: string) {
  const task = tasks.get(taskId)!;
  while (browser.busy) await Bun.sleep(1000);

  tasks.update(taskId, { status: "running" });

  try {
    const images = await browser.generateImages(task.input);
    tasks.update(taskId, { status: "completed", images, completedAt: Date.now() });

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

// ── Server ──────────────────────────────────────────────────────
export default { port: PORT, fetch: app.fetch };
