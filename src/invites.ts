export const INVITE_FRAGMENT_KEY = "join";
export const INVITE_CODE_LENGTH = 6;
export const INVITE_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const INVITE_SECRET_PATTERN = /^(?:[A-Za-z0-9_-]{6}|[A-Za-z0-9_-]{43})$/;

export function buildInviteUrl(origin: string, secret: string): string {
  return `${new URL(origin).origin}/#${INVITE_FRAGMENT_KEY}=${encodeURIComponent(secret)}`;
}

export function parseInviteSecret(value: string): string | null {
  const candidate = value.trim();
  if (INVITE_SECRET_PATTERN.test(candidate)) return candidate;

  try {
    const url = new URL(candidate);
    const secret = new URLSearchParams(url.hash.slice(1)).get(INVITE_FRAGMENT_KEY)?.trim() ?? "";
    return INVITE_SECRET_PATTERN.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

export function pendingInviteFromLocation(location: Pick<Location, "hash">): string | null {
  const secret = new URLSearchParams(location.hash.slice(1)).get(INVITE_FRAGMENT_KEY)?.trim() ?? "";
  return INVITE_SECRET_PATTERN.test(secret) ? secret : null;
}

export function clearInviteFragment(history: Pick<History, "replaceState">, location: Pick<Location, "pathname" | "search">): void {
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}
