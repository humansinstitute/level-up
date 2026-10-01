import { describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools";
import type { CachedProfileRecord } from "./client-db";
import { buildProfileTemplate, httpsUrl, ProfileService, profileFromEvent, safeMetadata, selectLatestProfile, type ProfileCache, type RelayTransport } from "./profiles";
import type { NostrSigner } from "./signer";

function profileEvent(secret: Uint8Array, createdAt: number, metadata: unknown): Event {
  return finalizeEvent({ kind: 0, created_at: createdAt, tags: [], content: JSON.stringify(metadata) }, secret);
}

function cache(initial?: CachedProfileRecord): ProfileCache & { record?: CachedProfileRecord } {
  return {
    record: initial,
    get: async function () { return this.record; },
    put: async function (record) { this.record = record; },
  };
}

describe("Nostr profiles", () => {
  test("selects the newest valid kind-0 event and rejects wrong authors and signatures", () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const old = profileEvent(secret, 10, { name: "Old" });
    const newest = profileEvent(secret, 20, { display_name: "Newest" });
    const wrongAuthor = profileEvent(generateSecretKey(), 30, { name: "Wrong" });
    const tampered = { ...profileEvent(secret, 40, { name: "Tampered" }), content: "{}" };
    expect(selectLatestProfile([old, wrongAuthor, tampered, newest], pubkey)?.id).toBe(newest.id);
    expect(selectLatestProfile([{ ...newest, content: "x".repeat(16_001) }], pubkey)).toBeUndefined();
  });

  test("sanitizes bounded metadata, name precedence, and HTTPS-only avatars", () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const event = profileEvent(secret, 10, { display_name: "  Display\nName ", name: "Alias", picture: "https://example.com/a.png", about: "hello", extra: "discard" });
    expect(profileFromEvent(pubkey, event)).toMatchObject({ displayName: "Display Name", picture: "https://example.com/a.png", about: "hello" });
    expect(profileFromEvent(pubkey, profileEvent(secret, 11, { name: "Alias" })).displayName).toBe("Alias");
    expect(httpsUrl("http://example.com/a.png")).toBeUndefined();
    expect(httpsUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeMetadata({ name: "n".repeat(200), extra: "no" })).toEqual({ name: "n".repeat(80) });
  });

  test("preserves safe metadata fields while updating edited fields", () => {
    const pubkey = "1".repeat(64);
    const existing = profileFromEvent(pubkey);
    existing.metadata = { name: "handle", website: "https://example.com/", picture: "https://old.example/a.png", extra: "no" };
    const template = buildProfileTemplate(existing, { displayName: "New", about: "About" }, 2_000);
    expect(JSON.parse(template.content)).toEqual({ name: "handle", website: "https://example.com/", display_name: "New", about: "About" });
    expect(JSON.parse(template.content)).not.toHaveProperty("picture");
  });

  test("falls back to a verified cached profile when bounded relay lookup fails", async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const event = profileEvent(secret, 10, { display_name: "Cached" });
    const store = cache({ pubkey, event: JSON.stringify(event), fetchedAt: 123 });
    const transport: RelayTransport = { lookup: async (_pubkey, timeout) => { expect(timeout).toBe(4_500); throw new Error("offline"); }, publish: async () => ({ accepted: [], failed: [] }) };
    expect((await new ProfileService(transport, store).load(pubkey)).displayName).toBe("Cached");
  });

  test("retains a verified signed update when relays partially or wholly fail", async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const signer: NostrSigner = { kind: "device", getPublicKey: async () => pubkey, signEvent: async (event) => finalizeEvent(event, secret) };
    const transport: RelayTransport = { lookup: async () => [], publish: async (_event, timeout) => { expect(timeout).toBe(4_500); return { accepted: ["wss://one"], failed: ["wss://two"] }; } };
    const result = await new ProfileService(transport, cache()).publish(signer, undefined, { displayName: "Player", about: "" });
    expect(result.profile.displayName).toBe("Player");
    expect(result.accepted).toHaveLength(1);
    const offline: RelayTransport = { ...transport, publish: async () => ({ accepted: [], failed: ["all"] }) };
    const offlineResult=await new ProfileService(offline, cache()).publish(signer, undefined, { displayName: "Player", about: "" });
    expect(offlineResult.accepted).toEqual([]);
    expect(offlineResult.profile.event?.pubkey).toBe(pubkey);
  });
});
