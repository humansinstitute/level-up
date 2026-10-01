import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from "nostr-tools";
import { browserPersistenceAvailable, clientDb, type EncryptedIdentityRecord, type IdentityUnlockKeyRecord } from "./client-db";

const LEGACY_FORMAT_VERSION = 1 as const;
const AUTO_UNLOCK_FORMAT_VERSION = 2 as const;
export const VAULT_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const OPAQUE_UNLOCK_ERROR = "Unable to unlock this device account. Check the passphrase and try again.";

export interface IdentityStore {
  get(): Promise<EncryptedIdentityRecord | undefined>;
  put(record: EncryptedIdentityRecord): Promise<void>;
  getUnlockKey(): Promise<IdentityUnlockKeyRecord | undefined>;
  putUnlockKey(record: IdentityUnlockKeyRecord): Promise<void>;
  deleteUnlockKey(): Promise<void>;
  delete(): Promise<void>;
  replacePair(identity: EncryptedIdentityRecord, unlockKey: IdentityUnlockKeyRecord): Promise<void>;
  deletePair(): Promise<void>;
  available(): boolean;
}

export const dexieIdentityStore: IdentityStore = {
  available: browserPersistenceAvailable,
  get: () => clientDb().identities.get("device"),
  put: async (record) => { await clientDb().identities.put(record); },
  getUnlockKey: () => clientDb().identityUnlockKeys.get("device"),
  putUnlockKey: async (record) => { await clientDb().identityUnlockKeys.put(record); },
  deleteUnlockKey: async () => { await clientDb().identityUnlockKeys.delete("device"); },
  delete: async () => { await clientDb().identities.delete("device"); },
  replacePair: async (identity, unlockKey) => {
    const db = clientDb();
    await db.transaction("rw", db.identities, db.identityUnlockKeys, async () => {
      await db.identityUnlockKeys.put(unlockKey);
      await db.identities.put(identity);
    });
  },
  deletePair: async () => {
    const db = clientDb();
    await db.transaction("rw", db.identities, db.identityUnlockKeys, async () => {
      await db.identities.delete("device");
      await db.identityUnlockKeys.delete("device");
    });
  },
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function cryptoApi(): Crypto {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle || typeof crypto.getRandomValues !== "function") {
    throw new Error("Secure browser cryptography is unavailable. This device account cannot be used here.");
  }
  return crypto;
}

async function encryptionKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const encoded = new TextEncoder().encode(passphrase);
  try {
    const material = await cryptoApi().subtle.importKey("raw", encoded, "PBKDF2", false, ["deriveKey"]);
    return await cryptoApi().subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    encoded.fill(0);
  }
}

async function importWrappingKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("Invalid device unlock key.");
  return cryptoApi().subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, usages);
}

function assertPassphrase(passphrase: string): void {
  if (passphrase.length < 10 || passphrase.length > 256) {
    throw new Error("Use a passphrase between 10 and 256 characters.");
  }
}

export class IdentityVault {
  private secret: Uint8Array | null = null;

  constructor(private readonly store: IdentityStore = dexieIdentityStore) {}

  private assertAvailable(): void {
    cryptoApi();
    if (!this.store.available()) throw new Error("IndexedDB is unavailable. This device account cannot be stored securely here.");
  }

  async record(): Promise<EncryptedIdentityRecord | undefined> {
    if (!this.store.available()) return undefined;
    return this.store.get();
  }

