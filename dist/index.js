import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// index.ts
import { Hono } from "hono";
import { mkdirSync as mkdirSync2, readFileSync, copyFileSync } from "fs";
import { homedir } from "os";
import { join as join2, resolve, dirname } from "path";
import { fileURLToPath } from "url";

// lib/browser.ts
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { platform } from "os";
var GEMINI_URL = "https://gemini.google.com/app";
var DEFAULT_CDP_URL = "http://127.0.0.1:9222";

class GeminiBrowser {
  sessionPath;
  outputDir;
  headless;
  cdpUrl;
  browser = null;
  context = null;
  page = null;
  ready = false;
  busy = false;
  getPage() {
    return this.page;
  }
  constructor(sessionPath, outputDir, headless = true, cdpUrl = DEFAULT_CDP_URL) {
    this.sessionPath = sessionPath;
    this.outputDir = outputDir;
    this.headless = headless;
    this.cdpUrl = cdpUrl;
    mkdirSync(outputDir, { recursive: true });
  }
  async launch() {
    await this._launchChrome();
  }
  async _launchChrome() {
    const { chromium } = await import("playwright-core");
    const { spawn } = await import("child_process");
    const { homedir } = await import("os");
    const profileDir = join(homedir(), ".phantom-canvas", "chrome-profile");
    mkdirSync(profileDir, { recursive: true });
    const port = parseInt(this.cdpUrl.split(":").pop() || "9222");
    let connected = false;
    try {
      await fetch(this.cdpUrl + "/json/version");
      connected = true;
    } catch {}
    if (!connected) {
      console.log("[BROWSER] Starting Chrome...");
      const bins = {
        darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        win32: "chrome.exe",
        linux: "google-chrome"
      };
      const bin = bins[platform()] ?? bins.linux;
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`
      ];
      if (this.headless)
        args.push("--headless=new");
      const child = spawn(bin, args, { stdio: "ignore", detached: true });
      child.unref();
      for (let i = 0;i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          await fetch(this.cdpUrl + "/json/version");
          connected = true;
          break;
        } catch {}
      }
      if (!connected) {
        console.error(`
  Chrome failed to start. Please launch manually:
`);
        console.error(`    ${bin.includes(" ") ? `"${bin}"` : bin} --remote-debugging-port=${port} --user-data-dir="${profileDir}"
`);
        process.exit(1);
      }
    }
    console.log(`[BROWSER] Connecting to Chrome at ${this.cdpUrl}...`);
    this.browser = await chromium.connectOverCDP(this.cdpUrl);
    const contexts = this.browser.contexts();
    if (contexts.length > 0) {
      this.context = contexts[0];
      console.log("[BROWSER] Using existing Chrome context");
    } else {
      this.context = await this.browser.newContext();
    }
    this.page = await this.context.newPage();
    this.ready = true;
  }
  async navigateToGemini() {
    const page = this.page;
    try {
      await page.goto(GEMINI_URL, { waitUntil: "networkidle", timeout: 90000 });
    } catch {
      console.log("[BROWSER] networkidle timeout, continuing...");
    }
    await page.waitForTimeout(1e4);
    const acceptBtn = page.locator('button:has-text("Accept all"), button:has-text("Accepter alle"), button:has-text("Alle akzeptieren"), button:has-text("Tout accepter"), button:has-text("全部接受"), button:has-text("すべて同意")');
    if (await acceptBtn.count() > 0) {
      console.log("[BROWSER] Accepting cookies...");
      await acceptBtn.first().click();
      await page.waitForTimeout(3000);
    }
    await this.checkAuth();
    await page.waitForSelector('div[role="textbox"], [contenteditable="true"], textarea', { state: "visible", timeout: 60000 });
    console.log("[BROWSER] Gemini ready");
  }
  async checkAuth() {
    const page = this.page;
    const isLoginPage = page.url().includes("accounts.google.com");
    let hasSignInPrompt = false;
    if (!isLoginPage) {
      hasSignInPrompt = await page.evaluate(() => {
        const text = document.body?.innerText?.toLowerCase() || "";
        return text.includes("sign in to connect") || text.includes("are you signed in") || text.includes("log in to continue") || text.includes("sign in to continue");
      }).catch(() => false);
    }
    if (!isLoginPage && !hasSignInPrompt)
      return;
    if (this.headless) {
      console.error(`
[BROWSER] Session expired! Please re-login:
`);
      console.error(`    phantom-canvas login
`);
      process.exit(1);
    } else {
      console.log("[BROWSER] Session expired — please login in the browser window...");
      console.log("[BROWSER] Waiting for login (up to 5 minutes)...");
      if (isLoginPage) {
        await page.waitForURL("**/gemini.google.com/**", { timeout: 300000 });
      } else {
        await page.waitForFunction(() => !document.body?.innerText?.toLowerCase().includes("sign in to connect"), { timeout: 300000 });
      }
      console.log("[BROWSER] Login detected! Saving session...");
      await this.saveSession();
      await page.waitForTimeout(5000);
    }
  }
  async saveSession() {}
  async generateImages(input) {
    this.busy = true;
    try {
      return await this._doGenerate(input);
    } finally {
      this.busy = false;
    }
  }
  getConversationId() {
    const url = this.page?.url() || "";
    const match = url.match(/\/app\/([a-f0-9]+)/);
    return match ? match[1] : null;
  }
  async _doGenerate(input) {
    const page = this.page;
    const results = [];
    const isVideo = input.type === "video";
    const count = isVideo ? 1 : input.numImages;
    for (let i = 0;i < count; i++) {
      console.log(`[GEN ${i + 1}/${count}] Starting (${isVideo ? "video" : "image"})...`);
      if (input.conversationId) {
        const targetUrl = `https://gemini.google.com/app/${input.conversationId}`;
        if (!page.url().includes(input.conversationId)) {
          try {
            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          } catch {}
          await page.waitForTimeout(5000);
        }
        console.log(`[GEN] Continuing conversation: ${input.conversationId}`);
      } else {
        try {
          await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        } catch {}
        await page.waitForTimeout(8000);
      }
      await this.checkAuth();
      if (input.referenceImages?.length && !input.conversationId) {
        await this._uploadImages(input.referenceImages);
      }
      console.log(`[GEN ${i + 1}/${count}] Prompt: ${input.prompt.slice(0, 60)}...`);
      await this._typePrompt(input.prompt);
      if (isVideo) {
        console.log(`[GEN ${i + 1}/${count}] Waiting for video (this may take 1-2 min)...`);
        const video = await this._waitAndDownloadVideo(input.timeoutSecs, i);
        if (video)
          results.push(video);
      } else {
        console.log(`[GEN ${i + 1}/${count}] Waiting for image...`);
        const image = await this._waitAndDownloadImage(input.timeoutSecs, i);
        if (image)
          results.push(image);
      }
    }
    await this.saveSession();
    return results;
  }
  async _typePrompt(prompt) {
    const page = this.page;
    const selector = await page.evaluate((text) => {
      const selectors = [
        'div[role="textbox"]',
        '[contenteditable="true"]:not([aria-hidden="true"])',
        "textarea"
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          el.focus();
          if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
            el.value = text;
          } else {
            el.textContent = text;
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return sel;
        }
      }
      return null;
    }, prompt);
    console.log(`[GEN] Used selector: ${selector}`);
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
  }
  async _uploadImages(images) {
    const page = this.page;
    const filePaths = images.filter((img) => !img.startsWith("data:") && existsSync(img));
    if (filePaths.length === 0) {
      console.log("[GEN] No valid file paths to upload");
      return;
    }
    const uploadMenuBtn = page.locator([
      'button[aria-label*="file upload"]',
      'button[aria-label*="filupload"]',
      'button[aria-label*="Attach"]',
      'button[aria-label*="附件"]',
      'button[aria-label*="Upload"]'
    ].join(", "));
    if (await uploadMenuBtn.count() === 0) {
      console.log("[GEN] Upload menu button not found, skipping");
      return;
    }
    await uploadMenuBtn.first().click();
    await page.waitForTimeout(1500);
    const uploadFilesItem = page.locator([
      'button[aria-label*="Upload fil"]',
      'button[aria-label*="Upload file"]',
      'button:has-text("Upload")',
      'button:has-text("上传")'
    ].join(", ")).first();
    if (!await uploadFilesItem.isVisible()) {
      console.log("[GEN] Upload files menu item not visible, skipping");
      return;
    }
    const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 1e4 });
    await uploadFilesItem.click();
    try {
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(filePaths);
      console.log(`[GEN] Uploaded ${filePaths.length} file(s): ${filePaths.map((f) => f.split("/").pop()).join(", ")}`);
      await page.waitForTimeout(5000);
    } catch (e) {
      console.error(`[GEN] File upload failed: ${e.message}`);
    }
  }
  async _countGeneratedImages() {
    return this.page.evaluate(() => {
      let count = 0;
      for (const img of document.querySelectorAll("img")) {
        if (img.naturalWidth <= 100 || img.naturalHeight <= 100)
          continue;
        const src = img.src || "";
        const alt = (img.alt || "").toLowerCase();
        if (src.includes("googleusercontent.com/a/") || src.includes("favicon"))
          continue;
        if (alt.includes("upload") || alt.includes("preview") || alt.includes("forhåndsvisning") || alt.includes("上传") || alt.includes("プレビュー"))
          continue;
        count++;
      }
      return count;
    });
  }
  async _waitAndDownloadImage(timeoutSecs, index) {
    const page = this.page;
    const existingCount = await this._countGeneratedImages();
    console.log(`[GEN] Existing images on page: ${existingCount}`);
    try {
      await page.waitForFunction((prevCount) => {
        let count = 0;
        for (const img of document.querySelectorAll("img")) {
          if (img.naturalWidth <= 100 || img.naturalHeight <= 100)
            continue;
          const src = img.src || "";
          const alt = (img.alt || "").toLowerCase();
          if (src.includes("googleusercontent.com/a/") || src.includes("favicon"))
            continue;
          if (alt.includes("upload") || alt.includes("preview") || alt.includes("forhåndsvisning"))
            continue;
          count++;
        }
        return count > prevCount;
      }, existingCount, { timeout: timeoutSecs * 1000 });
    } catch {
      const debugPath = join(this.outputDir, `debug_${Date.now()}.png`);
      await page.screenshot({ path: debugPath, fullPage: true });
      console.error(`[GEN] Timeout. Debug: ${debugPath}`);
      return null;
    }
    await page.waitForTimeout(4000);
    const ts = Date.now();
    const outPath = join(this.outputDir, `sprite_${ts}_${index}.png`);
    const lastImg = await page.evaluateHandle(() => {
      let last = null;
      for (const img of document.querySelectorAll("img")) {
        if (img.naturalWidth <= 100 || img.naturalHeight <= 100)
          continue;
        const src = img.src || "";
        const alt = (img.alt || "").toLowerCase();
        if (src.includes("googleusercontent.com/a/") || src.includes("favicon"))
          continue;
        if (alt.includes("upload") || alt.includes("preview") || alt.includes("forhåndsvisning"))
          continue;
        last = img;
      }
      return last;
    });
    if (lastImg) {
      try {
        await lastImg.hover();
      } catch {}
      await page.waitForTimeout(1000);
    }
    const downloadBtn = page.locator('button[aria-label*="ownload"], button[aria-label*="hent"], button[aria-label*="下载"]');
    if (await downloadBtn.count() > 0) {
      try {
        const btn = downloadBtn.last();
        await btn.scrollIntoViewIfNeeded();
        await btn.hover();
        await page.waitForTimeout(500);
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 15000 }),
          btn.click({ force: true })
        ]);
        await download.saveAs(outPath);
        console.log(`[GEN] Downloaded full-res: ${outPath}`);
        return { path: outPath, type: "image", mimeType: "image/png" };
      } catch {
        console.log("[GEN] Download button failed, falling back to screenshot");
      }
    }
    const imgEl = await page.evaluateHandle(() => {
      let last = null;
      for (const img of document.querySelectorAll("img")) {
        if (img.naturalWidth <= 100 || img.naturalHeight <= 100)
          continue;
        const src = img.src || "";
        const alt = (img.alt || "").toLowerCase();
        if (src.includes("googleusercontent.com/a/") || src.includes("favicon"))
          continue;
        if (alt.includes("upload") || alt.includes("forhåndsvisning") || alt.includes("preview"))
          continue;
        last = img;
      }
      return last;
    });
    if (imgEl) {
      await imgEl.screenshot({ path: outPath });
      console.log(`[GEN] Screenshot: ${outPath}`);
      return { path: outPath, type: "image", mimeType: "image/png" };
    }
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`[GEN] Full page screenshot: ${outPath}`);
    return { path: outPath, type: "image", mimeType: "image/png" };
  }
  async _waitAndDownloadVideo(timeoutSecs, index) {
    const page = this.page;
    console.log(`[GEN] Polling for video element (timeout: ${timeoutSecs}s)...`);
    const deadline = Date.now() + timeoutSecs * 1000;
    let videoFound = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(5000);
      const check = await page.evaluate(() => {
        const videos = document.querySelectorAll("video");
        for (const v of videos) {
          const src = v.src || v.querySelector("source")?.src || "";
          if (src && src.startsWith("http"))
            return true;
        }
        return false;
      });
      if (check) {
        videoFound = true;
        console.log("[GEN] Video element detected!");
        break;
      }
      const elapsed = Math.round((Date.now() - (deadline - timeoutSecs * 1000)) / 1000);
      if (elapsed % 30 === 0) {
        console.log(`[GEN] Still waiting for video... ${elapsed}s`);
      }
    }
    if (!videoFound) {
      const debugPath = join(this.outputDir, `debug_video_${Date.now()}.png`);
      await page.screenshot({ path: debugPath, fullPage: true });
      console.error(`[GEN] Video timeout after ${timeoutSecs}s. Debug: ${debugPath}`);
      return null;
    }
    await page.waitForTimeout(3000);
    const videoUrl = await page.evaluate(() => {
      const video = document.querySelector("video");
      return video?.src || video?.querySelector("source")?.src || null;
    });
    if (!videoUrl) {
      console.error("[GEN] Video element found but no URL");
      return null;
    }
    console.log(`[GEN] Video URL: ${videoUrl.slice(0, 80)}...`);
    const ts = Date.now();
    const outPath = join(this.outputDir, `video_${ts}_${index}.mp4`);
    try {
      const b64Data = await page.evaluate(async (url) => {
        const resp = await fetch(url);
        const blob = await resp.blob();
        return new Promise((resolve) => {
          const reader = new FileReader;
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
      }, videoUrl);
      const base64 = b64Data.split(",")[1];
      const buffer = Buffer.from(base64, "base64");
      const { writeFileSync } = await import("fs");
      writeFileSync(outPath, buffer);
      console.log(`[GEN] Video saved: ${outPath} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
      return { path: outPath, type: "video", mimeType: "video/mp4" };
    } catch (e) {
      console.error(`[GEN] Video download failed: ${e.message}`);
      const downloadBtn = page.locator('button[aria-label*="ownload"], button[aria-label*="hent"], button[aria-label*="下载"]');
      if (await downloadBtn.count() > 0) {
        try {
          const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 15000 }),
            downloadBtn.first().click()
          ]);
          await download.saveAs(outPath);
          console.log(`[GEN] Video downloaded via button: ${outPath}`);
          return { path: outPath, type: "video", mimeType: "video/mp4" };
        } catch {}
      }
      return null;
    }
  }
  async close() {
    await this.page?.close().catch(() => {});
    if (this.browser && "disconnect" in this.browser) {
      this.browser.disconnect();
    }
  }
}

// lib/tasks.ts
class TaskQueue {
  tasks = new Map;
  create(input) {
    const id = crypto.randomUUID().slice(0, 8);
    this.tasks.set(id, {
      id,
      status: "queued",
      input,
      createdAt: Date.now()
    });
    return id;
  }
  get(id) {
    return this.tasks.get(id);
  }
  update(id, patch) {
    const task = this.tasks.get(id);
    if (task)
      Object.assign(task, patch);
  }
  pending() {
    return [...this.tasks.values()].filter((t) => t.status === "queued" || t.status === "running").length;
  }
  completed() {
    return [...this.tasks.values()].filter((t) => t.status === "completed").length;
  }
}

// index.ts
var __dirname2 = dirname(fileURLToPath(import.meta.url));
function showLogo() {
  for (const base of [__dirname2, join2(__dirname2, "..")]) {
    try {
      console.log(readFileSync(join2(base, "lib", "logo.ansi"), "utf-8"));
      return;
    } catch {}
  }
}
var DATA_DIR = join2(homedir(), ".phantom-canvas");
var OUTPUT_DIR = join2(DATA_DIR, "output");
var HEADED = process.argv.includes("--headed");
var CDP_URL = process.argv.find((_, i, a) => a[i - 1] === "--cdp") ?? "http://127.0.0.1:9222";
var PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? "8420");
mkdirSync2(DATA_DIR, { recursive: true });
mkdirSync2(OUTPUT_DIR, { recursive: true });
var MODE = process.argv[2];
function parseArg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
if (MODE === "chrome") {
  const { platform: plat } = await import("os");
  const { spawn } = await import("child_process");
  const profileDir = join2(homedir(), ".phantom-canvas", "chrome-profile");
  mkdirSync2(profileDir, { recursive: true });
  const bins = {
    darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    win32: "chrome.exe",
    linux: "google-chrome"
  };
  const bin = bins[plat()] ?? bins.linux;
  showLogo();
  console.log(`  Phantom Canvas — Chrome
`);
  console.log(`  Profile: ${profileDir}`);
  console.log(`  Port:    9222
`);
  console.log("  First time? Login to Google after Chrome opens.");
  console.log(`  Next time Chrome will auto-launch — no setup needed.
`);
  const child = spawn(bin, [
    "--remote-debugging-port=9222",
    `--user-data-dir=${profileDir}`
  ], { stdio: "ignore", detached: true });
  child.unref();
  process.exit(0);
}
if (MODE === "generate") {
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
    conversationId
  });
  const convId = browser.getConversationId();
  await browser.close();
  if (results.length === 0) {
    console.error("[phantom-canvas] Generation failed — no output produced.");
    process.exit(1);
  }
  let finalPath = results[0].path;
  if (outputFile) {
    const outPath = resolve(outputFile);
    copyFileSync(finalPath, outPath);
    finalPath = outPath;
  }
  const output = {
    status: "completed",
    path: finalPath,
    type: results[0].type,
    conversation_id: convId
  };
  console.log(JSON.stringify(output));
  process.exit(0);
}
if (MODE === "serve") {
  showLogo();
  console.log(`  Phantom Canvas — http://localhost:${PORT}
`);
  const browser = new GeminiBrowser("", OUTPUT_DIR, !HEADED, CDP_URL);
  const tasks = new TaskQueue;
  console.log("[INIT] Starting browser...");
  await browser.launch();
  console.log("[INIT] Navigating to Gemini...");
  await browser.navigateToGemini();
  console.log(`[INIT] Ready!
`);
  const app = new Hono;
  app.get("/health", (c) => c.json({
    status: browser.ready ? "ready" : "starting",
    busy: browser.busy,
    tasks: { pending: tasks.pending(), completed: tasks.completed() }
  }));
  app.post("/generate", async (c) => {
    const body = await c.req.json();
    if (!body.prompt)
      return c.json({ error: "prompt is required" }, 400);
    const taskId = tasks.create({
      prompt: body.prompt,
      referenceImages: body.reference_images,
      numImages: body.num_images ?? 1,
      timeoutSecs: body.timeout_secs ?? (body.type === "video" ? 300 : 180),
      callbackUrl: body.callback_url,
      type: body.type ?? "image",
      conversationId: body.conversation_id
    });
    runTask(taskId);
    return c.json({ task_id: taskId, status: "queued" });
  });
  app.get("/task/:id", (c) => {
    const task = tasks.get(c.req.param("id"));
    if (!task)
      return c.json({ error: "task not found" }, 404);
    return c.json({
      task_id: task.id,
      status: task.status,
      prompt: task.input.prompt,
      conversation_id: task.conversationId,
      images: task.images?.map((img, i) => ({
        index: i,
        path: img.path,
        type: img.type,
        url: `/task/${task.id}/image/${i}`
      })),
      error: task.error,
      elapsed_secs: task.completedAt ? (task.completedAt - task.createdAt) / 1000 : (Date.now() - task.createdAt) / 1000
    });
  });
  app.get("/task/:id/image/:index", async (c) => {
    const task = tasks.get(c.req.param("id"));
    if (!task)
      return c.json({ error: "task not found" }, 404);
    const img = task.images?.[parseInt(c.req.param("index"))];
    if (!img)
      return c.json({ error: "image not found" }, 404);
    const data = readFileSync(img.path);
    return new Response(data, {
      headers: { "Content-Type": img.mimeType || "image/png" }
    });
  });
  app.post("/session/refresh", async (c) => {
    await browser.navigateToGemini();
    return c.json({ status: "refreshed" });
  });
  app.post("/session/save", async (c) => {
    return c.json({ status: "ok", note: "Chrome mode uses persistent profile" });
  });
  app.post("/debug/eval", async (c) => {
    const { script } = await c.req.json();
    const page = browser.getPage();
    if (!page)
      return c.json({ error: "no page" }, 500);
    try {
      return c.json({ result: await page.evaluate(script) });
    } catch (e) {
      return c.json({ error: e.message });
    }
  });
  app.get("/debug/screenshot", async (c) => {
    const page = browser.getPage();
    if (!page)
      return c.json({ error: "no page" }, 500);
    return new Response(await page.screenshot({ type: "png" }), {
      headers: { "Content-Type": "image/png" }
    });
  });
  async function runTask(taskId) {
    const task = tasks.get(taskId);
    while (browser.busy)
      await new Promise((r) => setTimeout(r, 1000));
    tasks.update(taskId, { status: "running" });
    try {
      const images = await browser.generateImages(task.input);
      const convId = browser.getConversationId();
      tasks.update(taskId, {
        status: "completed",
        images,
        conversationId: convId ?? undefined,
        completedAt: Date.now()
      });
      if (task.input.callbackUrl) {
        fetch(task.input.callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task_id: taskId,
            status: "completed",
            images: images.map((_, i) => ({ index: i, url: `/task/${taskId}/image/${i}` }))
          })
        }).catch(() => {});
      }
      console.log(`[DONE] Task ${taskId} — ${images.length} image(s)`);
    } catch (err) {
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
