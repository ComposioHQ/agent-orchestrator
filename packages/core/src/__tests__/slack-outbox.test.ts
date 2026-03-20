import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SlackOutbox } from "../slack-outbox.js";
import type { OutboxEntry, OutboxConfig } from "../slack-outbox.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `slack-outbox-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("SlackOutbox", () => {
  let tmpDir: string;
  let config: OutboxConfig;
  let outbox: SlackOutbox;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    config = {
      outboxPath: join(tmpDir, "outbox.jsonl"),
      deadLetterPath: join(tmpDir, "dead-letter.jsonl"),
      maxRetries: 3,
      timeoutMs: 30000,
    };
    outbox = new SlackOutbox({ config });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("enqueue", () => {
    it("adds entry to outbox", async () => {
      await outbox.enqueue("hello world");
      expect(await outbox.getOutboxLength()).toBe(1);
    });

    it("assigns unique ID and timestamp", async () => {
      await outbox.enqueue("msg1");
      await outbox.enqueue("msg2");
      const lines = readFileSync(config.outboxPath, "utf-8").trim().split("\n");
      const entries = lines.map((l) => JSON.parse(l) as OutboxEntry);
      expect(entries[0].id).toBeTruthy();
      expect(entries[1].id).toBeTruthy();
      expect(entries[0].id).not.toBe(entries[1].id);
      expect(entries[0].createdAt).toBeTruthy();
      expect(entries[0].status).toBe("pending");
      expect(entries[0].attempts).toBe(0);
    });

    it("stores channel and threadTs when provided", async () => {
      await outbox.enqueue("msg", "C123", "1234567.89");
      const entry = JSON.parse(
        readFileSync(config.outboxPath, "utf-8").trim(),
      ) as OutboxEntry;
      expect(entry.channel).toBe("C123");
      expect(entry.threadTs).toBe("1234567.89");
    });

    it("defaults priority to normal", async () => {
      await outbox.enqueue("msg");
      const entry = JSON.parse(
        readFileSync(config.outboxPath, "utf-8").trim(),
      ) as OutboxEntry;
      expect(entry.priority).toBe("normal");
    });
  });

  describe("processNext", () => {
    it("calls sender with entry", async () => {
      await outbox.enqueue("test message");
      let called: OutboxEntry | null = null;
      await outbox.processNext(async (entry) => {
        called = entry;
      });
      expect(called).not.toBeNull();
      expect((called as OutboxEntry).message).toBe("test message");
    });

    it("marks entry as sent on success", async () => {
      await outbox.enqueue("test message");
      await outbox.processNext(async (_entry) => {
        // success — no throw
      });
      expect(await outbox.getOutboxLength()).toBe(0);
    });

    it("increments attempts on failure", async () => {
      await outbox.enqueue("failing message");
      await outbox.processNext(async (_entry) => {
        throw new Error("send failed");
      });
      expect(await outbox.getOutboxLength()).toBe(1);
      const entry = JSON.parse(
        readFileSync(config.outboxPath, "utf-8").trim(),
      ) as OutboxEntry;
      expect(entry.attempts).toBe(1);
      expect(entry.lastError).toBe("send failed");
    });

    it("moves entry to dead letter after maxRetries", async () => {
      await outbox.enqueue("will-die");
      const fail = async (_entry: OutboxEntry): Promise<void> => {
        throw new Error("always fails");
      };
      await outbox.processNext(fail); // attempt 1
      await outbox.processNext(fail); // attempt 2
      await outbox.processNext(fail); // attempt 3 -> dead letter
      expect(await outbox.getOutboxLength()).toBe(0);
      expect(await outbox.getDeadLetterLength()).toBe(1);
    });

    it("returns null when outbox is empty", async () => {
      const result = await outbox.processNext(async (_e) => {});
      expect(result).toBeNull();
    });
  });

  describe("priority ordering", () => {
    it("processes high priority before normal before low", async () => {
      await outbox.enqueue("low msg", undefined, undefined, "low");
      await outbox.enqueue("normal msg", undefined, undefined, "normal");
      await outbox.enqueue("high msg", undefined, undefined, "high");

      const processed: string[] = [];
      await outbox.processNext(async (e) => {
        processed.push(e.message);
      });
      await outbox.processNext(async (e) => {
        processed.push(e.message);
      });
      await outbox.processNext(async (e) => {
        processed.push(e.message);
      });

      expect(processed[0]).toBe("high msg");
      expect(processed[1]).toBe("normal msg");
      expect(processed[2]).toBe("low msg");
    });
  });

  describe("drainOutbox", () => {
    it("processes all pending entries", async () => {
      await outbox.enqueue("msg1");
      await outbox.enqueue("msg2");
      await outbox.enqueue("msg3");

      const processed: string[] = [];
      await outbox.drainOutbox(async (e) => {
        processed.push(e.message);
      });

      expect(processed).toHaveLength(3);
      expect(await outbox.getOutboxLength()).toBe(0);
    });
  });

  describe("parent directory creation", () => {
    it("creates parent dirs for outbox on enqueue", async () => {
      const nestedDir = join(tmpDir, "nested", "deep");
      const nestedConfig: OutboxConfig = {
        ...config,
        outboxPath: join(nestedDir, "outbox.jsonl"),
        deadLetterPath: join(nestedDir, "dead-letter.jsonl"),
      };
      const nestedOutbox = new SlackOutbox({ config: nestedConfig });

      expect(existsSync(nestedDir)).toBe(false);
      await nestedOutbox.enqueue("hello");
      expect(existsSync(nestedDir)).toBe(true);
      expect(await nestedOutbox.getOutboxLength()).toBe(1);
    });

    it("creates parent dirs for dead-letter on move", async () => {
      const dlDir = join(tmpDir, "other", "path");
      const dlConfig: OutboxConfig = {
        ...config,
        deadLetterPath: join(dlDir, "dead-letter.jsonl"),
        maxRetries: 1,
      };
      const dlOutbox = new SlackOutbox({ config: dlConfig });
      await dlOutbox.enqueue("doomed");
      await dlOutbox.processNext(async () => {
        throw new Error("fail");
      });
      expect(existsSync(dlDir)).toBe(true);
      expect(await dlOutbox.getDeadLetterLength()).toBe(1);
    });
  });

  describe("in-flight deduplication", () => {
    it("marks entry as in-flight in JSONL before sending", async () => {
      await outbox.enqueue("test message");
      let statusDuringSend: string | undefined;

      await outbox.processNext(async (_entry) => {
        // While the sender is running, read the JSONL to verify in-flight status
        const raw = readFileSync(config.outboxPath, "utf-8").trim();
        const entries = raw.split("\n").map((l) => JSON.parse(l) as OutboxEntry);
        statusDuringSend = entries[0].status;
      });

      expect(statusDuringSend).toBe("in-flight");
    });

    it("in-flight entries are not picked up by concurrent processNext", async () => {
      await outbox.enqueue("msg1");
      await outbox.enqueue("msg2");

      // First processNext picks msg1 (higher priority by insertion order, same priority)
      // Inside the sender, a second processNext should skip in-flight msg1
      const processed: string[] = [];
      await outbox.processNext(async (entry) => {
        processed.push(entry.message);
        // Simulate a concurrent worker calling processNext while msg1 is in-flight
        const result = await outbox.processNext(async (e) => {
          processed.push(e.message);
        });
        expect(result).not.toBeNull();
      });

      // Both messages should be processed, msg1 first then msg2
      expect(processed).toEqual(["msg1", "msg2"]);
    });
  });

  describe("getOutboxLength / getDeadLetterLength", () => {
    it("tracks outbox length correctly", async () => {
      expect(await outbox.getOutboxLength()).toBe(0);
      await outbox.enqueue("a");
      expect(await outbox.getOutboxLength()).toBe(1);
      await outbox.enqueue("b");
      expect(await outbox.getOutboxLength()).toBe(2);
      await outbox.processNext(async (_e) => {});
      expect(await outbox.getOutboxLength()).toBe(1);
    });

    it("tracks dead letter length correctly", async () => {
      const cfg: OutboxConfig = { ...config, maxRetries: 1 };
      const o = new SlackOutbox({ config: cfg });
      await o.enqueue("doomed");
      const fail = async (_e: OutboxEntry): Promise<void> => {
        throw new Error("x");
      };
      await o.processNext(fail); // attempt 1 -> dead (maxRetries=1)
      expect(await o.getDeadLetterLength()).toBe(1);
    });
  });
});
