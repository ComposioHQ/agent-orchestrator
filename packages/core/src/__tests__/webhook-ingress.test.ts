import { describe, it, expect, beforeEach } from "vitest";
import { WebhookIngress } from "../webhook-ingress.js";
import type { SCMWebhookEvent } from "../types.js";
import { createHmac } from "node:crypto";

function makeSignature(secret: string, payload: string): string {
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${sig}`;
}

describe("WebhookIngress", () => {
  let ingress: WebhookIngress;
  const secret = "test-secret-key";

  beforeEach(() => {
    ingress = new WebhookIngress({ port: 3000, secret });
  });

  describe("verifySignature", () => {
    it("returns true for valid HMAC signature (explicit secret)", () => {
      const payload = JSON.stringify({ action: "opened" });
      const sig = makeSignature(secret, payload);
      expect(ingress.verifySignature(payload, sig, secret)).toBe(true);
    });

    it("returns true for valid HMAC signature (config secret fallback)", () => {
      const payload = JSON.stringify({ action: "opened" });
      const sig = makeSignature(secret, payload);
      expect(ingress.verifySignature(payload, sig)).toBe(true);
    });

    it("returns false for invalid HMAC signature", () => {
      const payload = JSON.stringify({ action: "opened" });
      const badSig = "sha256=deadbeefdeadbeefdeadbeefdeadbeef";
      expect(ingress.verifySignature(payload, badSig, secret)).toBe(false);
    });

    it("returns false for empty signature", () => {
      const payload = JSON.stringify({ action: "opened" });
      expect(ingress.verifySignature(payload, "", secret)).toBe(false);
    });

    it("explicit secret overrides config secret", () => {
      const otherSecret = "other-secret";
      const payload = JSON.stringify({ action: "closed" });
      const sig = makeSignature(otherSecret, payload);
      // Should fail with config secret
      expect(ingress.verifySignature(payload, sig)).toBe(false);
      // Should pass with explicit override
      expect(ingress.verifySignature(payload, sig, otherSecret)).toBe(true);
    });
  });

  describe("checkAndRecordDelivery", () => {
    it("returns false for a new delivery (records it)", () => {
      expect(ingress.checkAndRecordDelivery("delivery-abc-123", "push")).toBe(false);
    });

    it("returns true for an already-recorded delivery", () => {
      ingress.checkAndRecordDelivery("delivery-xyz-456", "pull_request");
      expect(ingress.checkAndRecordDelivery("delivery-xyz-456", "pull_request")).toBe(true);
    });

    it("is idempotent — repeated calls for same ID always return true", () => {
      ingress.checkAndRecordDelivery("dup-789", "push");
      expect(ingress.checkAndRecordDelivery("dup-789", "push")).toBe(true);
      expect(ingress.checkAndRecordDelivery("dup-789", "push")).toBe(true);
    });

    it("evicts oldest entry when at capacity", () => {
      // Access private field to set a small cap for testing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ingress as any).maxDeliveryEntries = 3;

      ingress.checkAndRecordDelivery("d-1", "push");
      ingress.checkAndRecordDelivery("d-2", "push");
      ingress.checkAndRecordDelivery("d-3", "push");
      // At capacity — adding d-4 should evict d-1
      ingress.checkAndRecordDelivery("d-4", "push");
      expect(ingress.checkAndRecordDelivery("d-1", "push")).toBe(false); // evicted, re-recorded
      expect(ingress.checkAndRecordDelivery("d-4", "push")).toBe(true);  // still present
    });
  });

  describe("enqueue / dequeue / getQueueLength", () => {
    function makeEvent(id: string): SCMWebhookEvent {
      return {
        provider: "github",
        kind: "pull_request",
        action: "opened",
        rawEventType: "pull_request",
        deliveryId: id,
        data: {},
      };
    }

    it("FIFO ordering: first enqueued is first dequeued", () => {
      ingress.enqueue(makeEvent("evt-1"));
      ingress.enqueue(makeEvent("evt-2"));
      ingress.enqueue(makeEvent("evt-3"));
      expect(ingress.dequeue()?.deliveryId).toBe("evt-1");
      expect(ingress.dequeue()?.deliveryId).toBe("evt-2");
      expect(ingress.dequeue()?.deliveryId).toBe("evt-3");
    });

    it("dequeue returns null when empty", () => {
      expect(ingress.dequeue()).toBeNull();
    });

    it("getQueueLength tracks correctly", () => {
      expect(ingress.getQueueLength()).toBe(0);
      ingress.enqueue(makeEvent("evt-a"));
      expect(ingress.getQueueLength()).toBe(1);
      ingress.enqueue(makeEvent("evt-b"));
      expect(ingress.getQueueLength()).toBe(2);
      ingress.dequeue();
      expect(ingress.getQueueLength()).toBe(1);
      ingress.dequeue();
      expect(ingress.getQueueLength()).toBe(0);
    });
  });
});
