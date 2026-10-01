import { describe, expect, test } from "bun:test";
import QRCode from "qrcode";
import { buildInviteUrl, clearInviteFragment, parseInviteSecret, pendingInviteFromLocation } from "./invites";
import { groupCommandEligible, normalizeAdminProjectsPayload, signedOutPath } from "./App";

const SECRET = "AbCdEf0123456789_-AbCdEf0123456789_-AbCdE12";
const SHORT_CODE = "kiBs0H";

describe("invite URL behavior", () => {
  test("keeps a pending invite in the URL across logout and refresh", () => { expect(signedOutPath(SECRET)).toBe(`/#join=${encodeURIComponent(SECRET)}`); });
  test("normalizes previous and current admin project shapes and exposes only state-valid group actions", () => {
    const base={id:"project",teamId:"team",name:"Game",phase:"selecting_template",selectedTemplateId:null,stablePlayUrl:null,createdAt:1,teamName:"Team",joinedCount:2,connectedCount:null,activeInvite:true,captain:null,failure:null,round:null};
    const [legacy,current]=normalizeAdminProjectsPayload({projects:[base,{...base,id:"current",selectionStartedAt:10,selectionClosedAt:null}]});
    expect(legacy).toMatchObject({selectionStartedAt:0,selectionClosedAt:null});
    expect(groupCommandEligible(legacy!,"start_voting")).toBe(true);
    expect(groupCommandEligible(current!,"start_voting")).toBe(false);
    expect(groupCommandEligible(current!,"extend_voting")).toBe(true);
    expect(groupCommandEligible(current!,"start_first_brainstorm")).toBe(false);
  });
  test("builds and parses an opaque fragment URL or a bare secret", () => {
    const url = buildInviteUrl("https://example.test/some/path", SECRET);
    expect(url).toBe(`https://example.test/#join=${SECRET}`);
    expect(parseInviteSecret(url)).toBe(SECRET);
    expect(parseInviteSecret(`  ${SECRET}  `)).toBe(SECRET);
    expect(parseInviteSecret("https://example.test/?join=not-a-fragment")).toBeNull();
    expect(pendingInviteFromLocation({ hash: `#join=${SECRET}` } as Location)).toBe(SECRET);
    expect(parseInviteSecret(SHORT_CODE)).toBe(SHORT_CODE);
    expect(parseInviteSecret(SHORT_CODE.toLowerCase())).toBe(SHORT_CODE.toLowerCase());
    expect(parseInviteSecret("kiBs0H7")).toBeNull();
  });

  test("clears only the fragment after a completed join", () => {
    let replacement = "";
    clearInviteFragment({ replaceState: (_data, _unused, url) => { replacement = String(url); } } as History, { pathname: "/", search: "?ref=table" } as Location);
    expect(replacement).toBe("/?ref=table");
  });

  test("encodes the exact invite URL into a mobile-size high-correction QR", async () => {
    const url = buildInviteUrl("https://example.test", SECRET);
    const qr = QRCode.create(url, { errorCorrectionLevel: "H" });
    const encoded = qr.segments.map((segment) => typeof segment.data === "string"
      ? segment.data
      : new TextDecoder().decode(segment.data)).join("");
    expect(encoded).toBe(url);
    expect(qr.modules.size).toBeGreaterThanOrEqual(21);
    const image = await QRCode.toDataURL(url, { errorCorrectionLevel: "H", margin: 4, width: 256 });
    expect(image).toStartWith("data:image/png;base64,");
  });
});
