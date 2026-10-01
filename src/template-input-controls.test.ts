import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { resolve } from "node:path";

const templates = ["citadel-strike", "maze-minotaur", "neon-snake", "pocket-pong", "river-frogger", "skyline-sprint"];
let browser: Browser;

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

function url(id: string) {
  return `file://${resolve("public/templates", id, "index.html")}`;
}

async function canvasPixels(page: import("playwright").Page) {
  return page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let index = 0; index < data.length; index += 16) hash = Math.imul(hash ^ data[index]!, 16777619);
    return hash >>> 0;
  });
}

async function controlState(page: import("playwright").Page, id: string) {
  return page.evaluate((template) => {
    if (template === "pocket-pong") return eval("px");
    if (template === "neon-snake") return eval("dir.join(',')");
    if (template === "river-frogger") return eval("`${p.x},${p.y}`");
    if (template === "citadel-strike") return eval("`${player.x.toFixed(2)},${player.y.toFixed(2)},${player.yaw.toFixed(2)}`");
    if (template === "skyline-sprint") return eval("`${player.x.toFixed(2)},${player.y.toFixed(2)}`");
    return eval("p.join(',')");
  }, id);
}

async function citadelSnapshot(page: import("playwright").Page) {
  return page.evaluate(() => eval("({running,outcome,health,elapsed,shots,hits,player:{...player},enemies:enemies.map(e=>({...e,visible:!!projectEnemy(e,canvas.width,canvas.height)})),visibleEnemies:enemies.filter(e=>e.alive&&projectEnemy(e,canvas.width,canvas.height)).length,aimed:!!aimedEnemy()})"));
}

async function approachCitadelEnemy(page: import("playwright").Page, index: number) {
  await page.evaluate((enemyIndex) => eval(`(()=>{const e=enemies[${enemyIndex}],a=Math.atan2(e.y-player.y,e.x-player.x);player.x=e.x-Math.cos(a)*2.2;player.y=e.y-Math.sin(a)*2.2;player.yaw=a;draw()})()`), index);
}

async function skylineSnapshot(page: import("playwright").Page) {
  return page.evaluate(() => eval("({running,outcome,hearts,collected,player:{...player},keys:[...keys],analogue:{...analogue},dash:{...dash}})"));
}

test("all templates preserve their visible startup and playability contract", async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 720 } });
  for (const id of templates) {
    await page.goto(url(id));
    await expect(page.locator("canvas").isVisible()).resolves.toBe(true);
    await expect(page.locator("#start").isVisible()).resolves.toBe(true);
    expect(await page.locator("#start button").textContent()).toContain("START");
    expect(await canvasPixels(page)).not.toBe(0);
    await page.locator("#start button").click();
    await expect(page.locator("#start").isHidden()).resolves.toBe(true);
  }
  await page.close();
});

test("Neon Trail can collect food without blocking the browser tab", async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 720 } });
  await page.goto(url("neon-snake"));
  await page.locator("#start button").click();
  await expect(page.evaluate(() => eval("clearInterval(timer);food=[11,10];step();({score,food:[...food]})"))).resolves.toEqual(expect.objectContaining({ score: 1 }));
  await expect(page.locator("#s").textContent()).resolves.toBe("Score: 1");
  await page.close();
});

test("keyboard input starts and visibly controls every template", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  for (const id of templates) {
    await page.goto(url(id));
    await page.keyboard.press(id === "neon-snake" || id === "pocket-pong" ? "Space" : "Enter");
    await expect(page.locator("#start").isHidden()).resolves.toBe(true);
    const before = await controlState(page, id);
    await page.keyboard.press(id === "pocket-pong" ? "ArrowLeft" : id === "skyline-sprint" ? "ArrowRight" : "ArrowDown");
    await page.waitForTimeout(id === "neon-snake" ? 140 : 35);
    const after = await controlState(page, id);
    if (after === before) throw new Error(`${id} did not visibly respond to keyboard input`);
    await page.keyboard.press("r");
    await expect(page.locator("#s").textContent()).resolves.toMatch(/Score: 0|First to 5|Reach the gold gate|Hop to the bright bank|Armour 100|Cells 0\/5/);
  }
  await page.close();
});

