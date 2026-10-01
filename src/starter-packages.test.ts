import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { resolve } from "node:path";

let browser: Browser;
beforeAll(async()=>{browser=await chromium.launch({headless:true});});
afterAll(async()=>{await browser?.close();});
const url=(id:string)=>`file://${resolve("public/templates",id,"index.html")}`;

test("Village Games starts, moves by keyboard and swipe, and restarts",async()=>{
  const context=await browser.newContext({viewport:{width:320,height:720},hasTouch:true,isMobile:true});const page=await context.newPage();await page.goto(url("village-games"));
  await expect(page.locator("#start button").textContent()).resolves.toContain("START");await page.locator("#start button").tap();
  const before=await page.evaluate(()=>eval("`${player.x},${player.y}`"));await page.keyboard.press("ArrowRight");expect(await page.evaluate(()=>eval("`${player.x},${player.y}`"))).not.toBe(before);
  const canvas=page.locator("canvas"),box=(await canvas.boundingBox())!;await canvas.dispatchEvent("pointerdown",{pointerId:1,pointerType:"touch",clientX:box.x+80,clientY:box.y+80,bubbles:true});await canvas.dispatchEvent("pointerup",{pointerId:1,pointerType:"touch",clientX:box.x+80,clientY:box.y+145,bubbles:true});expect(await page.locator("#controls").textContent()).toContain("Swipe");
  await page.locator("#restart").tap();await expect(page.locator("#s").textContent()).resolves.toContain("Help 0/3");await context.close();
});

test("Village Games offers Space conversations and coherent quest progress for Pip and Bo",async()=>{
  const page=await browser.newPage({viewport:{width:900,height:800}});await page.goto(url("village-games"));await page.locator("#start button").click();
  await page.evaluate(()=>eval("player={x:330,y:390};update();draw()"));
  await expect(page.locator("#prompt").textContent()).resolves.toContain("Space — Talk to Pip");
  await page.keyboard.press("Space");await expect(page.locator("#speaker").textContent()).resolves.toBe("Pip");expect(await page.locator("#speech").textContent()).toContain("footbridge");
  await page.keyboard.press("Space");expect(await page.locator("#speech").textContent()).toContain("2 wood");await page.keyboard.press("Space");
  expect(await page.evaluate(()=>eval("quests.pip.state"))).toBe("active");expect(await page.locator("#s").textContent()).toContain("Pip’s Footbridge: 0/2");
  await page.evaluate(()=>eval("wood=2;update()"));await page.keyboard.press("Space");expect(await page.locator("#speech").textContent()).toContain("safe and strong");await page.keyboard.press("Space");await page.keyboard.press("Space");
  expect(await page.evaluate(()=>eval("({state:quests.pip.state,helped,coins})"))).toEqual({state:"complete",helped:1,coins:10});
  await page.evaluate(()=>eval("player={x:455,y:175};update();draw()"));await expect(page.locator("#prompt").textContent()).resolves.toContain("Talk to Bo");await page.keyboard.press("Space");expect(await page.locator("#speech").textContent()).toContain("berry paint");
  await page.keyboard.press("Space");expect(await page.locator("#speech").textContent()).toContain("2 berries");await page.keyboard.press("Space");expect(await page.evaluate(()=>eval("quests.bo.state"))).toBe("active");
  await page.evaluate(()=>eval("berries=2;update()"));await page.keyboard.press("Space");expect(await page.locator("#speech").textContent()).toContain("glows like sunset");await page.keyboard.press("Space");await page.keyboard.press("Space");expect(await page.evaluate(()=>eval("quests.bo.state"))).toBe("complete");
  await page.close();
});

