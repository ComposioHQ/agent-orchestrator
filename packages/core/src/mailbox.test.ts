/**
 * Mailbox unit tests
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mailbox, formatMessageForAgent, initializeSessionMailbox, type Message } from "./mailbox.js";

describe("Mailbox", () => {
  let testDir: string;
  let mailbox: Mailbox;

  beforeEach(async () => {
    // Create temp directory for test
    testDir = await mkdtemp(join(tmpdir(), "ao-mailbox-test-"));
    mailbox = new Mailbox(testDir, "ao-1");

    // Initialize session directories
    await initializeSessionMailbox(testDir, "ao-1");
    await initializeSessionMailbox(testDir, "ao-10");
  });

  afterEach(async () => {
    // Clean up temp directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe("send()", () => {
    it("sends a message to inbox", async () => {
      const msgId = await mailbox.send("ao-10", {
        type: "fix_ci_failure",
        payload: { pr: "https://github.com/org/repo/pull/123", check: "lint", error: "Missing semicolon" },
        priority: "high",
        requiresAck: true,
      });

      // Check inbox file exists
      const inboxFiles = await readdir(join(testDir, "ao-10", "inbox"));
      const msgFile = inboxFiles.find((f) => f.includes(msgId));
      expect(msgFile).toBeDefined();

      // Verify message content
      const content = await readFile(join(testDir, "ao-10", "inbox", msgFile!), "utf-8");
      const msg = JSON.parse(content) as Message;

      expect(msg.id).toBe(msgId);
      expect(msg.from).toBe("ao-1");
      expect(msg.to).toBe("ao-10");
      expect(msg.type).toBe("fix_ci_failure");
      expect(msg.priority).toBe("high");
      expect(msg.requiresAck).toBe(true);
      expect(msg.payload).toEqual({
        pr: "https://github.com/org/repo/pull/123",
        check: "lint",
        error: "Missing semicolon",
      });
    });

    it("generates unique message IDs", async () => {
      const msgId1 = await mailbox.send("ao-10", {
        type: "status_request",
        payload: { text: "Status?" },
        priority: "normal",
        requiresAck: false,
      });

      const msgId2 = await mailbox.send("ao-10", {
        type: "status_request",
        payload: { text: "Status?" },
        priority: "normal",
        requiresAck: false,
      });

      expect(msgId1).not.toBe(msgId2);
    });

    it("uses atomic writes (tempfile + rename)", async () => {
      const msgId = await mailbox.send("ao-10", {
        type: "custom",
        payload: { text: "Test" },
        priority: "normal",
        requiresAck: false,
      });

      const inboxFiles = await readdir(join(testDir, "ao-10", "inbox"));

      // Should not have any .tmp files left
      const tmpFiles = inboxFiles.filter((f) => f.includes(".tmp"));
      expect(tmpFiles).toHaveLength(0);

      // Should have the final message file
      const msgFiles = inboxFiles.filter((f) => f.includes(msgId) && f.endsWith(".json"));
      expect(msgFiles).toHaveLength(1);
    });
  });

  describe("receive()", () => {
    it("receives messages from inbox", async () => {
      // Send two messages
      await mailbox.send("ao-10", {
        type: "fix_ci_failure",
        payload: { error: "Test error 1" },
        priority: "high",
        requiresAck: true,
      });

      await mailbox.send("ao-10", {
        type: "status_request",
        payload: { text: "Status?" },
        priority: "normal",
        requiresAck: false,
      });

      // Receive from ao-10's perspective
      const ao10Mailbox = new Mailbox(testDir, "ao-10");
      const messages = await ao10Mailbox.receive();

      expect(messages).toHaveLength(2);
      expect(messages[0]?.type).toBe("fix_ci_failure");
      expect(messages[1]?.type).toBe("status_request");
    });

    it("filters by message type", async () => {
      await mailbox.send("ao-10", {
        type: "fix_ci_failure",
        payload: { error: "CI error" },
        priority: "high",
        requiresAck: true,
      });

      await mailbox.send("ao-10", {
        type: "status_request",
        payload: { text: "Status?" },
        priority: "normal",
        requiresAck: false,
      });

      const ao10Mailbox = new Mailbox(testDir, "ao-10");
      const ciMessages = await ao10Mailbox.receive({ type: "fix_ci_failure" });

      expect(ciMessages).toHaveLength(1);
      expect(ciMessages[0]?.type).toBe("fix_ci_failure");
    });

    it("filters unread messages", async () => {
      const msgId = await mailbox.send("ao-10", {
        type: "status_request",
        payload: { text: "Status?" },
        priority: "normal",
        requiresAck: false,
      });

      const ao10Mailbox = new Mailbox(testDir, "ao-10");

      // All messages unread
      let unread = await ao10Mailbox.receive({ unreadOnly: true });
      expect(unread).toHaveLength(1);

      // Mark as read
      await ao10Mailbox.ack(msgId);

      // No unread messages
      unread = await ao10Mailbox.receive({ unreadOnly: true });
      expect(unread).toHaveLength(0);
    });

    it("sorts messages by timestamp", async () => {
      // Send messages in sequence
      const msg1Id = await mailbox.send("ao-10", {
        type: "custom",
        payload: { seq: 1 },
        priority: "normal",
        requiresAck: false,
      });

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      const msg2Id = await mailbox.send("ao-10", {
        type: "custom",
        payload: { seq: 2 },
        priority: "normal",
        requiresAck: false,
      });

      const ao10Mailbox = new Mailbox(testDir, "ao-10");
      const messages = await ao10Mailbox.receive();

      expect(messages).toHaveLength(2);
      expect(messages[0]?.id).toBe(msg1Id);
      expect(messages[1]?.id).toBe(msg2Id);
      expect(messages[0]?.payload["seq"]).toBe(1);
      expect(messages[1]?.payload["seq"]).toBe(2);
    });

    it("returns empty array if inbox doesn't exist", async () => {
      const newMailbox = new Mailbox(testDir, "ao-99");
      const messages = await newMailbox.receive();
      expect(messages).toEqual([]);
    });

    it("skips malformed message files", async () => {
      // Send valid message
      await mailbox.send("ao-10", {
        type: "status_request",
        payload: { text: "Valid" },
        priority: "normal",
        requiresAck: false,
      });

      // Write malformed message
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        join(testDir, "ao-10", "inbox", "malformed.json"),
        "{ invalid json",
        "utf-8",
      );

      const ao10Mailbox = new Mailbox(testDir, "ao-10");
      const messages = await ao10Mailbox.receive();

      // Should only get the valid message
      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload["text"]).toBe("Valid");
    });
  });

  describe("ack()", () => {
    it("marks message as acknowledged", async () => {
      const msgId = await mailbox.send("ao-10", {
        type: "status_request",
        payload: { text: "Status?" },
        priority: "normal",
        requiresAck: true,
      });

      const ao10Mailbox = new Mailbox(testDir, "ao-10");

      // Small delay to ensure ack timestamp is different
      await new Promise((resolve) => setTimeout(resolve, 10));
      await ao10Mailbox.ack(msgId);

      // Check message moved to processed/
      const processedFiles = await readdir(join(testDir, "ao-10", "inbox", "processed"));
      const msgFile = processedFiles.find((f) => f.includes(msgId));
      expect(msgFile).toBeDefined();

      // Verify ackedAt timestamp
      const content = await readFile(join(testDir, "ao-10", "inbox", "processed", msgFile!), "utf-8");
      const msg = JSON.parse(content) as Message;
      expect(msg.ackedAt).toBeDefined();
      expect(new Date(msg.ackedAt!).getTime()).toBeGreaterThanOrEqual(new Date(msg.timestamp).getTime());
    });

    it("removes message from inbox after ack", async () => {
      const msgId = await mailbox.send("ao-10", {
        type: "status_request",
        payload: { text: "Status?" },
        priority: "normal",
        requiresAck: true,
      });

      const ao10Mailbox = new Mailbox(testDir, "ao-10");
      await ao10Mailbox.ack(msgId);

      // Message should not be in inbox anymore
      const inboxFiles = await readdir(join(testDir, "ao-10", "inbox"));
      const msgInInbox = inboxFiles.find((f) => f.includes(msgId) && f.endsWith(".json"));
      expect(msgInInbox).toBeUndefined();
    });

    it("does nothing if message not found", async () => {
      const ao10Mailbox = new Mailbox(testDir, "ao-10");

      // Should not throw
      await expect(ao10Mailbox.ack("nonexistent-id")).resolves.toBeUndefined();
    });
  });

  describe("waitForAck()", () => {
    it("returns true when explicit ack message is sent", async () => {
      const msgId = await mailbox.send("ao-10", {
        type: "status_request",
        payload: { text: "Status?" },
        priority: "normal",
        requiresAck: true,
      });

      // Send explicit ack message in background after 100ms
      const ao10Mailbox = new Mailbox(testDir, "ao-10");
      setTimeout(() => {
        void ao10Mailbox.send("ao-1", {
          type: "ack",
          payload: { text: "Acknowledged" },
          replyTo: msgId,
          priority: "normal",
          requiresAck: false,
        });
      }, 100);

      const acked = await mailbox.waitForAck(msgId, { timeout: 5000, pollInterval: 50 });
      expect(acked).toBe(true);
    });


    it("returns false on timeout", async () => {
      const msgId = await mailbox.send("ao-10", {
        type: "status_request",
        payload: { text: "Status?" },
        priority: "normal",
        requiresAck: true,
      });

      // Don't ack
      const acked = await mailbox.waitForAck(msgId, { timeout: 500, pollInterval: 100 });
      expect(acked).toBe(false);
    });
  });

  describe("getUnreadCount()", () => {
    it("returns count of unread messages", async () => {
      await mailbox.send("ao-10", {
        type: "custom",
        payload: { text: "Message 1" },
        priority: "normal",
        requiresAck: false,
      });

      const msgId2 = await mailbox.send("ao-10", {
        type: "custom",
        payload: { text: "Message 2" },
        priority: "normal",
        requiresAck: false,
      });

      const ao10Mailbox = new Mailbox(testDir, "ao-10");

      // Two unread
      let count = await ao10Mailbox.getUnreadCount();
      expect(count).toBe(2);

      // Ack one
      await ao10Mailbox.ack(msgId2);

      // One unread
      count = await ao10Mailbox.getUnreadCount();
      expect(count).toBe(1);
    });
  });

  describe("clearOldMessages()", () => {
    it("deletes old processed messages", async () => {
      // Send and ack a message
      const msgId = await mailbox.send("ao-10", {
        type: "custom",
        // Set old timestamp (31 days ago)
        timestamp: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        payload: { text: "Old message" },
        priority: "normal",
        requiresAck: false,
      });

      const ao10Mailbox = new Mailbox(testDir, "ao-10");
      await ao10Mailbox.ack(msgId);

      // Clear messages older than 30 days
      const deleted = await ao10Mailbox.clearOldMessages(30 * 24 * 60 * 60 * 1000);
      expect(deleted).toBe(1);

      // Verify message is gone
      const processedFiles = await readdir(join(testDir, "ao-10", "inbox", "processed"));
      const msgFile = processedFiles.find((f) => f.includes(msgId));
      expect(msgFile).toBeUndefined();
    });

    it("keeps recent messages", async () => {
      // Send and ack a recent message
      const msgId = await mailbox.send("ao-10", {
        type: "custom",
        payload: { text: "Recent message" },
        priority: "normal",
        requiresAck: false,
      });

      const ao10Mailbox = new Mailbox(testDir, "ao-10");
      await ao10Mailbox.ack(msgId);

      // Clear old messages
      const deleted = await ao10Mailbox.clearOldMessages(30 * 24 * 60 * 60 * 1000);
      expect(deleted).toBe(0);

      // Verify message still exists
      const processedFiles = await readdir(join(testDir, "ao-10", "inbox", "processed"));
      const msgFile = processedFiles.find((f) => f.includes(msgId));
      expect(msgFile).toBeDefined();
    });
  });
});

describe("initializeSessionMailbox()", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "ao-mailbox-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("creates inbox, outbox, and processed directories", async () => {
    await initializeSessionMailbox(testDir, "ao-test");

    const inboxPath = join(testDir, "ao-test", "inbox");
    const outboxPath = join(testDir, "ao-test", "outbox");
    const processedPath = join(inboxPath, "processed");

    // Check directories exist
    const { access } = await import("node:fs/promises");
    await expect(access(inboxPath)).resolves.toBeUndefined();
    await expect(access(outboxPath)).resolves.toBeUndefined();
    await expect(access(processedPath)).resolves.toBeUndefined();
  });
});

describe("formatMessageForAgent()", () => {
  it("formats fix_ci_failure message", () => {
    const message: Message = {
      id: "test-123",
      from: "ao-1",
      to: "ao-10",
      timestamp: "2026-02-16T20:45:00Z",
      type: "fix_ci_failure",
      priority: "high",
      payload: {
        pr: "https://github.com/org/repo/pull/123",
        check: "lint",
        error: "Missing semicolon at line 42",
      },
      requiresAck: true,
    };

    const text = formatMessageForAgent(message);

    expect(text).toContain("🔧 CI FAILURE DETECTED");
    expect(text).toContain("Missing semicolon at line 42");
    expect(text).toContain("https://github.com/org/repo/pull/123");
    expect(text).toContain("lint");
    expect(text).toContain("This message requires acknowledgment");
  });

  it("formats fix_review_comments message", () => {
    const message: Message = {
      id: "test-123",
      from: "ao-1",
      to: "ao-10",
      timestamp: "2026-02-16T20:45:00Z",
      type: "fix_review_comments",
      priority: "normal",
      payload: {
        pr: "https://github.com/org/repo/pull/123",
        comments: [
          { path: "src/index.ts", line: 42, body: "Add error handling" },
          { path: "src/utils.ts", line: 10, body: "Use const instead of let" },
        ],
      },
      requiresAck: false,
    };

    const text = formatMessageForAgent(message);

    expect(text).toContain("📝 REVIEW COMMENTS");
    expect(text).toContain("src/index.ts:42 - Add error handling");
    expect(text).toContain("src/utils.ts:10 - Use const instead of let");
  });

  it("formats status_request message", () => {
    const message: Message = {
      id: "test-123",
      from: "ao-1",
      to: "ao-10",
      timestamp: "2026-02-16T20:45:00Z",
      type: "status_request",
      priority: "normal",
      payload: {},
      requiresAck: false,
    };

    const text = formatMessageForAgent(message);

    expect(text).toContain("📊 STATUS REQUEST");
    expect(text).toContain("current branch, PR status, blockers, ETA");
  });

  it("formats custom message with text payload", () => {
    const message: Message = {
      id: "test-123",
      from: "ao-1",
      to: "ao-10",
      timestamp: "2026-02-16T20:45:00Z",
      type: "custom",
      priority: "normal",
      payload: {
        text: "This is a custom message",
      },
      requiresAck: false,
    };

    const text = formatMessageForAgent(message);

    expect(text).toContain("This is a custom message");
  });
});
