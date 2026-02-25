import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifySignature } from "../src/verify.js";

function sign(body: Buffer, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  return hmac.digest("hex");
}

describe("verifySignature", () => {
  const secret = "whsec_test_secret_123";
  const body = Buffer.from('{"action":"create","type":"Issue"}');

  it("returns true for a valid HMAC signature", () => {
    const signature = sign(body, secret);
    expect(verifySignature(body, signature, secret)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    const signature = sign(body, secret);
    // Flip the last character to create an invalid but same-length signature
    const invalid = signature.slice(0, -1) + (signature.endsWith("0") ? "1" : "0");
    expect(verifySignature(body, invalid, secret)).toBe(false);
  });

  it("returns false for a wrong-length signature", () => {
    expect(verifySignature(body, "tooshort", secret)).toBe(false);
  });

  it("skips verification and returns true when secret is empty", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(verifySignature(body, undefined, "")).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      "[WARN] LINEAR_WEBHOOK_SECRET not set — skipping verification",
    );
    warnSpy.mockRestore();
  });

  it("returns false when signature is undefined but secret is configured", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "[WARN] No signature header — rejecting",
    );
    warnSpy.mockRestore();
  });

  it("returns false when signature is an empty string with secret configured", () => {
    expect(verifySignature(body, "", secret)).toBe(false);
  });

  it("produces different signatures for different body content", () => {
    const body1 = Buffer.from('{"action":"create"}');
    const body2 = Buffer.from('{"action":"update"}');
    const sig1 = sign(body1, secret);
    const sig2 = sign(body2, secret);

    expect(verifySignature(body1, sig1, secret)).toBe(true);
    expect(verifySignature(body2, sig2, secret)).toBe(true);
    // Cross-verify: sig1 should not verify body2
    expect(verifySignature(body2, sig1, secret)).toBe(false);
    expect(verifySignature(body1, sig2, secret)).toBe(false);
  });
});
