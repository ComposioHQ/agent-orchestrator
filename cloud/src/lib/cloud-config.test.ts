import { afterEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  cloudApiBaseUrl,
  cloudControlEnvironment,
  cloudWebMode,
  workosRedirectUri,
} from "./cloud-config";

const originalRedirectUri = process.env.WORKOS_REDIRECT_URI;
const originalWebMode = process.env.AO_CLOUD_WEB_MODE;
const originalApiBaseUrl = process.env.AO_CLOUD_WEB_API_BASE_URL;

afterEach(() => {
  if (originalRedirectUri === undefined) {
    delete process.env.WORKOS_REDIRECT_URI;
  } else {
    process.env.WORKOS_REDIRECT_URI = originalRedirectUri;
  }
  if (originalWebMode === undefined) {
    delete process.env.AO_CLOUD_WEB_MODE;
  } else {
    process.env.AO_CLOUD_WEB_MODE = originalWebMode;
  }
  if (originalApiBaseUrl === undefined) {
    delete process.env.AO_CLOUD_WEB_API_BASE_URL;
  } else {
    process.env.AO_CLOUD_WEB_API_BASE_URL = originalApiBaseUrl;
  }
});

it("accepts the local staging callback URL", () => {
  process.env.WORKOS_REDIRECT_URI = "http://localhost:3000/callback";

  expect(workosRedirectUri()).toBe("http://localhost:3000/callback");
});

it("requires a WorkOS callback URL", () => {
  delete process.env.WORKOS_REDIRECT_URI;

  expect(() => workosRedirectUri()).toThrow(
    "WORKOS_REDIRECT_URI is required for WorkOS sign-in.",
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

it("accepts a public HTTPS callback URL in production mode", () => {
  process.env.AO_CLOUD_WEB_MODE = "production";
  process.env.WORKOS_REDIRECT_URI = "https://cloud.aoagents.dev/callback";

  expect(workosRedirectUri()).toBe("https://cloud.aoagents.dev/callback");
});

it.each([
  "http://cloud.aoagents.dev/callback",
  "https://localhost/callback",
  "https://127.0.0.1/callback",
  "https://cloud.aoagents.dev/not-callback",
  "https://user:password@cloud.aoagents.dev/callback",
])("rejects an unsafe WorkOS callback URL in production mode: %s", (redirectUri) => {
  process.env.AO_CLOUD_WEB_MODE = "production";
  process.env.WORKOS_REDIRECT_URI = redirectUri;

  expect(() => workosRedirectUri()).toThrow(
    "WORKOS_REDIRECT_URI must be a public HTTPS /callback URL for production.",
  );
});

it("accepts production as a web mode", () => {
  process.env.AO_CLOUD_WEB_MODE = "production";

  expect(cloudWebMode()).toBe("production");
});

it("rejects an unknown web mode", () => {
  process.env.AO_CLOUD_WEB_MODE = "prod";

  expect(() => cloudWebMode()).toThrow(
    "AO_CLOUD_WEB_MODE must be local, staging, or production.",
  );
});

it("maps production mode to the production control environment", () => {
  process.env.AO_CLOUD_WEB_MODE = "production";

  expect(cloudControlEnvironment()).toBe("production");
});

it("defaults the production API origin to the production control plane", () => {
  process.env.AO_CLOUD_WEB_MODE = "production";
  delete process.env.AO_CLOUD_WEB_API_BASE_URL;

  expect(cloudApiBaseUrl()).toBe("https://api.aoagents.dev");
});

it("rejects a plaintext API origin in production mode", () => {
  process.env.AO_CLOUD_WEB_MODE = "production";
  process.env.AO_CLOUD_WEB_API_BASE_URL = "http://api.aoagents.dev";

  expect(() => cloudApiBaseUrl()).toThrow(
    "Hosted Cloud UI requires an HTTPS API origin.",
  );
});
