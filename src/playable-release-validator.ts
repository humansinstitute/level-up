import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { RankedProposal } from "./loop";

export interface PlayableReleaseEvidence {
  renderedPixels: number;
  changedPixels: number;
  visibleTextChanged: boolean;
  visibleControls: number;
  startupHooksPresent: boolean | null;
  materialChanged?: boolean;
  featureModuleRequested?: boolean;
  featureModuleExecuted?: boolean;
}

export async function validateFeatureModuleContract(browser: Browser, releaseDirectory: string): Promise<{featureModuleRequested:true;featureModuleExecuted:true}> {
  const page = await browser.newPage();
  const root=resolve(releaseDirectory);const server=Bun.serve({port:0,fetch(request){const pathname=decodeURIComponent(new URL(request.url).pathname);const target=resolve(root,`.${pathname}`);const rel=relative(root,target);if(rel.startsWith("..")||!existsSync(target)||statSync(target).isDirectory())return new Response("Not found",{status:404});return new Response(Bun.file(target));}});
  let requested = false;
  page.on("request", request => { if (/\/assets\/main\.js(?:\?|$)/.test(request.url())) requested = true; });
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  try {
    await page.goto(`${server.url}index.html`,{waitUntil:"load"});
    await page.waitForTimeout(80);
    const executed=await page.evaluate(()=>document.documentElement.dataset.levelupPackage!==undefined);
    if(errors.length)throw new PlayableReleaseValidationError(`Compiled feature module failed at runtime: ${errors[0]}`);
    if(!requested)throw new PlayableReleaseValidationError("Compiled feature module was not requested from the immutable release.");
    if(!executed)throw new PlayableReleaseValidationError("Compiled feature module did not execute from the immutable release.");
    return{featureModuleRequested:true,featureModuleExecuted:true};
  } finally { server.stop(true);await page.close().catch(()=>undefined); }
}

export class PlayableReleaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayableReleaseValidationError";
  }
}

const STOP_WORDS = new Set([
  "about", "after", "again", "with", "without", "that", "this", "they", "them", "then", "into",
  "from", "have", "make", "made", "game", "play", "player", "players", "during", "normal", "actual",
  "change", "visible", "small", "scope", "proposal", "round", "level", "using", "existing",
]);

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
}

function proposalKeywords(proposal: RankedProposal): string[] {
  return [...new Set([
    ...words(proposal.title),
    ...words(proposal.playerChange),
    ...words(proposal.implementationScope),
    ...proposal.acceptanceCriteria.flatMap(words),
  ])].slice(0, 16);
}

function scriptBody(html: string): string {
  return [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1] ?? "").join("\n");
}

function expectedStartupHooks(html: string): boolean {
  const script = scriptBody(html);
  return /\bfunction\s+(?:start|draw)\b/.test(script) || /\b(?:start|draw)\s*=/.test(script);
}

async function htmlPage(browser: Browser, html: string, name: string): Promise<{ page: Page; root: string; errors: string[] }> {
  const root = join(tmpdir(), `levelup-playable-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const file = join(root, `${name}.html`);
  writeFileSync(file, html);
  const page = await browser.newPage({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`file://${file}`, { waitUntil: "load" });
  await page.waitForTimeout(80);
  return { page, root, errors };
}

async function cleanupPage(page: Page, root: string): Promise<void> {
  await page.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

async function pageSignature(page: Page): Promise<{ pixels: number[]; renderedPixels: number; text: string; controls: number; startupHooksPresent: boolean | null }> {
  return await page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width >= 8 && rect.height >= 8 && style.visibility !== "hidden" && style.display !== "none";
    };
    const canvas = [...document.querySelectorAll("canvas")].find(visible) as HTMLCanvasElement | undefined;
    const width = canvas?.width ?? 0;
    const height = canvas?.height ?? 0;
    let pixels = new Uint8ClampedArray(0);
    let renderedPixels = 0;
    if (canvas && width > 0 && height > 0) {
      const context = canvas.getContext("2d");
      if (context) {
        pixels = context.getImageData(0, 0, width, height).data;
        for (let index = 0; index < pixels.length; index += 4) {
          if ((pixels[index] ?? 0) !== 0 || (pixels[index + 1] ?? 0) !== 0 || (pixels[index + 2] ?? 0) !== 0 || (pixels[index + 3] ?? 0) !== 0) renderedPixels += 1;
        }
      }
    }
    const controls = [...document.querySelectorAll("button,[role='button'],a[href],canvas,input,select,textarea")].filter(visible).length;
    const startupHooksPresent = "start" in window || "draw" in window ? typeof (window as typeof window & { start?: unknown }).start === "function" || typeof (window as typeof window & { draw?: unknown }).draw === "function" : null;
    return {
      pixels: Array.from(pixels),
      renderedPixels,
      text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim(),
      controls,
      startupHooksPresent,
    };
  });
}

