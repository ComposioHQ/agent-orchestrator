import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveCommsFiles,
  createCommsFiles,
  removeCommsFiles,
  appendMessage,
  appendInboxMessage,
  readNewMessages,

  readEpoch,
  writeEpoch,
  generateDedupKey,
} from "../file-transport.js";

describe("file-transport", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ao-file-transport-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("resolveCommsFiles", () => {
    it("returns correct paths for a session", () => {
      const files = resolveCommsFiles(tempDir, "int-1");
      expect(files.dir).toBe(join(tempDir, "int-1", "comms"));
      expect(files.inbox).toBe(join(tempDir, "int-1", "comms", "inbox"));
      expect(files.agentEvents).toBe(join(tempDir, "int-1", "comms", "agent-events"));
      expect(files.systemEvents).toBe(join(tempDir, "int-1", "comms", "system-events"));
    });
  });

  describe("createCommsFiles / removeCommsFiles", () => {
    it("creates all communication files", () => {
      const files = resolveCommsFiles(tempDir, "int-1");
      createCommsFiles(files);

      expect(existsSync(files.inbox)).toBe(true);
      expect(existsSync(files.agentEvents)).toBe(true);
      expect(existsSync(files.systemEvents)).toBe(true);
    });

    it("is idempotent", () => {
      const files = resolveCommsFiles(tempDir, "int-1");
      createCommsFiles(files);
      createCommsFiles(files);
      expect(existsSync(files.inbox)).toBe(true);
    });

    it("removes all communication files", () => {
      const files = resolveCommsFiles(tempDir, "int-1");
      createCommsFiles(files);
      removeCommsFiles(files);
      expect(existsSync(files.dir)).toBe(false);
    });
  });

  describe("appendMessage", () => {
    it("appends a JSONL line to the file", () => {
      const files = resolveCommsFiles(tempDir, "int-1");
      createCommsFiles(files);

      appendMessage(files.agentEvents, "int-1", 1, "agent", "status", "working on task");

      const content = readFileSync(files.agentEvents, "utf-8");
      const parsed = JSON.parse(content.trim());
      expect(parsed.v).toBe(1);
      expect(parsed.id).toBe(1);
      expect(parsed.epoch).toBe(1);
      expect(parsed.source).toBe("agent");
      expect(parsed.type).toBe("status");
      expect(parsed.message).toBe("working on task");
    });

    it("increments message ID monotonically", () => {
      const files = resolveCommsFiles(tempDir, "int-1");
      createCommsFiles(files);

      appendMessage(files.agentEvents, "int-1", 1, "agent", "status", "msg1");
      appendMessage(files.agentEvents, "int-1", 1, "agent", "status", "msg2");

      const lines = readFileSync(files.agentEvents, "utf-8").trim().split("\n");
      const id1 = JSON.parse(lines[0]).id as number;
      const id2 = JSON.parse(lines[1]).id as number;
      expect(id2).toBe(id1 + 1);
    });

    it("throws if message exceeds 4KB", () => {
      const files = resolveCommsFiles(tempDir, "int-1");
      createCommsFiles(files);

      const longMessage = "x".repeat(5000);
      expect(() =>
        appendMessage(files.agentEvents, "int-1", 1, "agent", "status", longMessage),
      ).toThrow("4KB limit");
    });
  });

  describe("appendInboxMessage", () => {
    it("includes dedup key", () => {
      const files = resolveCommsFiles(tempDir, "int-1");
      createCommsFiles(files);

      appendInboxMessage(files.inbox, "int-1", 1, "instruction", "do something", "dedup-123");

      const content = readFileSync(files.inbox, "utf-8");
      const parsed = JSON.parse(content.trim());
      expect(parsed.dedup).toBe("dedup-123");
      expect(parsed.source).toBe("orchestrator");
      expect(parsed.type).toBe("instruction");
    });
  });

  describe("readNewMessages", () => {
    it("reads all messages on first call (no cursor)", () => {
      const files = resolveCommsFiles(tempDir, "int-1");
      createCommsFiles(files);

      appendMessage(files.agentEvents, "int-1", 1, "agent", "status", "msg1");
      appendMessage(files.agentEvents, "int-1", 1, "agent", "status", "msg2");

      const { messages } = readNewMessages(files.agentEvents);
      expect(messages).toHaveLength(2);
      expect(messages[0].message).toBe("msg1");
      expect(messages[1].message).toBe("msg2");
    });

    it("reads only new messages on subsequent calls", () => {
      const files = resolveCommsFiles(tempDir, "int-1");
      createCommsFiles(files);

      appendMessage(files.agentEvents, "int-1", 1, "agent", "status", "msg1");

      const first = readNewMessages(files.agentEvents);
      expect(first.messages).toHaveLength(1);

      appendMessage(files.agentEvents, "int-1", 1, "agent", "status", "msg2");

      const second = readNewMessages(files.agentEvents);
      expect(second.messages).toHaveLength(1);
      expect(second.messages[0].message).toBe("msg2");
    });

    it("returns empty array when no new messages", () => {
      const files = resolveCommsFiles(tempDir, "int-1");
      createCommsFiles(files);

      appendMessage(files.agentEvents, "int-1", 1, "agent", "status", "msg1");
      readNewMessages(files.agentEvents); // consume

      const { messages } = readNewMessages(files.agentEvents);
      expect(messages).toHaveLength(0);
    });

    it("skips corrupt lines in the middle but not at EOF", () => {
      const files = resolveCommsFiles(tempDir, "int-1");
      createCommsFiles(files);

      appendFileSync(files.agentEvents, '{"v":1,"id":1,"epoch":1,"ts":"t","source":"agent","type":"status","message":"good"}\n');
      appendFileSync(files.agentEvents, "corrupt line here\n");
      appendFileSync(files.agentEvents, '{"v":1,"id":2,"epoch":1,"ts":"t","source":"agent","type":"status","message":"also good"}\n');

      const { messages } = readNewMessages(files.agentEvents);
      expect(messages).toHaveLength(2);
      expect(messages[0].message).toBe("good");
      expect(messages[1].message).toBe("also good");
    });

    it("handles file truncation when file is smaller than cursor", () => {
      const files = resolveCommsFiles(tempDir, "int-1");
      createCommsFiles(files);

      // Write two messages to grow the file
      appendMessage(files.agentEvents, "int-1", 1, "agent", "status", "message one with padding");
      appendMessage(files.agentEvents, "int-1", 1, "agent", "status", "message two with padding");
      readNewMessages(files.agentEvents); // advance cursor past both

      // Truncate and write a short message (file size < old cursor)
      writeFileSync(files.agentEvents, "", "utf-8");
      appendFileSync(files.agentEvents, '{"v":1,"id":1,"epoch":1,"ts":"t","source":"agent","type":"status","message":"short"}\n');

      const { messages } = readNewMessages(files.agentEvents);
      expect(messages).toHaveLength(1);
      expect(messages[0].message).toBe("short");
    });
  });

  describe("epoch", () => {
    it("reads 0 for new session", () => {
      expect(readEpoch(tempDir, "int-1")).toBe(0);
    });

    it("writes and reads epoch", () => {
      writeEpoch(tempDir, "int-1", 3);
      expect(readEpoch(tempDir, "int-1")).toBe(3);
    });
  });

  describe("generateDedupKey", () => {
    it("generates unique keys", () => {
      const key1 = generateDedupKey();
      const key2 = generateDedupKey();
      expect(key1).not.toBe(key2);
    });
  });
});
