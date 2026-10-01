import { describe, expect, test } from "bun:test";
import { nip19 } from "nostr-tools";
import { memberDisplayName, mergeTeamLists, type TeamMember } from "./App";
import { generatedNickname } from "./player-identity";
import type { PublicProfile } from "./profiles";

describe("profile UI helpers", () => {
  const pubkey="1".repeat(64);
  const member: TeamMember = { accountId: "a", npub: nip19.npubEncode(pubkey), role: "player" };

  test("lobby member labels prefer resolved profile names", () => {
    const profile = { displayName: "Ada", pubkey: "1".repeat(64), npub: member.npub, metadata: {} } as PublicProfile;
    expect(memberDisplayName(member, profile, 1)).toBe("Ada");
    expect(memberDisplayName(member, undefined, 1)).toBe(generatedNickname(pubkey));
  });

  test("keeps remembered memberships when a team-list refresh is empty or stale", () => {
    const remembered = [{ id: "current", name: "Current team" }, { id: "older", name: "Older team" }];
    expect(mergeTeamLists([], remembered)).toEqual(remembered);
    expect(mergeTeamLists([{ id: "current", name: "Updated team" }], remembered)).toEqual([
      { id: "current", name: "Updated team" },
      { id: "older", name: "Older team" },
    ]);
  });
});