function changedPixels(before: number[], after: number[]): number {
  const limit = Math.min(before.length, after.length);
  let changed = Math.abs(before.length - after.length) / 4;
  for (let index = 0; index < limit; index += 4) {
    if (before[index] !== after[index] || before[index + 1] !== after[index + 1] || before[index + 2] !== after[index + 2] || before[index + 3] !== after[index + 3]) changed += 1;
  }
  return changed;
}

async function exercise(page: Page): Promise<void> {
  await page.keyboard.press("ArrowDown").catch(() => undefined);
  await page.waitForTimeout(70);
  await page.keyboard.press("ArrowRight").catch(() => undefined);
  await page.waitForTimeout(70);
  const buttons = await page.locator("button:visible").count().catch(() => 0);
  for (let index = 0; index < Math.min(buttons, 4); index += 1) {
    await page.locator("button:visible").nth(index).click({ timeout: 500 }).catch(() => undefined);
    await page.waitForTimeout(70);
  }
  const canvas = page.locator("canvas:visible").first();
  if (await canvas.count().catch(() => 0)) {
    const box = await canvas.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.75).catch(() => undefined);
      await page.mouse.down().catch(() => undefined);
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.75).catch(() => undefined);
      await page.mouse.up().catch(() => undefined);
      await page.waitForTimeout(120);
    }
  }
  await page.waitForTimeout(180);
}

async function validatePlayablePage(page: Page, errors: string[], html: string): Promise<PlayableReleaseEvidence> {
  const initial = await pageSignature(page);
  if (errors.length) throw new PlayableReleaseValidationError(`Generated game has a browser runtime error: ${errors[0]}`);
  if (initial.renderedPixels <= 0) throw new PlayableReleaseValidationError("Generated game did not draw anything into its visible canvas.");
  if (initial.controls <= 0) throw new PlayableReleaseValidationError("Generated game has no visible render surface or controls.");
  if (expectedStartupHooks(html) && !initial.startupHooksPresent) throw new PlayableReleaseValidationError("Generated game startup/draw hook was not defined at runtime.");
  await exercise(page);
  const after = await pageSignature(page);
  if (errors.length) throw new PlayableReleaseValidationError(`Generated game failed while being played: ${errors[0]}`);
  const diff = changedPixels(initial.pixels, after.pixels);
  const textChanged = initial.text !== after.text;
  if (diff <= 0 && !textChanged) throw new PlayableReleaseValidationError("Generated game did not respond visibly to time or player input.");
  return {
    renderedPixels: initial.renderedPixels,
    changedPixels: diff,
    visibleTextChanged: textChanged,
    visibleControls: initial.controls,
    startupHooksPresent: expectedStartupHooks(html) ? Boolean(initial.startupHooksPresent) : null,
  };
}

async function validateVisibleProposalChange(browser: Browser, beforeHtml: string, afterHtml: string, proposal: RankedProposal): Promise<boolean> {
  const before = await htmlPage(browser, beforeHtml, "before");
  const after = await htmlPage(browser, afterHtml, "after");
  try {
    await Promise.all([exercise(before.page), exercise(after.page)]);
    const beforeSig = await pageSignature(before.page);
    const afterSig = await pageSignature(after.page);
    const pixelDiff = changedPixels(beforeSig.pixels, afterSig.pixels);
    const textDiff = beforeSig.text !== afterSig.text;
    if (pixelDiff <= 0 && !textDiff) return false;
    const haystack = `${afterSig.text} ${afterHtml}`.toLowerCase();
    const keywords = proposalKeywords(proposal);
    if (keywords.length && !keywords.some((keyword) => haystack.includes(keyword))) {
      return false;
    }
    return true;
  } finally {
    await cleanupPage(before.page, before.root);
    await cleanupPage(after.page, after.root);
  }
}

export async function launchPlayableReleaseBrowser(): Promise<Browser> {
  try {
    const channel = process.env.LEVELUP_PLAYWRIGHT_CHANNEL?.trim();
    return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  } catch (error) {
    throw new PlayableReleaseValidationError(`Browser playability validator could not start: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export async function validatePlayableReleaseHtml(input: { sourceHtml: string; gameHtml: string; releaseHtml: string; proposal: RankedProposal }, existingBrowser?: Browser): Promise<PlayableReleaseEvidence> {
  const browser = existingBrowser ?? await launchPlayableReleaseBrowser();
  const release = await htmlPage(browser, input.releaseHtml, "release");
  try {
    const evidence = await validatePlayablePage(release.page, release.errors, input.releaseHtml);
    const materialChanged = await validateVisibleProposalChange(browser, input.sourceHtml, input.gameHtml, input.proposal);
    return { ...evidence, materialChanged };
  } finally {
    await cleanupPage(release.page, release.root);
    if (!existingBrowser) await browser.close().catch(() => undefined);
  }
}