test("Village Games enters and exits authored houses and supports shop purchase failures and touch controls",async()=>{
  const context=await browser.newContext({viewport:{width:320,height:720},hasTouch:true,isMobile:true});const page=await context.newPage();await page.goto(url("village-games"));await page.locator("#start button").tap();
  await page.evaluate(()=>eval("player={x:211,y:100};update();draw()"));await expect(page.locator("#prompt").textContent()).resolves.toContain("Tap — Enter");await page.locator("#touch-interact").tap();expect(await page.evaluate(()=>eval("scene"))).toBe("shop");
  await page.evaluate(()=>eval("player={x:320,y:190};update();draw()"));await expect(page.locator("#touch-interact").textContent()).resolves.toBe("Browse shop");await page.locator("#touch-interact").tap();
  await page.locator('[data-buy="lantern"]').tap();await expect(page.locator("#shop-feedback").textContent()).resolves.toContain("3 more coins");
  await page.locator('[data-buy="apple"]').tap();await expect(page.locator("#shop-feedback").textContent()).resolves.toContain("Bought Trail Apple");expect(await page.evaluate(()=>eval("inventory"))).toEqual(["apple"]);
  await page.locator("#close-shop").tap();await page.evaluate(()=>eval("player={x:320,y:430};update();draw()"));await expect(page.locator("#touch-interact").textContent()).resolves.toBe("Exit");await page.locator("#touch-interact").tap();expect(await page.evaluate(()=>eval("({scene,player})"))).toEqual({scene:"village",player:{x:211,y:100}});
  await page.evaluate(()=>eval("player={x:591,y:100};update();draw()"));await page.locator("#touch-interact").tap();expect(await page.evaluate(()=>eval("scene"))).toBe("story");await page.evaluate(()=>eval("player={x:455,y:205};update();draw()"));await expect(page.locator("#touch-interact").textContent()).resolves.toBe("Read story");await page.locator("#touch-interact").tap();await expect(page.locator("#speaker").textContent()).resolves.toBe("Village Story");
  await page.locator("#restart").tap();expect(await page.evaluate(()=>eval("({scene,coins,inventory,helped})"))).toEqual({scene:"village",coins:5,inventory:[],helped:0});await context.close();
});

test("Village Games gives Mira a quest and every non-shop house a distinct authored object",async()=>{
  const page=await browser.newPage({viewport:{width:900,height:800}});await page.goto(url("village-games"));await page.locator("#start button").click();
  await page.evaluate(()=>eval("player={x:175,y:155};update();draw()"));await page.keyboard.press("Space");expect(await page.locator("#speech").textContent()).toContain("cottage roof");await page.locator("#close-dialogue").click();expect(await page.evaluate(()=>eval("quests.mira.state"))).toBe("available");
  await page.keyboard.press("Space");await page.keyboard.press("Space");await page.keyboard.press("Space");expect(await page.evaluate(()=>eval("quests.mira.state"))).toBe("active");
  const expected=[["mira","Read recipe"],["bo","Inspect invention"],["pip","Look at map"],["story","Read story"]] as const;
  for(const [kind,label] of expected){await page.evaluate(k=>eval(`scene='${k}';player={x:${k==='mira'||k==='pip'?190:455},y:205};update();draw()`),kind);await expect(page.locator("#interact").textContent()).resolves.toBe(label)}
  await page.close();
});

test("Village Games shop supports keyboard selection, purchase, cancel, and touch purchase",async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});const page=await context.newPage();await page.goto(url("village-games"));await page.locator("#start button").tap();
  await page.evaluate(()=>eval("coins=20;openShop()"));await expect(page.locator('.shop-grid article.selected h3').textContent()).resolves.toBe("Trail Apple");
  await page.keyboard.press("ArrowRight");await expect(page.locator('.shop-grid article.selected h3').textContent()).resolves.toBe("Firefly Lantern");await page.keyboard.press("Enter");expect(await page.evaluate(()=>eval("inventory.includes('lantern')"))).toBe(true);await expect(page.locator("#shop-feedback").textContent()).resolves.toContain("Day 3");
  await page.keyboard.press("Escape");await expect(page.locator("#shop").isHidden()).resolves.toBe(true);await page.evaluate(()=>eval("openShop()"));await page.locator('[data-buy="basket"]').tap();expect(await page.evaluate(()=>eval("inventory.includes('basket')"))).toBe(true);
  await expect(page.locator('.touch-controls').getAttribute('aria-label')).resolves.toBe("Touch game controls");expect(await page.locator('.move-pad button').count()).toBe(4);await expect(page.locator('#touch-interact').getAttribute('aria-label')).resolves.toContain("Interact");
  const movement=(await page.locator('.move-pad').boundingBox())!,action=(await page.locator('.action-pad').boundingBox())!;expect(movement.x).toBeLessThan(action.x);await context.close();
});

