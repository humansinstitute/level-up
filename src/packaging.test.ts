import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the production image includes committed public assets in the Vite build", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const publicCopy = dockerfile.indexOf("COPY public ./public");
  const productionBuild = dockerfile.indexOf("RUN bun run build");

  expect(publicCopy).toBeGreaterThan(-1);
  expect(productionBuild).toBeGreaterThan(publicCopy);
});
