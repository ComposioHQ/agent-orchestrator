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
