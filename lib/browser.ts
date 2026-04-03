/**
 * GeminiBrowser — persistent Chrome session for Gemini image generation
 *
 * Keeps the browser alive between requests to avoid SPA cold-start.
 * Handles: navigation, prompt input, image upload, image download.
 */

import type { Browser, BrowserContext, Page } from "playwright-core";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { platform } from "os";
import type { TaskInput, TaskMedia } from "./tasks";
type TaskImage = TaskMedia;

const GEMINI_URL = "https://gemini.google.com/app";
const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

export class GeminiBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  public ready = false;
  public busy = false;

  /** Expose page for debugging */
  getPage(): Page | null { return this.page; }

  constructor(
    private sessionPath: string,
    private outputDir: string,
    private headless: boolean = true,
    private cdpUrl: string = DEFAULT_CDP_URL
  ) {
    mkdirSync(outputDir, { recursive: true });
  }

  /** Launch browser */
  async launch() {
    await this._launchChrome();
  }

  /** Connect to user's Chrome via CDP, auto-launching if needed */
  private async _launchChrome() {
    const { chromium } = await import("playwright-core");
    const { spawn } = await import("child_process");
    const { homedir } = await import("os");

    // Persistent profile dir — login once, reuse forever
    const profileDir = join(homedir(), ".phantom-canvas", "chrome-profile");
    mkdirSync(profileDir, { recursive: true });

    const port = parseInt(this.cdpUrl.split(":").pop() || "9222");

    // Auto-launch Chrome if not running
    let connected = false;
    try {
      await fetch(this.cdpUrl + "/json/version");
      connected = true;
    } catch {}

    if (!connected) {
      console.log("[BROWSER] Starting Chrome...");
      const bins: Record<string, string> = {
        darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        win32: "chrome.exe",
        linux: "google-chrome",
      };
      const bin = bins[platform()] ?? bins.linux;
      const child = spawn(bin, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
      ], { stdio: "ignore", detached: true });
      child.unref();

      // Wait for Chrome to start
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          await fetch(this.cdpUrl + "/json/version");
          connected = true;
          break;
        } catch {}
      }

      if (!connected) {
        console.error("\n  Chrome failed to start. Please launch manually:\n");
        console.error(`    ${bin.includes(" ") ? `"${bin}"` : bin} --remote-debugging-port=${port} --user-data-dir="${profileDir}"\n`);
        process.exit(1);
      }
    }

    console.log(`[BROWSER] Connecting to Chrome at ${this.cdpUrl}...`);
    this.browser = await chromium.connectOverCDP(this.cdpUrl);

    // Use existing context (user's logged-in session persists in profile dir)
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

  /** Navigate to Gemini and wait for SPA to load */
  async navigateToGemini() {
    const page = this.page!;

    try {
      await page.goto(GEMINI_URL, { waitUntil: "networkidle", timeout: 90_000 });
    } catch {
      console.log("[BROWSER] networkidle timeout, continuing...");
    }

    // Wait for SPA to bootstrap
    await page.waitForTimeout(10_000);

    // Handle consent page
    // Cookie consent — support EN, DA, DE, FR, ZH, JA, etc.
    const acceptBtn = page.locator('button:has-text("Accept all"), button:has-text("Accepter alle"), button:has-text("Alle akzeptieren"), button:has-text("Tout accepter"), button:has-text("全部接受"), button:has-text("すべて同意")');
    if (await acceptBtn.count() > 0) {
      console.log("[BROWSER] Accepting cookies...");
      await acceptBtn.first().click();
      await page.waitForTimeout(3000);
    }

    // Check login status
    await this.checkAuth();

    // Wait for input area
    await page.waitForSelector(
      'div[role="textbox"], [contenteditable="true"], textarea',
      { state: "visible", timeout: 60_000 }
    );

    console.log("[BROWSER] Gemini ready");
  }

  /** Check if session is still valid — exit with re-login prompt if expired */
  private async checkAuth() {
    const page = this.page!;

    // Check 1: URL redirect to login page
    const isLoginPage = page.url().includes("accounts.google.com");

    // Check 2: Page contains "sign in" prompt from Gemini
    let hasSignInPrompt = false;
    if (!isLoginPage) {
      hasSignInPrompt = await page.evaluate(() => {
        const text = document.body?.innerText?.toLowerCase() || "";
        return (
          text.includes("sign in to connect") ||
          text.includes("are you signed in") ||
          text.includes("log in to continue") ||
          text.includes("sign in to continue")
        );
      }).catch(() => false);
    }

    if (!isLoginPage && !hasSignInPrompt) return; // all good

    if (this.headless) {
      console.error("\n[BROWSER] Session expired! Please re-login:\n");
      console.error("    phantom-canvas login\n");
      process.exit(1);
    } else {
      console.log("[BROWSER] Session expired — please login in the browser window...");
      console.log("[BROWSER] Waiting for login (up to 5 minutes)...");
      if (isLoginPage) {
        await page.waitForURL("**/gemini.google.com/**", { timeout: 300_000 });
      } else {
        // Sign-in button on Gemini page — user needs to click it
        await page.waitForFunction(
          () => !document.body?.innerText?.toLowerCase().includes("sign in to connect"),
          { timeout: 300_000 }
        );
      }
      console.log("[BROWSER] Login detected! Saving session...");
      await this.saveSession();
      await page.waitForTimeout(5000);
    }
  }

  /** Save current session (no-op — Chrome uses its own profile) */
  async saveSession() {
    // Chrome mode persists login via user-data-dir, no explicit save needed
  }

  /** Generate media (images or video) from prompt */
  async generateImages(input: TaskInput): Promise<TaskImage[]> {
    this.busy = true;
    try {
      return await this._doGenerate(input);
    } finally {
      this.busy = false;
    }
  }

  /** Get the current conversation ID from URL (e.g. /app/abc123) */
  getConversationId(): string | null {
    const url = this.page?.url() || "";
    const match = url.match(/\/app\/([a-f0-9]+)/);
    return match ? match[1] : null;
  }

  private async _doGenerate(input: TaskInput): Promise<TaskImage[]> {
    const page = this.page!;
    const results: TaskImage[] = [];
    const isVideo = input.type === "video";
    const count = isVideo ? 1 : input.numImages;

    for (let i = 0; i < count; i++) {
      console.log(`[GEN ${i + 1}/${count}] Starting (${isVideo ? "video" : "image"})...`);

      if (input.conversationId) {
        // Multi-turn: stay in same conversation
        const targetUrl = `https://gemini.google.com/app/${input.conversationId}`;
        if (!page.url().includes(input.conversationId)) {
          try {
            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
          } catch {}
          await page.waitForTimeout(5000);
        }
        console.log(`[GEN] Continuing conversation: ${input.conversationId}`);
      } else {
        // New conversation
        try {
          await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        } catch {}
        await page.waitForTimeout(8000);
      }

      // Check session is still valid before generating
      await this.checkAuth();

      // Upload reference images (only for new conversations or if explicitly provided)
      if (input.referenceImages?.length && !input.conversationId) {
        await this._uploadImages(input.referenceImages);
      }

      // Type prompt
      console.log(`[GEN ${i + 1}/${count}] Prompt: ${input.prompt.slice(0, 60)}...`);
      await this._typePrompt(input.prompt);

      // Wait for result
      if (isVideo) {
        console.log(`[GEN ${i + 1}/${count}] Waiting for video (this may take 1-2 min)...`);
        const video = await this._waitAndDownloadVideo(input.timeoutSecs, i);
        if (video) results.push(video);
      } else {
        console.log(`[GEN ${i + 1}/${count}] Waiting for image...`);
        const image = await this._waitAndDownloadImage(input.timeoutSecs, i);
        if (image) results.push(image);
      }
    }

    // Save updated session
    await this.saveSession();

    return results;
  }

  /** Type prompt into the Gemini input area */
  private async _typePrompt(prompt: string) {
    const page = this.page!;

    // Use JS to find and fill the input (most reliable)
    const selector = await page.evaluate((text: string) => {
      const selectors = [
        'div[role="textbox"]',
        '[contenteditable="true"]:not([aria-hidden="true"])',
        "textarea",
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement | null;
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

  /** Upload reference images via the file upload button */
  private async _uploadImages(images: string[]) {
    const page = this.page!;
    const filePaths = images.filter((img) => !img.startsWith("data:") && existsSync(img));
    if (filePaths.length === 0) {
      console.log("[GEN] No valid file paths to upload");
      return;
    }

    // Step 1: Click the attach/upload menu button
    // Use specific Gemini selectors — avoid matching conversation action menus
    // Upload button: "Åbn menuen til filupload" (DA), "Open file upload menu" (EN)
    // Use data-test-id as stable anchor, exclude conversation action menus
    const uploadMenuBtn = page.locator(
      [
        'button[aria-label*="file upload"]',
        'button[aria-label*="filupload"]',
        'button[aria-label*="Attach"]',
        'button[aria-label*="附件"]',
        'button[aria-label*="Upload"]',
      ].join(", ")
    );

    if ((await uploadMenuBtn.count()) === 0) {
      console.log("[GEN] Upload menu button not found, skipping");
      return;
    }

    await uploadMenuBtn.first().click();
    await page.waitForTimeout(1500);

    // Step 2: Click "Upload files" / "Upload filer" in the dropdown menu
    const uploadFilesItem = page.locator(
      [
        'button[aria-label*="Upload fil"]',  // DA + EN
        'button[aria-label*="Upload file"]', // EN
        'button:has-text("Upload")',
        'button:has-text("上传")',
      ].join(", ")
    ).first();

    if (!(await uploadFilesItem.isVisible())) {
      console.log("[GEN] Upload files menu item not visible, skipping");
      return;
    }

    // Step 3: Set up file chooser BEFORE clicking
    const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
    await uploadFilesItem.click();

    try {
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(filePaths);
      console.log(`[GEN] Uploaded ${filePaths.length} file(s): ${filePaths.map(f => f.split('/').pop()).join(', ')}`);
      // Wait for upload to process and thumbnail to appear
      await page.waitForTimeout(5000);
    } catch (e: any) {
      console.error(`[GEN] File upload failed: ${e.message}`);
    }
  }

  /** Count current generated images on the page (excluding avatars/previews) */
  private async _countGeneratedImages(): Promise<number> {
    return this.page!.evaluate(() => {
      let count = 0;
      for (const img of document.querySelectorAll("img")) {
        if (img.naturalWidth <= 100 || img.naturalHeight <= 100) continue;
        const src = img.src || "";
        const alt = (img.alt || "").toLowerCase();
        if (src.includes("googleusercontent.com/a/") || src.includes("favicon")) continue;
        if (alt.includes("upload") || alt.includes("preview") || alt.includes("forhåndsvisning") || alt.includes("上传") || alt.includes("プレビュー")) continue;
        count++;
      }
      return count;
    });
  }

  /** Wait for generated image to appear and download it */
  private async _waitAndDownloadImage(
    timeoutSecs: number,
    index: number
  ): Promise<TaskImage | null> {
    const page = this.page!;

    // Count existing images BEFORE generation (important for multi-turn)
    const existingCount = await this._countGeneratedImages();
    console.log(`[GEN] Existing images on page: ${existingCount}`);

    // Wait for a NEW image to appear (count must increase)
    try {
      await page.waitForFunction(
        (prevCount: number) => {
          let count = 0;
          for (const img of document.querySelectorAll("img")) {
            if (img.naturalWidth <= 100 || img.naturalHeight <= 100) continue;
            const src = img.src || "";
            const alt = (img.alt || "").toLowerCase();
            if (src.includes("googleusercontent.com/a/") || src.includes("favicon")) continue;
            if (alt.includes("upload") || alt.includes("preview") || alt.includes("forhåndsvisning")) continue;
            count++;
          }
          return count > prevCount;
        },
        existingCount,
        { timeout: timeoutSecs * 1000 }
      );
    } catch {
      const debugPath = join(this.outputDir, `debug_${Date.now()}.png`);
      await page.screenshot({ path: debugPath, fullPage: true });
      console.error(`[GEN] Timeout. Debug: ${debugPath}`);
      return null;
    }

    // Let it fully render
    await page.waitForTimeout(4000);

    const ts = Date.now();
    const outPath = join(this.outputDir, `sprite_${ts}_${index}.png`);

    // Strategy 1: Use the download button (gets full-res image)
    const downloadBtn = page.locator(
      'button[aria-label*="ownload"], button[aria-label*="hent"], button[aria-label*="下载"]'
    );

    if ((await downloadBtn.count()) > 0) {
      try {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 15_000 }),
          downloadBtn.last().click(), // last = newest image's download button
        ]);
        await download.saveAs(outPath);
        console.log(`[GEN] Downloaded full-res: ${outPath}`);
        return { path: outPath, type: "image" as const, mimeType: "image/png" };
      } catch {
        console.log("[GEN] Download button failed, falling back to screenshot");
      }
    }

    // Strategy 2: Screenshot the LAST generated image (newest in multi-turn)
    const imgEl = await page.evaluateHandle(() => {
      let last: HTMLImageElement | null = null;
      for (const img of document.querySelectorAll("img")) {
        if (img.naturalWidth <= 100 || img.naturalHeight <= 100) continue;
        const src = img.src || "";
        const alt = (img.alt || "").toLowerCase();
        if (src.includes("googleusercontent.com/a/") || src.includes("favicon")) continue;
        if (alt.includes("upload") || alt.includes("forhåndsvisning") || alt.includes("preview")) continue;
        last = img; // keep iterating — last one is newest
      }
      return last;
    });

    if (imgEl) {
      await (imgEl as any).screenshot({ path: outPath });
      console.log(`[GEN] Screenshot: ${outPath}`);
      return { path: outPath, type: "image" as const, mimeType: "image/png" };
    }

    // Strategy 3: Full page screenshot as last resort
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`[GEN] Full page screenshot: ${outPath}`);
    return { path: outPath, type: "image" as const, mimeType: "image/png" };
  }

  /** Wait for video to appear and download it */
  private async _waitAndDownloadVideo(
    timeoutSecs: number,
    index: number
  ): Promise<TaskImage | null> {
    const page = this.page!;

    // Videos take 1-2 minutes — poll manually for <video> element
    console.log(`[GEN] Polling for video element (timeout: ${timeoutSecs}s)...`);
    const deadline = Date.now() + timeoutSecs * 1000;
    let videoFound = false;

    while (Date.now() < deadline) {
      await page.waitForTimeout(5000);

      const check = await page.evaluate(() => {
        const videos = document.querySelectorAll("video");
        for (const v of videos) {
          const src = v.src || v.querySelector("source")?.src || "";
          if (src && src.startsWith("http")) return true;
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

    // Let video fully load
    await page.waitForTimeout(3000);

    // Get the video URL
    const videoUrl = await page.evaluate(() => {
      const video = document.querySelector("video");
      return video?.src || video?.querySelector("source")?.src || null;
    });

    if (!videoUrl) {
      console.error("[GEN] Video element found but no URL");
      return null;
    }

    console.log(`[GEN] Video URL: ${videoUrl.slice(0, 80)}...`);

    // Download the video via the browser context (carries cookies)
    const ts = Date.now();
    const outPath = join(this.outputDir, `video_${ts}_${index}.mp4`);

    try {
      // Use page.evaluate to fetch the video as blob and convert to base64
      const b64Data = await page.evaluate(async (url: string) => {
        const resp = await fetch(url);
        const blob = await resp.blob();
        return new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
      }, videoUrl);

      // Strip data URL prefix and write binary
      const base64 = b64Data.split(",")[1];
      const buffer = Buffer.from(base64, "base64");
      await Bun.write(outPath, buffer);
      console.log(`[GEN] Video saved: ${outPath} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);

      return { path: outPath, type: "video" as const, mimeType: "video/mp4" };
    } catch (e: any) {
      console.error(`[GEN] Video download failed: ${e.message}`);

      // Fallback: try download button
      const downloadBtn = page.locator(
        'button[aria-label*="ownload"], button[aria-label*="hent"], button[aria-label*="下载"]'
      );
      if ((await downloadBtn.count()) > 0) {
        try {
          const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 15_000 }),
            downloadBtn.first().click(),
          ]);
          await download.saveAs(outPath);
          console.log(`[GEN] Video downloaded via button: ${outPath}`);
          return { path: outPath, type: "video" as const, mimeType: "video/mp4" };
        } catch {}
      }

      return null;
    }
  }

  async close() {
    await this.page?.close().catch(() => {});
    // CDP-connected browsers support disconnect() to leave Chrome running
    if (this.browser && "disconnect" in this.browser) {
      (this.browser as any).disconnect();
    }
  }
}
