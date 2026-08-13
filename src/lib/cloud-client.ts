"use client";

import { createCloudClient } from "@aoagents/cloud-client";

export function browserCloudClient() {
  return createCloudClient({
    baseUrl:
      typeof window === "undefined" ? "http://localhost" : window.location.origin,
    // The same-origin Next.js gateway replaces this sentinel with the
    // HttpOnly local session or the server-side WorkOS access token.
    getAccessToken: () => "same-origin-session",
  });
}

export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const PENDING_SHARE_STORAGE_KEY = "ao-pending-share-redemption";

// A share link can be opened by someone who isn't signed in yet. Rather
// than teach the WorkOS sign-in redirect about share-specific return
// destinations, the redemption page stashes the link here before sending
// the visitor to sign in, and the main workspace redeems it — once — the
// next time it loads with a session.
export function savePendingShareRedemption(orgId: string, token: string) {
  window.sessionStorage.setItem(
    PENDING_SHARE_STORAGE_KEY,
    JSON.stringify({ orgId, token }),
  );
}

export function consumePendingShareRedemption(): {
  orgId: string;
  token: string;
} | null {
  const raw = window.sessionStorage.getItem(PENDING_SHARE_STORAGE_KEY);
  if (!raw) return null;
  window.sessionStorage.removeItem(PENDING_SHARE_STORAGE_KEY);
  try {
    const parsed = JSON.parse(raw) as { orgId?: unknown; token?: unknown };
    if (typeof parsed.orgId !== "string" || typeof parsed.token !== "string") {
      return null;
    }
    return { orgId: parsed.orgId, token: parsed.token };
  } catch {
    return null;
  }
}