test("touch-first legends and one directional swipe work on every template", async () => {
  const context = await browser.newContext({ viewport: { width: 320, height: 720 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  for (const id of templates) {
    await page.goto(url(id));
    expect(await page.locator("#controls").textContent()).toMatch(id === "citadel-strike" || id === "skyline-sprint" ? /Left pad/ : /Swipe/);
    await page.locator("#start button").tap();
    const surface = id === "citadel-strike" || id === "skyline-sprint" ? page.locator(".analogue") : page.locator("canvas");
    const box = (await surface.boundingBox())!;
    const before = await controlState(page, id);
    await surface.dispatchEvent("pointerdown", { pointerId: 7, pointerType: "touch", clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, bubbles: true });
    const horizontal = id === "pocket-pong" || id === "citadel-strike" || id === "skyline-sprint";
    const endX = box.x + box.width / 2 + (horizontal ? 60 : 0);
    const endY = box.y + box.height / 2 + (horizontal ? 0 : 60);
    await surface.dispatchEvent("pointermove", { pointerId: 7, pointerType: "touch", clientX: endX, clientY: endY, bubbles: true, cancelable: true });
    if (id === "citadel-strike" || id === "skyline-sprint") await page.evaluate(() => eval("update(.12,performance.now())"));
    await page.waitForTimeout(id === "citadel-strike" || id === "skyline-sprint" ? 50 : 0);
    await surface.dispatchEvent("pointerup", { pointerId: 7, pointerType: "touch", clientX: endX, clientY: endY, bubbles: true });
    await page.waitForTimeout(id === "neon-snake" ? 140 : 35);
    const after = await controlState(page, id);
    if (after === before) throw new Error(`${id} did not visibly respond to swipe input`);
  }
  await context.close();
});

test("a later keyboard or touch input updates the control legend", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  await page.goto(url("maze-minotaur"));
  await page.keyboard.press("ArrowDown");
  expect(await page.locator("#controls").textContent()).toMatch(/Arrow keys/);
  await page.locator("canvas").dispatchEvent("pointerdown", { pointerId: 9, pointerType: "touch", clientX: 30, clientY: 30, bubbles: true });
  expect(await page.locator("#controls").textContent()).toMatch(/Swipe/);
  await page.close();
});

test("Skyline Sprint analogue release, cancellation, visibility, and blur all stop movement", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(url("skyline-sprint"));
  await page.locator("#start button").tap();
  const right = page.getByLabel("Run analogue pad");
  const box = (await right.boundingBox())!;
  const press = (pointerId: number) => right.dispatchEvent("pointerdown", { pointerId, pointerType: "touch", clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, bubbles: true });
  const drag = (pointerId: number) => right.dispatchEvent("pointermove", { pointerId, pointerType: "touch", clientX: box.x + box.width * .92, clientY: box.y + box.height / 2, bubbles: true });

  await press(31);await drag(31);
  await right.dispatchEvent("pointerup", { pointerId: 31, pointerType: "touch", bubbles: true });
  await page.waitForTimeout(300);
  const afterTap = await skylineSnapshot(page);
  await page.waitForTimeout(350);
  const afterRest = await skylineSnapshot(page);
  expect(afterTap.analogue.pointerId).toBeNull();
  expect(Math.abs(afterRest.player.vx)).toBeLessThan(1);
  expect(Math.abs(afterRest.player.x - afterTap.player.x)).toBeLessThan(1);

  await press(32);await drag(32);
  await page.waitForTimeout(160);
  await right.dispatchEvent("pointercancel", { pointerId: 32, pointerType: "touch", bubbles: true });
  await page.waitForTimeout(250);
  expect((await skylineSnapshot(page)).analogue.pointerId).toBeNull();

  await press(33);await drag(33);
  await page.waitForTimeout(100);
  await page.evaluate(() => dispatchEvent(new Event("blur")));
  await page.waitForTimeout(250);
  const blurred = await skylineSnapshot(page);
  expect(blurred.analogue.pointerId).toBeNull();
  expect(Math.abs(blurred.player.vx)).toBeLessThan(1);

  await press(34);await drag(34);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  expect((await skylineSnapshot(page)).analogue.pointerId).toBeNull();

  await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, value: false }));
  await press(35);await drag(35);
  await right.dispatchEvent("lostpointercapture", { pointerId: 35, pointerType: "touch", bubbles: true });
  expect((await skylineSnapshot(page)).analogue.pointerId).toBeNull();

  await press(36);await drag(36);
  await page.keyboard.down("ArrowLeft");
  const hybrid = await skylineSnapshot(page);
  expect(hybrid.analogue.pointerId).toBeNull();
  expect(hybrid.keys).toEqual(["arrowleft"]);
  await page.keyboard.up("ArrowLeft");
  await context.close();
});