  async create(): Promise<string> {
    this.assertAvailable();
    if (await this.store.get()) throw new Error("A device account already exists in this browser. Unlock or forget it before creating another.");
    const secret = generateSecretKey();
    const wrappingKey = cryptoApi().getRandomValues(new Uint8Array(32));
    const iv = cryptoApi().getRandomValues(new Uint8Array(IV_BYTES));
    try {
      const pubkey = getPublicKey(secret);
      const key = await importWrappingKey(wrappingKey, ["encrypt"]);
      const encrypted = await cryptoApi().subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, secret as BufferSource);
      await this.store.replacePair({
        id: "device",
        formatVersion: AUTO_UNLOCK_FORMAT_VERSION,
        cipher: "AES-256-GCM",
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(encrypted)),
        pubkey,
        createdAt: Date.now(),
      }, { id: "device", formatVersion: 1, key: bytesToBase64(wrappingKey), createdAt: Date.now() });
      this.replaceSecret(secret);
      return pubkey;
    } catch (error) {
      secret.fill(0);
      throw error;
    } finally {
      wrappingKey.fill(0);
      iv.fill(0);
    }
  }

  async autoUnlock(): Promise<string> {
    this.assertAvailable();
    const record = await this.store.get();
    if (!record || record.formatVersion !== AUTO_UNLOCK_FORMAT_VERSION) throw new Error("This device account needs its existing passphrase once before automatic sign-in can be enabled.");
    const storedKey = await this.store.getUnlockKey();
    let rawKey: Uint8Array | undefined;
    let iv: Uint8Array | undefined;
    let ciphertext: Uint8Array | undefined;
    let decrypted: Uint8Array | undefined;
    try {
      if (!storedKey) throw new Error("missing_unlock_key");
      if (storedKey.formatVersion !== 1 || record.cipher !== "AES-256-GCM" || !/^[0-9a-f]{64}$/.test(record.pubkey)) throw new Error();
      rawKey = base64ToBytes(storedKey.key); iv = base64ToBytes(record.iv); ciphertext = base64ToBytes(record.ciphertext);
      if (iv.length !== IV_BYTES || ciphertext.length < 33) throw new Error();
      const key = await importWrappingKey(rawKey, ["decrypt"]);
      decrypted = new Uint8Array(await cryptoApi().subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource));
      if (decrypted.length !== 32 || getPublicKey(decrypted) !== record.pubkey) throw new Error();
      this.replaceSecret(decrypted); decrypted = undefined; return record.pubkey;
    } catch (error) { throw new Error(error instanceof Error && error.message === "missing_unlock_key" ? "This device account is incomplete because its unlock record is missing. Forget it to create a new player on this device." : "This device account could not be recovered. Forget it to create a new player on this device."); }
    finally { rawKey?.fill(0); iv?.fill(0); ciphertext?.fill(0); decrypted?.fill(0); }
  }

  async unlock(passphrase: string): Promise<string> {
    this.assertAvailable();
    const record = await this.store.get();
    if (!record) throw new Error(OPAQUE_UNLOCK_ERROR);
    let salt: Uint8Array | undefined;
    let iv: Uint8Array | undefined;
    let ciphertext: Uint8Array | undefined;
    let decrypted: Uint8Array | undefined;
    try {
      if (record.formatVersion !== LEGACY_FORMAT_VERSION || record.kdf !== "PBKDF2-SHA-256"
        || !Number.isInteger(record.iterations) || record.iterations < 300_000 || record.iterations > 1_000_000
        || record.salt.length > 32 || record.iv.length > 24 || record.ciphertext.length > 128
        || !/^[0-9a-f]{64}$/.test(record.pubkey) || passphrase.length > 256) throw new Error();
      salt = base64ToBytes(record.salt);
      iv = base64ToBytes(record.iv);
      ciphertext = base64ToBytes(record.ciphertext);
      if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || ciphertext.length < 33) throw new Error();
      const key = await encryptionKey(passphrase, salt, record.iterations);
      decrypted = new Uint8Array(await cryptoApi().subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource));
      if (decrypted.length !== 32 || getPublicKey(decrypted) !== record.pubkey) throw new Error();
      this.replaceSecret(decrypted);
      decrypted = undefined;
      await this.migrateLegacyRecord(record.pubkey, record.createdAt);
      return record.pubkey;
    } catch {
      throw new Error(OPAQUE_UNLOCK_ERROR);
    } finally {
      salt?.fill(0);
      iv?.fill(0);
      ciphertext?.fill(0);
      decrypted?.fill(0);
    }
  }

  publicKey(): string | null {
    return this.secret ? getPublicKey(this.secret) : null;
  }

  sign(event: EventTemplate): Event {
    if (!this.secret) throw new Error("Unlock this device account before signing.");
    return finalizeEvent(event, this.secret);
  }

  lock(): void {
    this.secret?.fill(0);
    this.secret = null;
  }

  async forget(): Promise<void> {
    this.lock();
    if (!this.store.available()) throw new Error("IndexedDB is unavailable, so the device account could not be removed.");
    await this.store.deletePair();
  }

  private async migrateLegacyRecord(pubkey: string, createdAt: number): Promise<void> {
    if (!this.secret) throw new Error(OPAQUE_UNLOCK_ERROR);
    const wrappingKey = cryptoApi().getRandomValues(new Uint8Array(32));
    const iv = cryptoApi().getRandomValues(new Uint8Array(IV_BYTES));
    try {
      const key = await importWrappingKey(wrappingKey, ["encrypt"]);
      const encrypted = await cryptoApi().subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, this.secret as BufferSource);
      await this.store.replacePair({ id: "device", formatVersion: AUTO_UNLOCK_FORMAT_VERSION, cipher: "AES-256-GCM", iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)), pubkey, createdAt, migratedAt: Date.now() }, { id: "device", formatVersion: 1, key: bytesToBase64(wrappingKey), createdAt: Date.now() });
    } finally { wrappingKey.fill(0); iv.fill(0); }
  }

  private replaceSecret(secret: Uint8Array): void {
    this.lock();
    this.secret = new Uint8Array(secret);
    secret.fill(0);
  }
}
