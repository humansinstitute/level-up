import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getEventHash, nip19, verifyEvent, type Event } from "nostr-tools";

export const LOGIN_KIND = 27235;
export const LOGIN_PURPOSE = "level-up-login";
export const LOGIN_CONTENT = "Sign in to Level Up";
export const SESSION_COOKIE = "levelup_session";
export const DEFAULT_OWNER_NPUB = "npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy";

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

interface ChallengeRecord {
  pubkey: string;
  origin: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SessionRecord {
  pubkey: string;
  npub: string;
  expiresAt: number;
}

export interface LoginEvent extends Event {}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 401,
  ) {
    super(message);
  }
}

export interface AuthServiceOptions {
  now?: () => number;
  challengeTtlSeconds?: number;
  sessionTtlSeconds?: number;
  allowedNpubs?: Iterable<string>;
  accessMode?: "open" | "restricted";
  sessionStore?: SessionStore;
}

export interface SessionStore {
  saveAuthSession(tokenHash: string, session: SessionRecord): void;
  readAuthSession(tokenHash: string, nowSeconds: number): SessionRecord | null;
  deleteAuthSession(tokenHash: string): void;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function npubToPubkey(npub: string): string | null {
  try {
    const decoded = nip19.decode(npub.trim());
    return decoded.type === "npub" && typeof decoded.data === "string"
      ? decoded.data.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

export function configuredOwnerNpub(env: Record<string, string | undefined> = process.env): string {
  return env.WAPP_OWNER_NPUB?.trim() || DEFAULT_OWNER_NPUB;
}

export function configuredAllowedNpubs(env: Record<string, string | undefined> = process.env): Set<string> {
  const result = new Set<string>([configuredOwnerNpub(env)]);
  try {
    const values: unknown = JSON.parse(env.WAPP_ALLOWED_NPUBS_JSON ?? "[]");
    if (Array.isArray(values)) {
      for (const value of values) if (typeof value === "string") result.add(value.trim());
    }
  } catch {
    // A malformed optional override grants nobody additional access.
  }
  return result;
}

export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedProto && /^(https?|wss?)$/.test(forwardedProto)) {
    const protocol = forwardedProto === "wss" ? "https" : forwardedProto === "ws" ? "http" : forwardedProto;
    try {
      return new URL(`${protocol}://${forwardedHost || request.headers.get("host") || url.host}`).origin;
    } catch {
      return url.origin;
    }
  }
  return url.origin;
}

function singletonTag(event: Event, name: string): string | null {
  const matches = event.tags.filter((tag) => tag[0] === name);
  return matches.length === 1 && typeof matches[0]?.[1] === "string" ? matches[0][1] : null;
}

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

export class AuthService {
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => number;
  private readonly challengeTtlSeconds: number;
  private readonly sessionTtlSeconds: number;
  private readonly allowedPubkeys: Set<string>;
  private readonly accessMode: "open" | "restricted";
  private readonly sessionStore?: SessionStore;

  constructor(options: AuthServiceOptions = {}) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.challengeTtlSeconds = options.challengeTtlSeconds ?? 90;
    this.sessionTtlSeconds = options.sessionTtlSeconds ?? 8 * 60 * 60;
    this.accessMode = options.accessMode ?? "open";
    this.sessionStore = options.sessionStore;
    this.allowedPubkeys = new Set(
      [...(options.allowedNpubs ?? configuredAllowedNpubs())]
        .map(npubToPubkey)
        .filter((value): value is string => value !== null),
    );
  }

  issueChallenge(pubkey: string, origin: string) {
    this.prune();
    const normalizedPubkey = pubkey.toLowerCase();
    if (!HEX_PUBKEY.test(normalizedPubkey)) {
      throw new AuthError("invalid_pubkey", "The signer returned an invalid public key.", 400);
    }
    const nonce = randomBytes(32).toString("base64url");
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.challengeTtlSeconds;
    this.challenges.set(sha256(nonce), { pubkey: normalizedPubkey, origin, issuedAt, expiresAt });
    return {
      nonce,
      expiresAt,
      event: {
        kind: LOGIN_KIND,
        created_at: issuedAt,
        content: LOGIN_CONTENT,
        tags: [
          ["purpose", LOGIN_PURPOSE],
          ["origin", origin],
          ["challenge", nonce],
        ],
      },
    };
  }

