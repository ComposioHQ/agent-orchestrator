/**
 * WebhookIngress — HMAC verification, dedup, and event queue
 *
 * Uses Map-based in-memory dedup with bounded FIFO eviction.
 * HTTP server is intentionally excluded — this module handles ingress logic only.
 *
 * TODO: If durable dedup is needed, add a persistence layer behind the
 *       deliveries Map (e.g. better-sqlite3).  The current implementation is
 *       in-memory only, which is sufficient for single-process deployments.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SCMWebhookEvent } from "./types.js";

export interface WebhookIngressConfig {
  /** Port for future HTTP server integration */
  port: number;
  /** HMAC secret for X-Hub-Signature-256 verification */
  secret: string;
  /** Maximum request body size in bytes (default: 10 MB) */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

export class WebhookIngress {
  private readonly config: WebhookIngressConfig;
  private readonly maxBodyBytes: number;
  private readonly maxDeliveryEntries: number;
  private deliveries: Map<string, string>;
  private queue: SCMWebhookEvent[];

  constructor(config: WebhookIngressConfig) {
    this.config = config;
    this.maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.maxDeliveryEntries = 10_000;
    this.deliveries = new Map();
    this.queue = [];
  }

  /**
   * Verify an X-Hub-Signature-256 HMAC signature using constant-time comparison.
   *
   * @param payload   - Raw request body (string or Buffer)
   * @param signature - Value of the X-Hub-Signature-256 header
   * @param secret    - HMAC shared secret (defaults to config.secret)
   * @returns true if the signature is valid, false otherwise
   */
  verifySignature(payload: string | Buffer, signature: string, secret?: string): boolean {
    const effectiveSecret = secret ?? this.config.secret;
    if (!signature || !signature.startsWith("sha256=")) return false;

    const expected = createHmac("sha256", effectiveSecret)
      .update(payload)
      .digest("hex");
    const expectedSig = `sha256=${expected}`;

    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSig);

    // timingSafeEqual requires same-length buffers; length mismatch means mismatch.
    if (a.length !== b.length) return false;

    return timingSafeEqual(a, b);
  }

  /**
   * Atomically check whether a delivery ID has been seen and, if not, record it.
   *
   * Combines the former isDuplicate() + recordDelivery() into a single method
   * to eliminate the race window between check and record.
   *
   * @param deliveryId - Value of the X-GitHub-Delivery header
   * @param eventType  - GitHub event type (e.g. "pull_request", "push")
   * @returns true if the delivery was already recorded (duplicate), false if newly recorded
   */
  checkAndRecordDelivery(deliveryId: string, eventType: string): boolean {
    if (this.deliveries.has(deliveryId)) {
      return true;
    }

    // Evict oldest entries when at capacity (FIFO by insertion order)
    if (this.deliveries.size >= this.maxDeliveryEntries) {
      const firstKey = this.deliveries.keys().next().value;
      if (firstKey !== undefined) this.deliveries.delete(firstKey);
    }
    this.deliveries.set(deliveryId, eventType);
    return false;
  }

  /**
   * Add a normalized webhook event to the FIFO queue for downstream processing.
   */
  enqueue(event: SCMWebhookEvent): void {
    this.queue.push(event);
  }

  /**
   * Remove and return the next event from the queue.
   *
   * @returns The next event, or null if the queue is empty.
   */
  dequeue(): SCMWebhookEvent | null {
    return this.queue.shift() ?? null;
  }

  /**
   * Return the current number of events waiting in the queue.
   */
  getQueueLength(): number {
    return this.queue.length;
  }
}