test("Village Games traverses five authored days with rotating visitors and useful purchases",async()=>{
  const page=await browser.newPage({viewport:{width:900,height:800}});await page.goto(url("village-games"));await page.locator("#start button").click();
  expect(await page.evaluate(()=>eval("npcs.map(n=>n.n)"))).toEqual(["Mira","Bo","Pip"]);await page.evaluate(()=>eval("Object.values(quests).forEach(q=>q.state='complete');completeDay()"));await page.keyboard.press("Enter");expect(await page.evaluate(()=>eval("day"))).toBe(2);expect(await page.evaluate(()=>eval("npcs.map(n=>n.n)"))).toContain("Lark");
  await page.evaluate(()=>eval("coins=20;inventory.push('lantern');quests.lark.state='active';player={...npcs.find(n=>n.n==='Lark')};update();talk(npcs.find(n=>n.n==='Lark'))"));await page.keyboard.press("Enter");await page.keyboard.press("Enter");await page.keyboard.press("Enter");expect(await page.evaluate(()=>eval("inventory.includes('lantern')"))).toBe(true);expect(await page.evaluate(()=>eval("day"))).toBe(3);
  expect(await page.evaluate(()=>eval("npcs.map(n=>n.n)"))).toContain("Orla");await page.evaluate(()=>eval("Object.values(quests).forEach(q=>q.state='complete');completeDay()"));await page.keyboard.press("Enter");expect(await page.evaluate(()=>eval("day"))).toBe(4);expect(await page.evaluate(()=>eval("npcs.map(n=>n.n)"))).toEqual(["Bo","Mira","Tansy","Gus"]);
  await page.evaluate(()=>eval("inventory.push('basket');Object.values(quests).forEach(q=>q.state='complete');completeDay()"));await page.keyboard.press("Enter");expect(await page.evaluate(()=>eval("day"))).toBe(5);expect(await page.locator("#day-goal").textContent()).toContain("Invite");expect(await page.evaluate(()=>eval("inventory.includes('basket')"))).toBe(true);await page.close();
});

test("Village Games NPC walking stays bounded and stabilizes for interaction",async()=>{
  const page=await browser.newPage({viewport:{width:900,height:800}});await page.goto(url("village-games"));await page.locator("#start button").click();await page.evaluate(()=>eval("player={x:620,y:450};for(let i=0;i<1000;i++)tickNPCs(2)"));
  const walkers=await page.evaluate(()=>eval("npcs.map(n=>({x:n.x,y:n.y,hx:n.homeX,hy:n.homeY}))")) as {x:number,y:number,hx:number,hy:number}[];for(const n of walkers){expect(n.x).toBeGreaterThanOrEqual(Math.max(28,n.hx-38));expect(n.x).toBeLessThanOrEqual(Math.min(612,n.hx+38));expect(n.y).toBeGreaterThanOrEqual(Math.max(118,n.hy-30));expect(n.y).toBeLessThanOrEqual(Math.min(418,n.hy+30))}
  await page.evaluate(()=>eval("player={x:npcs[0].x,y:npcs[0].y};update()"));const before=await page.evaluate(()=>eval("[npcs[0].x,npcs[0].y]"));await page.keyboard.press("Space");await page.evaluate(()=>eval("tickNPCs(40)"));expect(await page.evaluate(()=>eval("[npcs[0].x,npcs[0].y]"))).toEqual(before);await page.close();
});

