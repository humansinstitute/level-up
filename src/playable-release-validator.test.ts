import { expect, test } from "bun:test";
import type { RankedProposal } from "./loop";
import { launchPlayableReleaseBrowser, validatePlayableReleaseHtml } from "./playable-release-validator";

function proposal(): RankedProposal {
  return {
    id: "committed",
    roundId: "round",
    position: 1,
    rank: 1,
    votes: 3,
    firstPlaceVotes: 1,
    secondPlaceVotes: 0,
    thirdPlaceVotes: 0,
    title: "Crystal Gates",
    playerChange: "Add Crystal Gates during play",
    implementationScope: "Change the playable arena and status text.",
    acceptanceCriteria: ["Crystal Gates are visible", "The game still responds to movement"],
    ideaReferences: [1],
  };
}

function playableHtml(title = "Maze", color = "#d7f64a"): string {
  return `<!doctype html><html><head><title>${title}</title><style>body{margin:0}main{text-align:center}canvas{width:120px;height:120px;background:#111}</style></head><body><main><h1>${title}</h1><canvas width="120" height="120"></canvas><p id="s">Ready</p><button data-d="1,0">Move</button></main><script>const c=document.querySelector('canvas'),g=c.getContext('2d');let x=10,timer;function draw(){g.fillStyle='#111';g.fillRect(0,0,120,120);g.fillStyle='${color}';g.fillRect(x,45,24,24)}function step(){x=(x+8)%96;draw()}function start(){s.textContent='${title} running';clearInterval(timer);timer=setInterval(step,80);draw()}function move(){x=(x+16)%96;s.textContent='${title} moved';draw()}document.querySelector('[data-d]').onclick=move;addEventListener('keydown',move);start();</script></body></html>`;
}

const brokenOneLineCommentHtml = "<!doctype html><html><head><title>Crystal Gates</title></head><body><main><h1>Crystal Gates</h1><canvas width=\"120\" height=\"120\"></canvas><p id=\"s\">Ready</p><button data-d=\"1,0\">Move</button></main><script>const c=document.querySelector('canvas'),g=c.getContext('2d');const powerUpDuration=10000; // 10 seconds function start(){g.fillStyle='#6be3ff';g.fillRect(0,0,120,120)}function draw(){g.fillStyle='#ff8a3d';g.fillRect(10,10,20,20)}start();draw();</script></body></html>";

test("browser playability validation catches blank one-line comment releases", async () => {
  const browser = await launchPlayableReleaseBrowser();
  try {
    const base = playableHtml();
    const changed = playableHtml("Crystal Gates", "#6be3ff");
    const evidence = await validatePlayableReleaseHtml({ sourceHtml: base, gameHtml: changed, releaseHtml: changed, proposal: proposal() }, browser);
    expect(evidence.renderedPixels).toBeGreaterThan(0);
    expect(evidence.changedPixels).toBeGreaterThan(0);
    expect(evidence.visibleControls).toBeGreaterThan(0);

    await expect(validatePlayableReleaseHtml({ sourceHtml: base, gameHtml: brokenOneLineCommentHtml, releaseHtml: brokenOneLineCommentHtml, proposal: proposal() }, browser)).rejects.toThrow("Generated game did not draw anything");
  } finally {
    await browser.close().catch(() => undefined);
  }
}, 20_000);