  login(input: { nonce?: unknown; pubkey?: unknown; event?: unknown }, origin: string) {
    const nonce = typeof input.nonce === "string" ? input.nonce : "";
    const challengeKey = sha256(nonce);
    const challenge = this.challenges.get(challengeKey);
    this.challenges.delete(challengeKey);

    if (!nonce || !challenge) {
      throw new AuthError("challenge_unknown", "That sign-in request is unknown or has already been used.");
    }
    const now = this.now();
    if (challenge.expiresAt < now) {
      throw new AuthError("challenge_expired", "That sign-in request expired. Please try again.");
    }
    if (!safeEqual(challenge.origin, origin)) {
      throw new AuthError("origin_mismatch", "The sign-in request came from a different site.");
    }
    if (!input.event || typeof input.event !== "object") {
      throw new AuthError("invalid_event", "The signer did not return a valid event.");
    }
    const event = input.event as Event;
    const claimedPubkey = typeof input.pubkey === "string" ? input.pubkey.toLowerCase() : "";
    if (!HEX_PUBKEY.test(claimedPubkey)
      || event.pubkey !== claimedPubkey
      || event.pubkey !== challenge.pubkey) {
      throw new AuthError("signer_mismatch", "The active signer changed during sign-in. Please try again.");
    }
    if (event.kind !== LOGIN_KIND
      || event.content !== LOGIN_CONTENT
      || !Array.isArray(event.tags)
      || event.tags.length !== 3
      || singletonTag(event, "purpose") !== LOGIN_PURPOSE
      || singletonTag(event, "origin") !== challenge.origin
      || singletonTag(event, "challenge") !== nonce) {
      throw new AuthError("challenge_altered", "The signed sign-in request was altered.");
    }
    if (!Number.isInteger(event.created_at)
      || event.created_at < challenge.issuedAt - 5
      || event.created_at > challenge.expiresAt
      || event.created_at > now + 30) {
      throw new AuthError("invalid_timestamp", "The signed sign-in request has an invalid timestamp.");
    }
    let signatureValid = false;
    try {
      signatureValid = event.id === getEventHash(event) && verifyEvent(event);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      throw new AuthError("invalid_signature", "The sign-in signature could not be verified.");
    }
    if (this.accessMode === "restricted" && !this.allowedPubkeys.has(event.pubkey)) {
      throw new AuthError("access_denied", "This signer does not have access to this Level Up preview.", 403);
    }

    const sessionId = randomBytes(32).toString("base64url");
    const session = {
      pubkey: event.pubkey,
      npub: nip19.npubEncode(event.pubkey),
      expiresAt: now + this.sessionTtlSeconds,
    };
    const tokenHash = sha256(sessionId);
    this.sessions.set(tokenHash, session);
    this.sessionStore?.saveAuthSession(tokenHash, session);
    return { sessionId, session };
  }

  readSession(cookieHeader: string | null): SessionRecord | null {
    this.prune();
    const sessionId = cookieValue(cookieHeader, SESSION_COOKIE);
    if (!sessionId) return null;
    const tokenHash = sha256(sessionId);
    const memory = this.sessions.get(tokenHash);
    if (memory) return memory;
    const durable = this.sessionStore?.readAuthSession(tokenHash, this.now()) ?? null;
    if (durable) this.sessions.set(tokenHash, durable);
    return durable;
  }

  logout(cookieHeader: string | null): void {
    const sessionId = cookieValue(cookieHeader, SESSION_COOKIE);
    if (sessionId) {
      const tokenHash = sha256(sessionId);
      this.sessions.delete(tokenHash);
      this.sessionStore?.deleteAuthSession(tokenHash);
    }
  }

  sessionCookie(sessionId: string, secure: boolean): string {
    return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${this.sessionTtlSeconds}${secure ? "; Secure" : ""}`;
  }

  clearSessionCookie(secure: boolean): string {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, challenge] of this.challenges) {
      if (challenge.expiresAt < now) this.challenges.delete(key);
    }
    for (const [key, session] of this.sessions) {
      if (session.expiresAt < now) this.sessions.delete(key);
    }
  }
}