test("Citadel and Skyline show the joypad only for coarse pointers and fit short landscape",async()=>{
  for(const id of ["citadel-strike","skyline-sprint"]){
    const touch=await browser.newContext({viewport:{width:844,height:390},hasTouch:true,isMobile:true});const touchPage=await touch.newPage();await touchPage.goto(url(id));const pad=touchPage.locator(".touch-gamepad");await expect(pad.isVisible()).resolves.toBe(true);const box=(await pad.boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(0);expect(box.y).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(844);expect(box.y+box.height).toBeLessThanOrEqual(390);for(const button of await pad.locator("button").all()){const target=(await button.boundingBox())!;expect(target.width).toBeGreaterThanOrEqual(44);expect(target.height).toBeGreaterThanOrEqual(44)}await touch.close();
    const fine=await browser.newPage({viewport:{width:900,height:700}});await fine.goto(url(id));await expect(fine.locator(".touch-gamepad").isHidden()).resolves.toBe(true);await fine.close();
  }
});

test("Citadel analogue movement, simultaneous fire, secondary parity, and cleanup are pointer-safe",async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});const page=await context.newPage();await page.goto(url("citadel-strike"));await page.locator("#start button").tap();await page.evaluate(()=>eval("enemies.forEach(e=>e.cooldown=999)"));
  const pad=page.locator(".analogue"),box=(await pad.boundingBox())!,cx=box.x+box.width/2,cy=box.y+box.height/2;await pad.dispatchEvent("pointerdown",{pointerId:11,pointerType:"touch",clientX:cx,clientY:cy,bubbles:true});await pad.dispatchEvent("pointermove",{pointerId:11,pointerType:"touch",clientX:cx+box.width*.42,clientY:cy-box.height*.42,bubbles:true});const input=await page.evaluate(()=>eval("({...analogue})")) as {pointerId:number,x:number,y:number};expect(input.pointerId).toBe(11);expect(input.x).toBeGreaterThan(.4);expect(input.y).toBeLessThan(-.4);
  const before=await page.evaluate(()=>eval("({x:player.x,y:player.y,yaw:player.yaw})")) as {x:number,y:number,yaw:number};await page.evaluate(()=>eval("update(.12);update(.12)"));const moved=await page.evaluate(()=>eval("({x:player.x,y:player.y,yaw:player.yaw})")) as {x:number,y:number,yaw:number};expect(Math.hypot(moved.x-before.x,moved.y-before.y)).toBeGreaterThan(.2);expect(moved.yaw).toBeGreaterThan(before.yaw);
  const fire=page.locator('[data-action="primary"]');await fire.dispatchEvent("pointerdown",{pointerId:22,pointerType:"touch",bubbles:true});expect(await page.evaluate(()=>eval("shots"))).toBe(1);expect(await page.evaluate(()=>eval("analogue.pointerId"))).toBe(11);await fire.dispatchEvent("pointercancel",{pointerId:22,pointerType:"touch",bubbles:true});expect(await page.evaluate(()=>eval("analogue.pointerId"))).toBe(11);
  const secondary=page.locator('[data-action="secondary"]');await secondary.dispatchEvent("pointerdown",{pointerId:23,pointerType:"touch",bubbles:true});await secondary.dispatchEvent("pointerup",{pointerId:23,pointerType:"touch",bubbles:true});await page.keyboard.press("b");expect(await page.evaluate(()=>eval("secondaryActions"))).toBe(2);
  await pad.dispatchEvent("pointercancel",{pointerId:11,pointerType:"touch",bubbles:true});expect(await page.evaluate(()=>eval("({id:analogue.pointerId,x:analogue.x,y:analogue.y})"))).toEqual({id:null,x:0,y:0});await page.evaluate(()=>window.dispatchEvent(new Event("blur")));expect(await page.evaluate(()=>eval("keys.size"))).toBe(0);await context.close();
});

test("Skyline analogue strength drives continuous running with simultaneous jump and isolated release",async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});const page=await context.newPage();await page.goto(url("skyline-sprint"));await page.locator("#start button").tap();await page.evaluate(()=>eval("player.x=42;player.y=520;player.vx=player.vy=0"));
  const pad=page.locator(".analogue"),box=(await pad.boundingBox())!,cx=box.x+box.width/2,cy=box.y+box.height/2;await pad.dispatchEvent("pointerdown",{pointerId:31,pointerType:"touch",clientX:cx,clientY:cy,bubbles:true});await pad.dispatchEvent("pointermove",{pointerId:31,pointerType:"touch",clientX:cx+box.width*.46,clientY:cy,bubbles:true});expect(await page.evaluate(()=>eval("analogue.x"))).toBeGreaterThan(.7);await page.evaluate(()=>eval("update(.08,performance.now());update(.08,performance.now())"));const firstX=await page.evaluate(()=>eval("player.x"));expect(firstX).toBeGreaterThan(45);
  const jump=page.locator('[data-action="primary"]');await jump.dispatchEvent("pointerdown",{pointerId:32,pointerType:"touch",bubbles:true});expect(await page.evaluate(()=>eval("player.vy"))).toBeLessThan(-500);expect(await page.evaluate(()=>eval("analogue.pointerId"))).toBe(31);await jump.dispatchEvent("lostpointercapture",{pointerId:32,pointerType:"touch",bubbles:true});expect(await page.evaluate(()=>eval("analogue.pointerId"))).toBe(31);await page.evaluate(()=>eval("update(.05,performance.now())"));expect(await page.evaluate(()=>eval("player.x"))).toBeGreaterThan(firstX);
  const secondary=page.locator('[data-action="secondary"]');await secondary.dispatchEvent("pointerdown",{pointerId:33,pointerType:"touch",bubbles:true});await secondary.dispatchEvent("pointerup",{pointerId:33,pointerType:"touch",bubbles:true});await page.keyboard.press("B");expect(await page.evaluate(()=>eval("secondaryActions"))).toBe(2);await pad.dispatchEvent("lostpointercapture",{pointerId:31,pointerType:"touch",bubbles:true});expect(await page.evaluate(()=>eval("({id:analogue.pointerId,x:analogue.x,vx:player.vx})"))).toEqual({id:null,x:0,vx:0});await context.close();
});