test("Skyline Sprint held touch and keyboard movement remain responsive then brake", async () => {
  const context = await browser.newContext({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(url("skyline-sprint"));
  await page.locator("#start button").tap();
  const start = await skylineSnapshot(page);
  const right = page.getByLabel("Run analogue pad"),box=(await right.boundingBox())!;
  await right.dispatchEvent("pointerdown", { pointerId: 41, pointerType: "touch", clientX:box.x+box.width/2,clientY:box.y+box.height/2,bubbles: true });
  await right.dispatchEvent("pointermove", { pointerId: 41, pointerType: "touch", clientX:box.x+box.width*.92,clientY:box.y+box.height/2,bubbles: true });
  await page.evaluate(() => eval("update(.2,performance.now())"));
  await page.waitForTimeout(650);
  const held = await skylineSnapshot(page);
  await right.dispatchEvent("pointerup", { pointerId: 41, pointerType: "touch", bubbles: true });
  expect(held.player.x - start.player.x).toBeGreaterThan(25);
  expect(held.player.vx).toBeGreaterThan(180);
  await page.waitForTimeout(300);
  const stopped = await skylineSnapshot(page);
  expect(Math.abs(stopped.player.vx)).toBeLessThan(1);

  await page.evaluate(() => eval("player.x=42;player.y=500;player.vx=0;player.vy=0"));
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(600);
  await page.keyboard.up("ArrowRight");
  const keyboardMoved = await skylineSnapshot(page);
  expect(keyboardMoved.player.x).toBeGreaterThan(65);
  await page.waitForTimeout(300);
  expect(Math.abs((await skylineSnapshot(page)).player.vx)).toBeLessThan(1);
  await context.close();
});

test("Skyline Sprint cannot progress passively and requires every elevated cell to win", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  await page.goto(url("skyline-sprint"));
  await page.locator("#start button").click();
  const start = await skylineSnapshot(page);
  await page.waitForTimeout(1400);
  const passive = await skylineSnapshot(page);
  expect(Math.abs(passive.player.x - start.player.x)).toBeLessThan(1);
  expect(passive.collected).toBe(0);
  expect(passive.outcome).toBe("playing");

  await page.evaluate(() => eval("player.x=2500;player.y=400;player.vx=0;update(.016,performance.now())"));
  expect((await skylineSnapshot(page)).outcome).toBe("playing");
  expect(await page.locator("#goal").textContent()).toContain("NEEDS 5 CELLS");

  for (let index = 0; index < 5; index++) {
    await page.evaluate((cellIndex) => eval(`(()=>{const c=cells[${cellIndex}];player.x=c[0]-14;player.y=c[1]-18;player.vx=0;player.vy=0;update(.016,performance.now());draw()})()`), index);
  }
  expect((await skylineSnapshot(page)).collected).toBe(5);
  await page.evaluate(() => eval("player.x=2460;player.y=400;player.vx=40;update(.016,performance.now())"));
  const won = await skylineSnapshot(page);
  expect(won.outcome).toBe("won");
  expect(won.player.vx).toBe(0);
  await page.waitForTimeout(300);
  expect((await skylineSnapshot(page)).outcome).toBe("won");
  await page.close();
});

test("Skyline Sprint hazards produce defeat and restart restores a stable course", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  await page.goto(url("skyline-sprint"));
  await page.locator("#start button").click();
  for (let hit = 0; hit < 3; hit++) await page.evaluate(() => eval("invuln=0;player.x=330;player.y=521;player.vx=0;player.vy=0;update(.016,performance.now())"));
  const lost = await skylineSnapshot(page);
  expect(lost.outcome).toBe("lost");
  expect(lost.hearts).toBe(0);
  expect(await page.locator("h1").textContent()).toContain("RunOver");
  await page.locator("#start button").click();
  const restarted = await skylineSnapshot(page);
  expect(restarted).toEqual(expect.objectContaining({ outcome: "playing", hearts: 3, collected: 0 }));
  expect(restarted.analogue).toEqual(expect.objectContaining({ pointerId: null, x: 0, y: 0 }));
  expect(Math.abs(restarted.player.x - 42)).toBeLessThan(1);
  expect(Math.abs(restarted.player.y - 500)).toBeLessThan(1);
  expect(Math.abs(restarted.player.vx)).toBeLessThan(10);
  expect(Math.abs(restarted.player.vy)).toBeLessThan(10);
  await page.close();
});

