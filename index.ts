/**
 * Phantom Canvas — Bun + camoufox + Hono
 *
 * Anti-detection browser wrapped as HTTP API for AI image generation.
 * Uses Gemini Web for free image generation, no API keys needed.
 *
 * Start:  bun run index.ts [--port 8420] [--headed]
 */

import { Hono } from "hono";
import { GeminiBrowser } from "./lib/browser";
import { TaskQueue } from "./lib/tasks";

// ── Config ──────────────────────────────────────────────────────
const PORT = parseInt(Bun.env.PORT || Bun.argv.find((_, i, a) => a[i - 1] === "--port") || "8420");
const HEADED = Bun.argv.includes("--headed") || Bun.env.HEADED === "true";
const SESSION_PATH = Bun.env.GEMINI_SESSION || Bun.argv.find((_, i, a) => a[i - 1] === "--session") || "";
const OUTPUT_DIR = Bun.env.OUTPUT_DIR || new URL("./output", import.meta.url).pathname;

// ── Init ────────────────────────────────────────────────────────
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

  // Fire and forget
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

// Login flow: open Gemini, wait for user to login
app.post("/session/login", async (c) => {
  const page = browser.getPage();
  if (!page) return c.json({ error: "no page" }, 500);

  await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});

  return c.json({
    status: "waiting_for_login",
    message: "Please login in the browser window. After login, call POST /session/save to save.",
  });
});

// Save current browser session to the configured path (or a custom path)
app.post("/session/save", async (c) => {
  const body = await c.req.json<{ path?: string }>().catch(() => ({}));
  const savePath = body.path || SESSION_PATH;

  if (!savePath) return c.json({ error: "no session path configured — pass {path} or start with --session" }, 400);

  const page = browser.getPage();
  if (!page) return c.json({ error: "no page" }, 500);

  await page.context().storageState({ path: savePath });

  return c.json({ status: "saved", path: savePath, url: page.url() });
});

// Debug: evaluate JS in the browser page
app.post("/debug/eval", async (c) => {
  const { script } = await c.req.json<{ script: string }>();
  const page = browser.getPage();
  if (!page) return c.json({ error: "no page" }, 500);
  try {
    const result = await page.evaluate(script);
    return c.json({ result });
  } catch (e: any) {
    return c.json({ error: e.message });
  }
});

// Debug: screenshot
app.get("/debug/screenshot", async (c) => {
  const page = browser.getPage();
  if (!page) return c.json({ error: "no page" }, 500);
  const buf = await page.screenshot({ type: "png" });
  return new Response(buf, { headers: { "Content-Type": "image/png" } });
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