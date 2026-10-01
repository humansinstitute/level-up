import Dexie, { type EntityTable } from "dexie";
import type { RoundContributionAttachment } from "./loop";

export interface LegacyEncryptedIdentityRecord {
  id: "device";
  formatVersion: 1;
  kdf: "PBKDF2-SHA-256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  pubkey: string;
  createdAt: number;
}

export interface AutoUnlockIdentityRecord {
  id: "device";
  formatVersion: 2;
  cipher: "AES-256-GCM";
  iv: string;
  ciphertext: string;
  pubkey: string;
  createdAt: number;
  migratedAt?: number;
}

export type EncryptedIdentityRecord = LegacyEncryptedIdentityRecord | AutoUnlockIdentityRecord;

export interface IdentityUnlockKeyRecord {
  id: "device";
  formatVersion: 1;
  key: string;
  createdAt: number;
}

export interface CachedProfileRecord {
  pubkey: string;
  event: string;
  fetchedAt: number;
}

export interface RoundOutboxRecord {
  clientEventId: string;
  projectId: string;
  roundId: string;
  roundNumber: number;
  body: string;
  attachments?: RoundContributionAttachment[];
  status: "pending" | "sent" | "failed";
  createdAt: number;
  error?: string;
}

class LevelUpClientDb extends Dexie {
  identities!: EntityTable<EncryptedIdentityRecord, "id">;
  identityUnlockKeys!: EntityTable<IdentityUnlockKeyRecord, "id">;
  profiles!: EntityTable<CachedProfileRecord, "pubkey">;
  roundOutbox!: EntityTable<RoundOutboxRecord, "clientEventId">;

  constructor() {
    super("level-up-client");
    this.version(1).stores({ identities: "id", profiles: "pubkey, fetchedAt" });
    this.version(2).stores({ identities: "id", profiles: "pubkey, fetchedAt", roundOutbox: "clientEventId, projectId, status, createdAt" });
    this.version(3).stores({ identities: "id", identityUnlockKeys: "id", profiles: "pubkey, fetchedAt", roundOutbox: "clientEventId, projectId, status, createdAt" });
  }
}

let database: LevelUpClientDb | undefined;

export function clientDb(): LevelUpClientDb {
  database ??= new LevelUpClientDb();
  return database;
}

export function browserPersistenceAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}
