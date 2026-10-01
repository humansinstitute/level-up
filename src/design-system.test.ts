import { describe, expect, test } from "bun:test";

const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
const app = await Bun.file(new URL("./App.tsx", import.meta.url)).text();

function token(name: string): string {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"));
  if (!match?.[1]) throw new Error(`Missing design token ${name}`);
  return match[1];
}

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

describe("Level Up semantic colour system", () => {
  test("approved foreground and accent pairs remain WCAG AA", () => {
    expect(contrast(token("--text-on-light"), token("--surface-light"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("--text-muted-on-light"), token("--surface-light"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("--text-on-dark"), token("--surface-dark"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("--text-muted-on-dark"), token("--surface-dark"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("--accent-on-dark"), token("--surface-dark"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("--accent-on-light"), token("--surface-light"))).toBeGreaterThanOrEqual(4.5);
  });

  test("reusable surfaces declare their matching semantic foreground", () => {
    const requiredPairs = [
      /\.loop-panel, \.feedback-context\s*\{[^}]*background:\s*var\(--surface-light\);[^}]*color:\s*var\(--text-on-light\);/,
      /\.feedback-context\s*\{[^}]*background:\s*#dff5e8;[^}]*color:\s*var\(--text-on-light\);/,
      /\.proposal-card, \.brief-grid article\s*\{[^}]*background:\s*white;[^}]*color:\s*var\(--text-on-light\);/,
      /\.conversation-bubble\s*\{[^}]*background:\s*var\(--surface-dark\);[^}]*color:\s*var\(--text-on-dark\);/,
      /\.join-choice\s*\{[^}]*background:\s*#f0dfbb;[^}]*color:\s*var\(--text-on-light\);/,
      /\.invite-panel\s*\{[^}]*background:\s*#ead7ae;[^}]*color:\s*var\(--text-on-light\);/,
      /\.ranking-panel\s*\{[^}]*background:\s*#eee0bf;[^}]*color:\s*var\(--text-on-light\);/,
      /\.build-panel li\.active\s*\{[^}]*background:\s*#fff1a8;[^}]*color:\s*var\(--text-on-light\);/,
      /\.build-panel li\.complete\s*\{[^}]*background:\s*#dff5e8;[^}]*color:\s*var\(--text-on-light\);/,
    ];
    for (const pair of requiredPairs) expect(css).toMatch(pair);
  });

  test("requirement cards keep readable responsive columns", () => {
    expect(css).toMatch(/\.proposal-grid\s*\{\s*grid-template-columns:\s*1fr;\s*\}/);
    expect(css).toMatch(/@media \(min-width:\s*640px\)\s*\{\s*\.proposal-grid\s*\{\s*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\);/);
    expect(css).toMatch(/@media \(min-width:\s*1180px\)\s*\{\s*\.proposal-grid\s*\{\s*grid-template-columns:\s*repeat\(3,minmax\(0,1fr\)\);/);
  });

  test("shared form and viewport primitives protect mobile focus", () => {
    expect(css).toMatch(/body\s*\{[^}]*min-width:\s*0;[^}]*overflow-x:\s*clip;/);
    expect(css).toMatch(/\.app-shell\s*\{[^}]*overflow-x:\s*clip;[^}]*overflow-y:\s*auto;/);
    expect(css).toContain("select:focus-visible");
    expect(css).toMatch(/input, textarea, select, button, a, summary\s*\{[^}]*scroll-margin-block:/);
    expect(css).toMatch(/input, textarea\s*\{[^}]*font:\s*500 16px/);
    expect(css).toMatch(/\.compact-button\s*\{[^}]*min-height:\s*52px;/);
    expect(app).not.toContain("autoFocus");
  });
});