test("Skyline keeps its ground and player above the mobile controls zone",async()=>{
  for(const viewport of [{width:390,height:844},{width:844,height:390}]){
    const context=await browser.newContext({viewport,hasTouch:true,isMobile:true});const page=await context.newPage();await page.goto(url("skyline-sprint"));await page.locator("#start button").tap();await page.evaluate(()=>eval("draw()"));
    const canvas=(await page.locator("canvas").boundingBox())!,controls=(await page.locator(".touch-gamepad").boundingBox())!,rise=await page.evaluate(()=>eval("playfieldRise()")) as number,scale=canvas.height/640;
    const ground=canvas.y+(560-rise)*scale,playerBottom=canvas.y+(500+40-rise)*scale;
    expect(rise).toBeGreaterThan(0);expect(ground).toBeLessThanOrEqual(controls.y-55);expect(playerBottom).toBeLessThan(controls.y);
    for(const target of await page.locator(".analogue,.game-action").all()){const box=(await target.boundingBox())!;expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(viewport.width);expect(box.y+box.height).toBeLessThanOrEqual(viewport.height)}
    await context.close();
  }
});

test("Arcade Cabinet launches all three games and returns to its menu",async()=>{
  const context=await browser.newContext({viewport:{width:320,height:720},hasTouch:true,isMobile:true});const page=await context.newPage();await page.goto(url("arcade-cabinet"));
  for(const name of ["snake","maze","tennis"]){await page.locator(`[data-game=${name}]`).dispatchEvent("click");await expect(page.locator("#start").isVisible()).resolves.toBe(true);await page.locator("#start button").dispatchEvent("click");await expect(page.locator("canvas").isVisible()).resolves.toBe(true);await page.keyboard.press("ArrowRight");await page.locator("#restart").dispatchEvent("click");await page.locator("#back").dispatchEvent("click");await expect(page.locator("#menu").isVisible()).resolves.toBe(true);}
  await context.close();
},10_000);

test("Minotaur Maze exposes chase-and-collect state and directional swipe",async()=>{
  const context=await browser.newContext({viewport:{width:320,height:720},hasTouch:true,isMobile:true});const page=await context.newPage();await page.goto(url("arcade-cabinet"));await page.locator("[data-game=maze]").dispatchEvent("click");await page.locator("#start button").dispatchEvent("click");
  await page.evaluate(()=>eval("clearInterval(timer);state.m=[14,9]"));const canvas=page.locator("canvas"),box=(await canvas.boundingBox())!;await canvas.dispatchEvent("pointerdown",{pointerId:2,pointerType:"touch",clientX:box.x+80,clientY:box.y+80,bubbles:true});await canvas.dispatchEvent("pointerup",{pointerId:2,pointerType:"touch",clientX:box.x+145,clientY:box.y+80,bubbles:true});expect(await page.evaluate(()=>eval("[...state.dir]"))).toEqual([1,0]);
  await page.evaluate(()=>eval("stepMaze();stepMaze()"));expect(await page.evaluate(()=>eval("[...state.p]"))).toEqual([3,1]);await page.evaluate(()=>eval("stepMaze();stepMaze();stepMaze();stepMaze();stepMaze();stepMaze();stepMaze();stepMaze();stepMaze();stepMaze();stepMaze();stepMaze();stepMaze();stepMaze()"));expect(await page.evaluate(()=>eval("[...state.p]"))).toEqual([14,1]);await context.close();
});

