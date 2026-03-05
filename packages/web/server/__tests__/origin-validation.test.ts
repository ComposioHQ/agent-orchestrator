import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isAllowedOrigin, isAllowedWebSocketOrigin } from "../origin-validation.js";

describe("isAllowedOrigin", () => {
  const originalEnv = process.env.AO_ALLOWED_ORIGINS;

  beforeEach(() => {
    delete process.env.AO_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AO_ALLOWED_ORIGINS = originalEnv;
    } else {
      delete process.env.AO_ALLOWED_ORIGINS;
    }
  });

  // --- Allowed by default ---

  it("allows http://localhost (no port)", () => {
    expect(isAllowedOrigin("http://localhost")).toBe(true);
  });

  it("allows http://localhost:3000", () => {
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
  });

  it("allows http://localhost:14801", () => {
    expect(isAllowedOrigin("http://localhost:14801")).toBe(true);
  });

  it("allows https://localhost:3000", () => {
    expect(isAllowedOrigin("https://localhost:3000")).toBe(true);
  });

  it("allows http://127.0.0.1:3000", () => {
    expect(isAllowedOrigin("http://127.0.0.1:3000")).toBe(true);
  });

  it("allows https://127.0.0.1", () => {
    expect(isAllowedOrigin("https://127.0.0.1")).toBe(true);
  });

  it("allows http://[::1]:3000", () => {
    expect(isAllowedOrigin("http://[::1]:3000")).toBe(true);
  });

  // --- Rejected by default ---

  it("rejects undefined (no Origin header)", () => {
    expect(isAllowedOrigin(undefined)).toBe(false);
  });

  it('rejects "null" string (file://, data: URI, sandboxed iframe)', () => {
    expect(isAllowedOrigin("null")).toBe(false);
  });

  it("rejects external origin", () => {
    expect(isAllowedOrigin("https://evil.example.com")).toBe(false);
  });

  it("rejects origin with localhost in subdomain", () => {
    expect(isAllowedOrigin("https://localhost.evil.com")).toBe(false);
  });

  it("rejects origin with localhost in path (not origin)", () => {
    expect(isAllowedOrigin("https://evil.com/localhost")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isAllowedOrigin("")).toBe(false);
  });

  // --- AO_ALLOWED_ORIGINS env var ---

  it("allows origin from AO_ALLOWED_ORIGINS", () => {
    process.env.AO_ALLOWED_ORIGINS = "https://my-app.example.com";
    expect(isAllowedOrigin("https://my-app.example.com")).toBe(true);
  });

  it("allows multiple configured origins", () => {
    process.env.AO_ALLOWED_ORIGINS = "https://app1.example.com,https://app2.example.com";
    expect(isAllowedOrigin("https://app1.example.com")).toBe(true);
    expect(isAllowedOrigin("https://app2.example.com")).toBe(true);
  });

  it("trims whitespace from configured origins", () => {
    process.env.AO_ALLOWED_ORIGINS = " https://app.example.com , https://other.example.com ";
    expect(isAllowedOrigin("https://app.example.com")).toBe(true);
    expect(isAllowedOrigin("https://other.example.com")).toBe(true);
  });

  it("still allows localhost when AO_ALLOWED_ORIGINS is set", () => {
    process.env.AO_ALLOWED_ORIGINS = "https://app.example.com";
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
  });

  it("rejects unknown origin when AO_ALLOWED_ORIGINS is set", () => {
    process.env.AO_ALLOWED_ORIGINS = "https://app.example.com";
    expect(isAllowedOrigin("https://evil.example.com")).toBe(false);
  });

  it("handles empty AO_ALLOWED_ORIGINS", () => {
    process.env.AO_ALLOWED_ORIGINS = "";
    expect(isAllowedOrigin("https://evil.example.com")).toBe(false);
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
  });

  it("requires exact match for configured origins (no port wildcard)", () => {
    process.env.AO_ALLOWED_ORIGINS = "https://app.example.com";
    expect(isAllowedOrigin("https://app.example.com:8080")).toBe(false);
  });
});

describe("isAllowedWebSocketOrigin", () => {
  const originalEnv = process.env.AO_ALLOWED_ORIGINS;

  beforeEach(() => {
    delete process.env.AO_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AO_ALLOWED_ORIGINS = originalEnv;
    } else {
      delete process.env.AO_ALLOWED_ORIGINS;
    }
  });

  it("allows undefined (no Origin = non-browser client)", () => {
    expect(isAllowedWebSocketOrigin(undefined)).toBe(true);
  });

  it("allows localhost origins", () => {
    expect(isAllowedWebSocketOrigin("http://localhost:3000")).toBe(true);
  });

  it('rejects "null" origin (file://, data: URI)', () => {
    expect(isAllowedWebSocketOrigin("null")).toBe(false);
  });

  it("rejects external origin", () => {
    expect(isAllowedWebSocketOrigin("https://evil.example.com")).toBe(false);
  });

  it("allows configured origins", () => {
    process.env.AO_ALLOWED_ORIGINS = "https://app.example.com";
    expect(isAllowedWebSocketOrigin("https://app.example.com")).toBe(true);
  });
});
