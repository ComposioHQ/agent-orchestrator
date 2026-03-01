import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(
  body: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!secret) {
    console.warn("[WARN] LINEAR_WEBHOOK_SECRET not set — skipping verification");
    return true;
  }

  if (!signature) {
    console.warn("[WARN] No signature header — rejecting");
    return false;
  }

  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  const expected = hmac.digest("hex");

  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
