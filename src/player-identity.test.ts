import { describe, expect, test } from "bun:test";
import { avatarDataUri, avatarSpec, generatedNickname } from "./player-identity";

describe("workshop player identity", () => {
  test("generates stable curated two-word nicknames", () => {
    expect(generatedNickname("same seed")).toBe(generatedNickname("same seed"));
    expect(generatedNickname("same seed")).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(generatedNickname("another seed")).not.toBe(generatedNickname("same seed"));
  });

  test("derives a stable local branded avatar without a remote URL", () => {
    expect(avatarSpec("a".repeat(64))).toEqual(avatarSpec("a".repeat(64)));
    expect(avatarDataUri("a".repeat(64))).toStartWith("data:image/svg+xml,");
    expect(avatarDataUri("a".repeat(64))).not.toContain("example.com");
  });
});
