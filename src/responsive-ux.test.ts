import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
let browser: Browser;

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

function fixture(dialog = false): string {
  const form = `<form class="device-form"><h2>Make a game</h2><label><span>Project name</span><input value="A deliberately long project name that must remain contained"></label><label><span>Idea and context</span><textarea rows="6">A focused field must keep its label and next action reachable while the viewport is reduced.</textarea></label><p class="status">Ready to continue.</p><button class="primary-button compact-button">Continue <span>→</span></button></form>`;
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><main class="app-shell">${dialog ? `<div class="dialog-backdrop"><section class="profile-dialog">${form}<div class="dialog-actions"><button class="text-button">Cancel</button><button class="primary-button compact-button">Save</button></div></section></div>` : `<section class="login-card">${form}</section>`}</main>`;
}

function phaseFixture(): string {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><main class="app-shell project-shell"><section class="project-room"><header class="round-hero"><div><p class="eyebrow">ROUND 1 · BRAINSTORM</p><h1>Moonbase Mischief</h1><p>Maze · Open current playable game</p><p class="viewer-badge">You are Player</p></div><div class="voxel-timer"><small>IDEA TIME</small><strong>04:32</strong></div></header><ol class="round-progress"><li class="active"><b>1</b><span>Brainstorm</span></li><li><b>2</b><span>Review</span></li><li><b>3</b><span>Prioritise</span></li><li><b>4</b><span>Build</span></li><li class="iterate-loop"><b>5</b><span>Iterate</span><small>loops to Brainstorm</small></li></ol><div class="round-workspace version-rail-collapsed"><main class="round-workflow"><div class="round-layout"><section class="ideas-panel"><h2>Ideas in the room</h2><form class="idea-form"><label for="round-idea">Add an idea</label><div class="idea-composer-row"><label class="paperclip-button"><span class="paperclip-label">Attach</span><svg></svg></label><textarea id="round-idea"></textarea><button class="primary-button compact-button">Send idea <span>→</span></button></div></form></section></div></main><aside class="project-utility-rail-collapsed" aria-label="Game Versions collapsed"><button aria-label="Expand Game Versions"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg><span>Game Versions</span></button></aside></div></section></main>`;
}

function adminTabsFixture(): string {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><main class="app-shell admin-shell"><section class="admin-card"><div class="admin-mode"><nav class="admin-tabs" aria-label="Admin sections"><button class="selected" aria-current="page">Monitoring</button><button>Group Mode</button><button>Models</button><button>Prompts</button></nav></div></section></main>`;
}

describe("responsive form primitives", () => {
  for (const viewport of [
    { name: "320px phone", width: 320, height: 568 },
    { name: "common phone", width: 390, height: 844 },
    { name: "portrait small tablet", width: 600, height: 800 },
    { name: "landscape small tablet", width: 800, height: 600 },
    { name: "desktop", width: 1280, height: 900 },
  ]) test(`${viewport.name} has no ordinary horizontal overflow`, async () => {
    const page = await browser.newPage({ viewport });
    await page.setContent(fixture());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.close();
  });

  test("a virtual-keyboard-sized viewport keeps focused context and action reachable", async () => {
    const page = await browser.newPage({ viewport: { width: 320, height: 360 } });
    await page.setContent(fixture(true));
    const textarea = page.getByLabel("Idea and context");
    await textarea.focus();
    await textarea.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const focus = await textarea.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return { outlineWidth: style.outlineWidth, top: rect.top, bottom: rect.bottom, viewport: innerHeight };
    });
    expect(focus.outlineWidth).toBe("3px");
    expect(focus.bottom).toBeLessThanOrEqual(focus.viewport);
    expect(focus.top).toBeGreaterThanOrEqual(0);
    const action = page.getByRole("button", { name: "Save" });
    await action.scrollIntoViewIfNeeded();
    expect(await action.isVisible()).toBe(true);
    expect((await action.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(52);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.close();
  });

  test("200% zoom remains contained and reduced motion removes meaningful transitions", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.setContent(fixture());
    await page.evaluate(() => { document.body.style.zoom = "2"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const duration = await page.locator(".primary-button").evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.00001);
    await context.close();
  });

  for (const width of [320, 393]) test(`${width}px prioritises phase task and compact controls`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.setContent(phaseFixture());
    const hero = await page.locator(".round-hero").boundingBox();
    const progress = await page.locator(".round-progress").boundingBox();
    expect(hero?.height ?? 0).toBeLessThanOrEqual(52);
    expect(progress?.height ?? 0).toBeLessThanOrEqual(40);
    expect(await page.locator(".agent-stage-note").count()).toBe(0);
    const textarea = await page.locator("#round-idea").boundingBox();
    const attach = await page.getByText("Attach", { exact: true }).locator("..").boundingBox();
    const send = await page.getByRole("button", { name: /Send idea/ }).boundingBox();
    expect(textarea?.width ?? 0).toBeGreaterThan((attach?.width ?? 0) * 2.5);
    expect(attach?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(send?.height ?? 0).toBeGreaterThanOrEqual(52);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await page.locator(".project-utility-rail-collapsed button").evaluate((element) => getComputedStyle(element).touchAction)).toBe("manipulation");
    await page.close();
  });

  for (const width of [1280, 901]) test(`${width}px collapsed Game Versions uses a thin desktop rail`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent(phaseFixture());
    const workspace = page.locator(".round-workspace");
    const workflow = await page.locator(".round-workflow").boundingBox();
    const rail = await page.locator(".project-utility-rail-collapsed").boundingBox();
    const opener = page.getByRole("button", { name: "Expand Game Versions" });
    expect(rail?.width).toBe(56);
    expect((workflow?.width ?? 0) / ((await workspace.boundingBox())?.width ?? 1)).toBeGreaterThan(.9);
    expect((await opener.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await opener.focus();
    expect(await opener.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe("3px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.close();
  });

  test("900px boundary keeps the collapsed opener compact below the workflow", async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    await page.setContent(phaseFixture());
    const workflow = await page.locator(".round-workflow").boundingBox();
    const rail = await page.locator(".project-utility-rail-collapsed").boundingBox();
    const opener = await page.getByRole("button", { name: "Expand Game Versions" }).boundingBox();
    expect(rail?.y ?? 0).toBeGreaterThanOrEqual((workflow?.y ?? 0) + (workflow?.height ?? 0));
    expect(opener?.height ?? 0).toBe(44);
    expect(opener?.width ?? 0).toBeLessThan(220);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.close();
  });

  for (const width of [320, 1280]) test(`${width}px owner admin tabs stay contained with accessible touch targets`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.setContent(adminTabsFixture());
    const tabs = page.locator(".admin-tabs button");
    expect(await tabs.count()).toBe(4);
    for (let index = 0; index < 4; index += 1) expect((await tabs.nth(index).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    if (width === 320) {
      const first = await tabs.nth(0).boundingBox();
      const second = await tabs.nth(1).boundingBox();
      const third = await tabs.nth(2).boundingBox();
      expect(second?.y).toBe(first?.y);
      expect((third?.y ?? 0)).toBeGreaterThan(first?.y ?? 0);
    }
    await tabs.nth(1).focus();
    expect(await tabs.nth(1).evaluate((element) => getComputedStyle(element).outlineWidth)).toBe("3px");
    await page.close();
  });
});
