import { getEventHash, nip19, verifyEvent, type Event } from "nostr-tools";

export const MAX_PROFILE_BATCH = 32;
export const PROFILE_STALE_MS = 6 * 60 * 60 * 1000;
const MAX_EVENT_BYTES = 32_000;
const MAX_PROFILE_BYTES = 16_000;
const MAX_NAME = 80;
const MAX_ABOUT = 2_000;
const MAX_URL = 2_048;
const SAFE_FIELDS = ["name", "display_name", "picture", "about", "website", "banner", "nip05", "lud06", "lud16"] as const;

export interface PublicProfile {
  pubkey: string;
  npub: string;
  displayName: string;
  picture?: string;
  about?: string;
  metadata: Record<string, string>;
  event?: Event;
  fetchedAt?: number;
}

function clipped(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : undefined;
}

function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }

export function httpsUrl(value: unknown): string | undefined {
  const clean = clipped(value, MAX_URL);
  if (!clean) return undefined;
  try { const url = new URL(clean); return url.protocol === "https:" ? url.href : undefined; }
  catch { return undefined; }
}

export function safeMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const field of SAFE_FIELDS) {
    const safe = field === "picture" || field === "banner" || field === "website"
      ? httpsUrl(source[field])
      : clipped(source[field], field === "about" ? MAX_ABOUT : MAX_NAME);
    if (safe) result[field] = safe;
  }
  return result;
}

export function profileFromEvent(pubkey: string, event?: Event, fetchedAt?: number): PublicProfile {
  let metadata: Record<string, string> = {};
  if (event) { try { metadata = safeMetadata(JSON.parse(event.content)); } catch { metadata = {}; } }
  return {
    pubkey,
    npub: nip19.npubEncode(pubkey),
    displayName: metadata.display_name || metadata.name || "",
    picture: metadata.picture,
    about: metadata.about,
    metadata,
    event,
    fetchedAt,
  };
}

export function selectLatestProfile(events: Event[], pubkey: string): Event | undefined {
  const normalized = pubkey.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) return undefined;
  return events.filter((event) => {
    if (event.kind !== 0 || event.pubkey !== normalized || byteLength(event.content) > MAX_PROFILE_BYTES) return false;
    if (byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) return false;
    try { JSON.parse(event.content); return event.id === getEventHash(event) && verifyEvent(event); }
    catch { return false; }
  }).sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))[0];
}
