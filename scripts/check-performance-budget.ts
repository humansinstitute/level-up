import { gzipSync } from "node:zlib";
import { readdir } from "node:fs/promises";

const outputRoot = new URL("../.validation-dist/", import.meta.url);
const index = await Bun.file(new URL("index.html", outputRoot)).text();
const initialAssets = [...index.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]!);

if (!initialAssets.length) throw new Error("Performance budget could not find initial JS/CSS assets.");

let initialJavaScriptBytes = 0;
let initialJavaScriptGzipBytes = 0;
let initialCssBytes = 0;
for (const relativePath of initialAssets) {
  const bytes = new Uint8Array(await Bun.file(new URL(relativePath.replace(/^\//, ""), outputRoot)).arrayBuffer());
  if (relativePath.endsWith(".js")) {
    initialJavaScriptBytes += bytes.byteLength;
    initialJavaScriptGzipBytes += gzipSync(bytes, { level: 9 }).byteLength;
  } else {
    initialCssBytes += bytes.byteLength;
  }
}

const assetNames = await readdir(new URL("assets/", outputRoot));
const initialNames = new Set(initialAssets.map((path) => path.split("/").at(-1)));
const asyncJavaScriptChunks = assetNames.filter((name) => name.endsWith(".js") && !initialNames.has(name));
if (!asyncJavaScriptChunks.length) throw new Error("QR generation must remain outside the initial application bundle.");

const budgets = {
  // Shared verified profile hydration adds the signed-event boundary and friendly identity fallback.
  initialJavaScriptBytes: 556_000,
  initialJavaScriptGzipBytes: 176_000,
  initialCssBytes: 80_000,
};
if (initialJavaScriptBytes > budgets.initialJavaScriptBytes) throw new Error(`Initial JavaScript ${initialJavaScriptBytes} exceeds ${budgets.initialJavaScriptBytes} bytes.`);
if (initialJavaScriptGzipBytes > budgets.initialJavaScriptGzipBytes) throw new Error(`Initial gzip JavaScript ${initialJavaScriptGzipBytes} exceeds ${budgets.initialJavaScriptGzipBytes} bytes.`);
if (initialCssBytes > budgets.initialCssBytes) throw new Error(`Initial CSS ${initialCssBytes} exceeds ${budgets.initialCssBytes} bytes.`);

console.log(JSON.stringify({ initialJavaScriptBytes, initialJavaScriptGzipBytes, initialCssBytes, asyncJavaScriptChunks }));
