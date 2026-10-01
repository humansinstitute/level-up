import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InvitePanel, type Team } from "./App";

describe("persistent team invite panel", () => {
  test("renders the scan, current live-origin link, and copy action for a freshly loaded member", () => {
    const team: Team = { id: "team", sessionId: "session", name: "Pixel Crew", phase: "lobby", isOrganiser: false, members: [], projects: [] };
    const html = renderToStaticMarkup(<InvitePanel team={team} invite={{ secret: "kiBs0H", url: "https://levelup.example/#join=kiBs0H", expiresAt: null }} busy={false} onRotate={() => undefined} />);
    expect(html).toContain("Scan to join");
    expect(html).toContain("https://levelup.example/#join=kiBs0H");
    expect(html).toContain("Copy link");
    expect(html).not.toContain("Create share invite");
    expect(html).not.toContain(">Rotate<");
  });
});
