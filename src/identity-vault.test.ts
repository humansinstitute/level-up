import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, verifyEvent, type EventTemplate } from "nostr-tools";
import { AuthService } from "./auth";
import type { EncryptedIdentityRecord, IdentityUnlockKeyRecord } from "./client-db";
import { IdentityVault, type IdentityStore } from "./identity-vault";
import { DeviceSigner, Nip07Signer } from "./signer";

function memoryStore(): IdentityStore & { value?: EncryptedIdentityRecord; unlockKey?: IdentityUnlockKeyRecord } {
  return {
    available: () => true,
    get: async function () { return this.value; },
    put: async function (record) { this.value = structuredClone(record); },
    getUnlockKey: async function () { return this.unlockKey; },
    putUnlockKey: async function (record) { this.unlockKey = structuredClone(record); },
    deleteUnlockKey: async function () { this.unlockKey = undefined; },
    delete: async function () { this.value = undefined; },
    replacePair: async function (identity, unlockKey) { this.value = structuredClone(identity); this.unlockKey = structuredClone(unlockKey); },
    deletePair: async function () { this.value = undefined; this.unlockKey = undefined; },
  };
}

const template: EventTemplate = { kind: 27235, created_at: 1_756_860_000, content: "Level Up login", tags: [["purpose", "level-up-login"]] };

function b64(bytes:Uint8Array){return btoa(String.fromCharCode(...bytes));}
async function legacyRecord(passphrase:string):Promise<EncryptedIdentityRecord>{
  const secret=generateSecretKey(),salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const material=await crypto.subtle.importKey("raw",new TextEncoder().encode(passphrase),"PBKDF2",false,["deriveKey"]);
  const key=await crypto.subtle.deriveKey({name:"PBKDF2",hash:"SHA-256",salt,iterations:310_000},material,{name:"AES-GCM",length:256},false,["encrypt"]);
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv:iv as BufferSource},key,secret as BufferSource));
  return{id:"device",formatVersion:1,kdf:"PBKDF2-SHA-256",iterations:310_000,salt:b64(salt),iv:b64(iv),ciphertext:b64(encrypted),pubkey:getPublicKey(secret),createdAt:1};
}