test("Citadel Strike sustains trackable combat and reaches a stable restart", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  await page.goto(url("citadel-strike"));
  await page.locator("#start button").click();

  await approachCitadelEnemy(page, 0);
  const first = await citadelSnapshot(page);
  expect(first.visibleEnemies).toBeGreaterThan(0);
  expect(first.aimed).toBe(true);
  await page.waitForTimeout(900);
  const tracked = await citadelSnapshot(page);
  expect(tracked.visibleEnemies).toBeGreaterThan(0);
  expect(tracked.aimed).toBe(true);
  expect(tracked.enemies[0].alive).toBe(true);

  const viewBeforeTurn = await canvasPixels(page);
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(240);
  await page.keyboard.up("ArrowRight");
  expect(await canvasPixels(page)).not.toBe(viewBeforeTurn);
  const turned = await citadelSnapshot(page);
  expect(turned.player.yaw).not.toBe(first.player.yaw);

  await page.evaluate(() => eval("player.yaw=Math.atan2(enemies[0].y-player.y,enemies[0].x-player.x);draw()"));
  await page.keyboard.press("Space");
  expect(await page.locator("#message").textContent()).toContain("HIT");
  await page.keyboard.press("Space");
  expect(await page.locator("#s").textContent()).toContain("Drones 5");

  for (let index = 1; index < 6; index++) {
    await approachCitadelEnemy(page, index);
    await page.keyboard.press("Space");
    await page.keyboard.press("Space");
  }
  await expect(page.locator("#start").isVisible()).resolves.toBe(true);
  expect(await page.locator("h1").textContent()).toContain("CitadelClear");
  const won = await citadelSnapshot(page);
  expect(won.outcome).toBe("won");
  expect(won.hits).toBe(12);

  await page.locator("#start button").click();
  const restarted = await citadelSnapshot(page);
  expect(restarted.outcome).toBe("playing");
  expect(restarted.enemies.filter((enemy: { alive: boolean }) => enemy.alive)).toHaveLength(6);
  expect(restarted.health).toBe(100);
  await page.close();
});

test("Citadel Strike touch controls support sustained movement and combat at phone width", async () => {
  const context = await browser.newContext({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(url("citadel-strike"));
  await page.locator("#start button").tap();
  const before = await citadelSnapshot(page);
  const forward = page.getByLabel("Move and turn analogue pad"),box=(await forward.boundingBox())!;
  await forward.dispatchEvent("pointerdown", { pointerId: 20, pointerType: "touch", clientX:box.x+box.width/2,clientY:box.y+box.height/2,bubbles: true });
  await forward.dispatchEvent("pointermove", { pointerId: 20, pointerType: "touch", clientX:box.x+box.width/2,clientY:box.y+box.height*.08,bubbles: true });
  await page.evaluate(() => eval("update(.3)"));
  await page.waitForTimeout(650);
  await forward.dispatchEvent("pointerup", { pointerId: 20, pointerType: "touch", bubbles: true });
  const moved = await citadelSnapshot(page);
  expect(Math.hypot(moved.player.x - before.player.x, moved.player.y - before.player.y)).toBeGreaterThan(0.4);

  await approachCitadelEnemy(page, 0);
  await page.getByLabel("Fire").tap();
  await page.getByLabel("Fire").tap();
  expect(await page.locator("#s").textContent()).toContain("Drones 5");
  expect(await page.locator("#message").textContent()).toContain("DRONE DOWN");
  await context.close();
});
