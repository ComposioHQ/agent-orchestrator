import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "../src/verify.js";

function makeSignature(body: Buffer, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  return hmac.digest("hex");
}

describe("verifySignature", () => {
  it("returns true for a valid signature", () => {
    const body = Buffer.from('{"action":"update"}');
    const secret = "my-secret";
    const sig = makeSignature(body, secret);
    expect(verifySignature(body, sig, secret)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    const body = Buffer.from('{"action":"update"}');
    const secret = "my-secret";
    const badSig = "a".repeat(64);
    expect(verifySignature(body, badSig, secret)).toBe(false);
  });

  it("returns false for mismatched length signature", () => {
    const body = Buffer.from('{"action":"update"}');
    const secret = "my-secret";
    const shortSig = "abc123";
    expect(verifySignature(body, shortSig, secret)).toBe(false);
  });

  it("skips verification (returns true) when secret is empty and warns", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = Buffer.from('{"action":"update"}');
    const result = verifySignature(body, undefined, "");
    expect(result).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("not set"));
    consoleSpy.mockRestore();
  });

  it("returns false when signature is missing but secret is configured", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = Buffer.from('{"action":"update"}');
    const result = verifySignature(body, undefined, "my-secret");
    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No signature"));
    consoleSpy.mockRestore();
  });
});
