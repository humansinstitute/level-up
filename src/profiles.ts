import { getEventHash, SimplePool, verifyEvent, type Event, type EventTemplate } from "nostr-tools";
import { browserPersistenceAvailable, clientDb, type CachedProfileRecord } from "./client-db";
import type { NostrSigner } from "./signer";
import { httpsUrl, profileFromEvent, safeMetadata, selectLatestProfile, type PublicProfile } from "./profile-data";
export { httpsUrl, profileFromEvent, safeMetadata, selectLatestProfile, type PublicProfile } from "./profile-data";

export const PROFILE_RELAYS = ["wss://relay.primal.net", "wss://nos.lol", "wss://purplepag.es"] as const;
export const PROFILE_TIMEOUT_MS = 4_500;
const MAX_NAME = 80;
const MAX_ABOUT = 2_000;

export interface ProfileCache {
  get(pubkey: string): Promise<CachedProfileRecord | undefined>;
  put(record: CachedProfileRecord): Promise<void>;
}

export const dexieProfileCache: ProfileCache = {
  get: async (pubkey) => browserPersistenceAvailable() ? clientDb().profiles.get(pubkey) : undefined,
  put: async (record) => { if (browserPersistenceAvailable()) await clientDb().profiles.put(record); },
};

export interface RelayTransport {
  lookup(pubkey: string, timeoutMs: number): Promise<Event[]>;
  publish(event: Event, timeoutMs: number): Promise<{ accepted: string[]; failed: string[] }>;
}

export class NostrRelayTransport implements RelayTransport {
  constructor(private readonly relays: readonly string[] = PROFILE_RELAYS) {}

  async lookup(pubkey: string, timeoutMs: number): Promise<Event[]> {
    const pool = new SimplePool();
    try {
      return await pool.querySync([...this.relays], { kinds: [0], authors: [pubkey], limit: 12 }, { maxWait: timeoutMs });
    } finally {
      pool.close([...this.relays]);
      pool.destroy();
    }
  }

  async publish(event: Event, timeoutMs: number): Promise<{ accepted: string[]; failed: string[] }> {
    const pool = new SimplePool();
    try {
      const settled = await Promise.allSettled(pool.publish([...this.relays], event, { maxWait: timeoutMs }));
      return settled.reduce<{ accepted: string[]; failed: string[] }>((result, item, index) => {
        result[item.status === "fulfilled" ? "accepted" : "failed"].push(this.relays[index]!);
        return result;
      }, { accepted: [], failed: [] });
    } finally {
      pool.close([...this.relays]);
      pool.destroy();
    }
  }
}

function clipped(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : undefined;
}


export function buildProfileTemplate(existing: PublicProfile | undefined, edit: { displayName: string; about: string }, now = Date.now()): EventTemplate {
  const metadata = safeMetadata(existing?.metadata);
  const displayName = clipped(edit.displayName, MAX_NAME);
  if (!displayName) throw new Error("Enter a display name.");
  metadata.display_name = displayName;
  delete metadata.picture;
  delete metadata.about;
  const about = clipped(edit.about, MAX_ABOUT);
  if (about) metadata.about = about;
  const nowSeconds = Math.floor(now / 1000);
  const createdAt = existing?.event ? Math.max(nowSeconds, Math.min(existing.event.created_at + 1, nowSeconds + 30)) : nowSeconds;
  return { kind: 0, created_at: createdAt, tags: [], content: JSON.stringify(metadata) };
}

export class ProfileService {
  constructor(private readonly transport: RelayTransport = new NostrRelayTransport(), private readonly cache: ProfileCache = dexieProfileCache) {}

  async cached(pubkey: string): Promise<PublicProfile | undefined> {
    try {
      const record = await this.cache.get(pubkey);
      if (!record) return undefined;
      const event = JSON.parse(record.event) as Event;
      const selected = selectLatestProfile([event], pubkey);
      return selected ? profileFromEvent(pubkey, selected, record.fetchedAt) : undefined;
    } catch { return undefined; }
  }

  async refresh(pubkey: string): Promise<PublicProfile> {
    const events = await this.transport.lookup(pubkey, PROFILE_TIMEOUT_MS);
    const event = selectLatestProfile(events, pubkey);
    const fetchedAt = Date.now();
    if (event) {
      try { await this.cache.put({ pubkey, event: JSON.stringify(event), fetchedAt }); } catch { /* Public cache failure must not hide a live profile. */ }
      return profileFromEvent(pubkey, event, fetchedAt);
    }
    return await this.cached(pubkey) ?? profileFromEvent(pubkey, undefined, fetchedAt);
  }

  async load(pubkey: string): Promise<PublicProfile> {
    const cached = await this.cached(pubkey);
    try { return await this.refresh(pubkey); } catch { return cached ?? profileFromEvent(pubkey); }
  }

  async publish(signer: NostrSigner, existing: PublicProfile | undefined, edit: { displayName: string; about: string }) {
    const pubkey = (await signer.getPublicKey()).toLowerCase();
    const event = await signer.signEvent(buildProfileTemplate(existing, edit));
    if (event.pubkey !== pubkey || event.id !== getEventHash(event) || !verifyEvent(event)) throw new Error("The signed profile could not be verified.");
    const result = await this.transport.publish(event, PROFILE_TIMEOUT_MS);
    const fetchedAt = Date.now();
    try { await this.cache.put({ pubkey, event: JSON.stringify(event), fetchedAt }); } catch { /* Relay success remains success when local cache is unavailable. */ }
    return { profile: profileFromEvent(pubkey, event, fetchedAt), ...result };
  }
}