test("Arcade Cabinet waits for confirmation and starts each game with Space or touch",async()=>{
  const context=await browser.newContext({viewport:{width:320,height:720},hasTouch:true,isMobile:true});const page=await context.newPage();await page.goto(url("arcade-cabinet"));
  for(const name of ["snake","maze","tennis"]){await page.locator(`[data-game=${name}]`).dispatchEvent("click");expect(await page.evaluate(()=>eval("running"))).toBe(false);await page.waitForTimeout(150);expect(await page.evaluate(()=>eval("running"))).toBe(false);await page.keyboard.press("Space");expect(await page.evaluate(()=>eval("running"))).toBe(true);await page.locator("#back").dispatchEvent("click")}
  await page.locator("[data-game=tennis]").dispatchEvent("click");await page.locator("#start").dispatchEvent("pointerup",{pointerType:"touch"});expect(await page.evaluate(()=>eval("running"))).toBe(true);await context.close();
});

test("Tennis keyboard and held touch controls move continuously and stop on release",async()=>{
  const context=await browser.newContext({viewport:{width:320,height:720},hasTouch:true,isMobile:true});const page=await context.newPage();await page.goto(url("arcade-cabinet"));await page.locator("[data-game=tennis]").dispatchEvent("click");await page.keyboard.press("Space");
  const initial=await page.evaluate(()=>eval("state.px"));await page.keyboard.down("ArrowRight");await page.evaluate(()=>eval("tennisFrameTime-=120"));await page.evaluate(()=>new Promise(requestAnimationFrame));await page.keyboard.up("ArrowRight");const keyboardMoved=await page.evaluate(()=>eval("state.px"));expect(keyboardMoved-initial).toBeGreaterThan(55);await page.waitForTimeout(80);expect(await page.evaluate(()=>eval("state.px"))).toBe(keyboardMoved);
  const canvas=page.locator("canvas"),box=(await canvas.boundingBox())!;await page.mouse.move(box.x+20,box.y+box.height/2);await page.mouse.down();expect(await page.evaluate(()=>eval("tennisDirection"))).toBe(-1);await page.evaluate(()=>eval("tennisFrameTime-=120"));await page.evaluate(()=>new Promise(requestAnimationFrame));const touchMoved=await page.evaluate(()=>eval("state.px"));expect(touchMoved).toBeLessThan(keyboardMoved-90);await page.mouse.up();expect(await page.evaluate(()=>eval("tennisDirection"))).toBe(0);await page.waitForTimeout(80);expect(await page.evaluate(()=>eval("state.px"))).toBe(touchMoved);await context.close();
});

test("Snake uses a slower tick, wraps both axes, and still resets on self collision",async()=>{
  const page=await browser.newPage({viewport:{width:900,height:800}});await page.addInitScript(()=>{const nativeSetInterval=window.setInterval;Object.defineProperty(window,"intervalDelays",{value:[]});window.setInterval=((handler:TimerHandler,timeout?:number,...args:unknown[])=>{(window as unknown as {intervalDelays:number[]}).intervalDelays.push(timeout??0);return nativeSetInterval(handler,timeout,...args)}) as typeof window.setInterval});await page.goto(url("arcade-cabinet"));await page.locator("[data-game=snake]").click();await page.keyboard.press("Space");expect(await page.evaluate(()=>(window as unknown as {intervalDelays:number[]}).intervalDelays)).toContain(135);
  await page.evaluate(()=>eval("clearInterval(timer);state.body=[[19,5],[18,5]];state.dir=[1,0];state.food=[10,10];stepSnake()"));expect(await page.evaluate(()=>eval("[...state.body[0]]"))).toEqual([0,5]);await page.evaluate(()=>eval("state.body=[[4,0],[4,1]];state.dir=[0,-1];state.food=[10,10];stepSnake()"));expect(await page.evaluate(()=>eval("[...state.body[0]]"))).toEqual([4,14]);
  await page.evaluate(()=>eval("state.body=[[5,5],[5,6],[4,6],[4,5]];state.dir=[0,1];state.food=[10,10];stepSnake();clearInterval(timer)"));expect(await page.evaluate(()=>eval("state.body"))).toEqual([[8,6],[7,6]]);await page.close();
});
