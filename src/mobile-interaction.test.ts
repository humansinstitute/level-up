import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
let browser: Browser;

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

describe("mobile selection interaction contract", () => {
  test("a vertical drag starting on a chooser link scrolls without activating it", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 640 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style><main class="app-shell team-shell"><section class="future-card"><div class="team-list">${Array.from({ length: 24 }, (_, index) => `<article><a href="/teams/team-${index}"><span><strong>Team ${index}</strong><small>Player · 4 members</small></span><b>→</b></a></article>`).join("")}</div></section></main><script>window.activations=0;document.querySelectorAll('a').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();window.activations++}))</script>`);
    const session = await context.newCDPSession(page);
    const target = (await page.locator(".team-list a").nth(2).boundingBox())!;
    const x = target.x + target.width / 2;
    const startY = target.y + target.height / 2;
    await session.send("Input.synthesizeScrollGesture", { x, y: startY, yDistance: -300, speed: 500, gestureSourceType: "touch" });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => Math.max(scrollY, document.documentElement.scrollTop, document.body.scrollTop, document.querySelector(".app-shell")?.scrollTop ?? 0))).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { activations: number }).activations)).toBe(0);
    await context.close();
  });

  test("shell and bundled games prevent incidental zoom/selection without limiting pinch zoom", async () => {
    expect(css).toContain("touch-action: manipulation");
    expect(css).toContain("user-select: none");
    expect(css).toContain('input, textarea, select, [contenteditable="true"]');
    const templates = ["arcade-cabinet", "citadel-strike", "maze-minotaur", "neon-snake", "pocket-pong", "river-frogger", "skyline-sprint", "village-games"];
    for (const template of templates) {
      const html = await Bun.file(new URL(`../public/templates/${template}/index.html`, import.meta.url)).text();
      expect(html).toContain("touch-action:manipulation");
      expect(html).toContain("user-select:none");
      expect(html).not.toContain("maximum-scale");
    }
  });
});
