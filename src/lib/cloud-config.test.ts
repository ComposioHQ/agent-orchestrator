import { afterEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { workosRedirectUri } from "./cloud-config";

const originalRedirectUri = process.env.WORKOS_REDIRECT_URI;

afterEach(() => {
  if (originalRedirectUri === undefined) {
    delete process.env.WORKOS_REDIRECT_URI;
  } else {
    process.env.WORKOS_REDIRECT_URI = originalRedirectUri;
  }
});

it("accepts the local staging callback URL", () => {
  process.env.WORKOS_REDIRECT_URI = "http://localhost:3000/callback";

  expect(workosRedirectUri()).toBe("http://localhost:3000/callback");
});

it("requires a WorkOS callback URL", () => {
  delete process.env.WORKOS_REDIRECT_URI;

  expect(() => workosRedirectUri()).toThrow(
    "WORKOS_REDIRECT_URI is required in staging mode.",
  );
});

it.each([
  "https://example.com/callback",
  "http://localhost:3000/not-callback",
  "http://user:password@localhost:3000/callback",
])("rejects an unsafe WorkOS callback URL: %s", (redirectUri) => {
  process.env.WORKOS_REDIRECT_URI = redirectUri;

  expect(() => workosRedirectUri()).toThrow(
    "WORKOS_REDIRECT_URI must be a loopback HTTP /callback URL.",
  );
});
