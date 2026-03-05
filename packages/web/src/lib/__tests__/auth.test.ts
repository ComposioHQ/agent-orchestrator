import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock readAuthToken before importing auth module
let mockToken: string | null = null;

vi.mock("@composio/ao-core", () => ({
  readAuthToken: () => mockToken,
}));

// Import after mocking
import { validateRawRequest } from "../auth.js";

beforeEach(() => {
  mockToken = null;
});

afterEach(() => {
  mockToken = null;
});

describe("validateRawRequest", () => {
  it("returns true when no token configured", () => {
    const result = validateRawRequest({}, "/health", null);
    expect(result).toBe(true);
  });

  it("returns false when token required but not provided", () => {
    const result = validateRawRequest({}, "/health", "secret-token");
    expect(result).toBe(false);
  });

  it("returns true with valid Authorization header", () => {
    const result = validateRawRequest(
      { authorization: "Bearer secret-token" },
      "/health",
      "secret-token",
    );
    expect(result).toBe(true);
  });

  it("returns false with invalid Authorization header", () => {
    const result = validateRawRequest(
      { authorization: "Bearer wrong-token" },
      "/health",
      "secret-token",
    );
    expect(result).toBe(false);
  });

  it("returns true with valid token query parameter", () => {
    const result = validateRawRequest({}, "/health?token=secret-token", "secret-token");
    expect(result).toBe(true);
  });

  it("returns false with invalid token query parameter", () => {
    const result = validateRawRequest({}, "/health?token=wrong", "secret-token");
    expect(result).toBe(false);
  });

  it("is case-insensitive for Bearer prefix", () => {
    const result = validateRawRequest(
      { authorization: "bearer secret-token" },
      "/health",
      "secret-token",
    );
    expect(result).toBe(true);
  });

  it("rejects malformed Authorization header", () => {
    const result = validateRawRequest(
      { authorization: "secret-token" },
      "/health",
      "secret-token",
    );
    expect(result).toBe(false);
  });

  it("rejects Basic auth scheme", () => {
    const result = validateRawRequest(
      { authorization: "Basic secret-token" },
      "/health",
      "secret-token",
    );
    expect(result).toBe(false);
  });
});