describe("device identity vault", () => {
  test("refuses account operations when secure persistence is unavailable", async () => {
    const store = memoryStore();
    store.available = () => false;
    const vault = new IdentityVault(store);
    await expect(vault.create()).rejects.toThrow("IndexedDB is unavailable");
    await expect(vault.unlock("correct horse battery staple")).rejects.toThrow("IndexedDB is unavailable");
  });

  test("generates an encrypted-at-rest identity and auto-unlocks it round-trip", async () => {
    const store = memoryStore();
    const vault = new IdentityVault(store);
    const pubkey = await vault.create();
    const record = store.value!;

    expect(record).toMatchObject({ id: "device", formatVersion: 2, cipher: "AES-256-GCM", pubkey });
    expect(store.unlockKey).toMatchObject({ id: "device", formatVersion: 1 });
    expect(atob(record.iv)).toHaveLength(12);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("nsec");
    expect(Object.keys(record)).not.toContain("secret");
    expect(Object.keys(record)).not.toContain("privateKey");

    vault.lock();
    expect(vault.publicKey()).toBeNull();
    expect(await vault.autoUnlock()).toBe(pubkey);
    await expect(vault.create()).rejects.toThrow("already exists");
  });

  test("signs valid login and kind-0 events, then forgets stored and memory state", async () => {
    const store = memoryStore();
    const vault = new IdentityVault(store);
    const pubkey = await vault.create();
    const signer = new DeviceSigner(vault);
    for (const eventTemplate of [template, { kind: 0, created_at: 1_756_860_001, content: "{}", tags: [] }]) {
      const event = await signer.signEvent(eventTemplate);
      expect(event.pubkey).toBe(pubkey);
      expect(verifyEvent(event)).toBe(true);
    }
    await vault.forget();
    expect(vault.publicKey()).toBeNull();
    expect(await store.get()).toBeUndefined();
    expect(await store.getUnlockKey()).toBeUndefined();
    await expect(signer.signEvent(template)).rejects.toThrow("Unlock this device account");
  });

  test("keeps legacy vaults recoverable and migrates only after the correct passphrase",async()=>{
    const store=memoryStore();store.value=await legacyRecord("correct horse battery staple");const pubkey=store.value.pubkey;const vault=new IdentityVault(store);
    await expect(vault.autoUnlock()).rejects.toThrow("existing passphrase");
    await expect(vault.unlock("wrong passphrase")).rejects.toThrow("Unable to unlock");expect(store.value.formatVersion).toBe(1);
    expect(await vault.unlock("correct horse battery staple")).toBe(pubkey);expect(store.value.formatVersion).toBe(2);expect(store.unlockKey).toBeDefined();
    vault.lock();expect(await vault.autoUnlock()).toBe(pubkey);
  });

  test("reports a missing v2 unlock half as a recoverable incomplete record", async () => {
    const store = memoryStore();
    const vault = new IdentityVault(store);
    await vault.create();
    store.unlockKey = undefined;
    vault.lock();
    await expect(vault.autoUnlock()).rejects.toThrow("unlock record is missing");
    await vault.forget();
    expect(store.value).toBeUndefined();
  });

  test("uses one pair operation for create, migration, and forget", async () => {
    const store = memoryStore();
    let replacements = 0, deletions = 0;
    const replacePair = store.replacePair.bind(store), deletePair = store.deletePair.bind(store);
    store.replacePair = async (...args) => { replacements += 1; await replacePair(...args); };
    store.deletePair = async () => { deletions += 1; await deletePair(); };
    const vault = new IdentityVault(store);
    await vault.create();
    expect(replacements).toBe(1);
    await vault.forget();
    expect(deletions).toBe(1);

    store.value = await legacyRecord("correct horse battery staple");
    await vault.unlock("correct horse battery staple");
    expect(replacements).toBe(2);
  });

  test("does not expose a half-written or half-deleted pair when an atomic store operation fails", async () => {
    const store = memoryStore();
    store.replacePair = async () => { throw new Error("transaction aborted"); };
    await expect(new IdentityVault(store).create()).rejects.toThrow("transaction aborted");
    expect(store.value).toBeUndefined();expect(store.unlockKey).toBeUndefined();

    const intact = memoryStore();const vault = new IdentityVault(intact);await vault.create();
    const beforeIdentity=structuredClone(intact.value),beforeKey=structuredClone(intact.unlockKey);
    intact.deletePair=async()=>{throw new Error("transaction aborted");};
    await expect(vault.forget()).rejects.toThrow("transaction aborted");
    expect(intact.value).toEqual(beforeIdentity);expect(intact.unlockKey).toEqual(beforeKey);
  });

  test("a local signer completes the server login challenge for its expected pubkey", async () => {
    const vault = new IdentityVault(memoryStore());
    const pubkey = await vault.create();
    const signer = new DeviceSigner(vault);
    const auth = new AuthService({ now: () => 1_756_860_000, accessMode: "open" });
    const challenge = auth.issueChallenge(pubkey, "https://level.test");
    const event = await signer.signEvent(challenge.event);
    expect(auth.login({ nonce: challenge.nonce, pubkey, event }, "https://level.test").session.pubkey).toBe(pubkey);
  });
});

describe("signer abstraction", () => {
  test("delegates extension identities to NIP-07", async () => {
    const calls: string[] = [];
    const expected = { ...template, pubkey: "a".repeat(64), id: "b".repeat(64), sig: "c".repeat(128) };
    const signer = new Nip07Signer({
      getPublicKey: async () => { calls.push("pubkey"); return expected.pubkey; },
      signEvent: async (event) => { calls.push(`sign:${event.kind}:${event.pubkey}`); return expected; },
    });
    expect(await signer.getPublicKey()).toBe(expected.pubkey);
    expect(await signer.signEvent(template)).toBe(expected);
    expect(calls).toEqual(["pubkey", `sign:27235:${expected.pubkey}`]);
  });
});
