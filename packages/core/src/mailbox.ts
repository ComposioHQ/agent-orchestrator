/**
 * Mailbox — File-based Agent-to-Agent Messaging
 *
 * Enables structured, reliable communication between orchestrator and sessions
 * without requiring agent modifications. Uses file-based message passing
 * inspired by Claude Code's agent teams implementation.
 *
 * Architecture:
 * - Each session has inbox/ and outbox/ directories
 * - Messages are JSON files with structured schema
 * - Atomic writes using tempfile + rename pattern
 * - Acknowledgment support for reliable delivery
 * - Message history preserved in processed/ directory
 *
 * Usage:
 *   const mailbox = new Mailbox(dataDir, "ao-1");
 *   await mailbox.send("ao-10", {
 *     type: "fix_ci_failure",
 *     payload: { pr: "...", check: "lint", error: "..." },
 *     priority: "high",
 *     requiresAck: true
 *   });
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SessionId } from "./types.js";

// =============================================================================
// Message Types
// =============================================================================

/** Message priority levels */
export type MessagePriority = "urgent" | "high" | "normal" | "low";

/** Standard message types for routing */
export type MessageType =
  | "fix_ci_failure"
  | "fix_review_comments"
  | "status_request"
  | "status_response"
  | "shutdown"
  | "ack"
  | "error"
  | "custom";

/** A structured message between sessions */
export interface Message {
  /** Unique message ID (uuid) */
  id: string;

  /** Sender session ID */
  from: SessionId;

  /** Recipient session ID */
  to: SessionId;

  /** ISO 8601 timestamp */
  timestamp: string;

  /** Message type for routing */
  type: MessageType;

  /** Priority (urgent messages shown first) */
  priority: MessagePriority;

  /** Message payload (type-specific) */
  payload: Record<string, unknown>;

  /** Does this message require acknowledgment? */
  requiresAck: boolean;

  /** Acknowledgment timestamp (if acked) */
  ackedAt?: string;

  /** Reply to message ID (for threading) */
  replyTo?: string;
}

/** Options for creating a new message */
export type MessageInput = Omit<Message, "id" | "from" | "timestamp"> & {
  id?: string;
  timestamp?: string;
};

/** Options for receiving messages */
export interface ReceiveOptions {
  /** Filter by message type */
  type?: MessageType;

  /** Only return unread messages */
  unreadOnly?: boolean;

  /** Max number of messages to return */
  limit?: number;
}

/** Options for waiting for acknowledgment */
export interface WaitForAckOptions {
  /** Timeout in milliseconds (default: 60000) */
  timeout?: number;

  /** Polling interval in milliseconds (default: 1000) */
  pollInterval?: number;
}

// =============================================================================
// Mailbox Class
// =============================================================================

/**
 * Mailbox service for file-based agent-to-agent messaging.
 *
 * Each session gets inbox/ and outbox/ directories at:
 *   {dataDir}/{sessionId}/inbox/
 *   {dataDir}/{sessionId}/outbox/
 *
 * Messages are JSON files named:
 *   {timestamp}-{id}-{type}.json
 *
 * Example:
 *   20260216T204500Z-abc123-fix_ci_failure.json
 */
export class Mailbox {
  /**
   * Create a mailbox for a session.
   *
   * @param dataDir - Base directory for all session data (e.g. ~/.ao-sessions)
   * @param sessionId - This session's ID (e.g. "ao-1")
   */
  constructor(
    private readonly dataDir: string,
    private readonly sessionId: SessionId,
  ) {}

  /**
   * Send a message to another session.
   *
   * Writes message to recipient's inbox directory with atomic write
   * (tempfile + rename) to prevent partial reads.
   *
   * @param to - Recipient session ID
   * @param message - Message content (id, from, timestamp auto-filled)
   * @returns Message ID
   *
   * @example
   * const msgId = await mailbox.send("ao-10", {
   *   type: "fix_ci_failure",
   *   payload: { pr: "...", check: "lint", error: "..." },
   *   priority: "high",
   *   requiresAck: true
   * });
   */
  async send(to: SessionId, message: Omit<MessageInput, "to">): Promise<string> {
    const msg: Message = {
      id: message.id ?? randomUUID(),
      from: this.sessionId,
      to,
      timestamp: message.timestamp ?? new Date().toISOString(),
      type: message.type,
      priority: message.priority ?? "normal",
      payload: message.payload,
      requiresAck: message.requiresAck ?? false,
      replyTo: message.replyTo,
    };

    // Generate filename: timestamp-id-type.json
    // Remove colons from timestamp for filesystem compatibility
    const timestamp = msg.timestamp.replace(/[:.]/g, "");
    const filename = `${timestamp}-${msg.id}-${msg.type}.json`;
    const inboxPath = join(this.dataDir, to, "inbox", filename);

    // Atomic write
    await this.atomicWrite(inboxPath, JSON.stringify(msg, null, 2));

    return msg.id;
  }

  /**
   * Receive messages from this session's inbox.
   *
   * Reads JSON files from inbox directory, parses them, and optionally
   * filters by type and ack status.
   *
   * @param opts - Filter options (type, unreadOnly, limit)
   * @returns Array of messages sorted by timestamp (oldest first)
   *
   * @example
   * // Get all unread messages
   * const messages = await mailbox.receive({ unreadOnly: true });
   *
   * // Get only CI failure messages
   * const ciMessages = await mailbox.receive({ type: "fix_ci_failure" });
   */
  async receive(opts?: ReceiveOptions): Promise<Message[]> {
    const inboxPath = join(this.dataDir, this.sessionId, "inbox");

    // Ensure inbox directory exists
    try {
      await mkdir(inboxPath, { recursive: true });
    } catch {
      // Directory might already exist
    }

    let files: string[];
    try {
      files = await readdir(inboxPath);
    } catch {
      // Inbox doesn't exist or isn't readable
      return [];
    }

    const messages: Message[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      try {
        const content = await readFile(join(inboxPath, file), "utf-8");
        const msg = JSON.parse(content) as Message;

        // Apply filters
        if (opts?.type && msg.type !== opts.type) continue;
        if (opts?.unreadOnly && msg.ackedAt) continue;

        messages.push(msg);
      } catch (err: unknown) {
        // Skip malformed message files
        console.error(`Failed to parse message file ${file}:`, err);
      }
    }

    // Sort by timestamp (oldest first)
    messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Apply limit
    if (opts?.limit) {
      return messages.slice(0, opts.limit);
    }

    return messages;
  }

  /**
   * Mark a message as acknowledged.
   *
   * Updates the message file with ack timestamp and moves it to
   * inbox/processed/ directory for archival.
   *
   * @param messageId - Message ID to acknowledge
   *
   * @example
   * const messages = await mailbox.receive({ unreadOnly: true });
   * for (const msg of messages) {
   *   // Process message...
   *   await mailbox.ack(msg.id);
   * }
   */
  async ack(messageId: string): Promise<void> {
    const inboxPath = join(this.dataDir, this.sessionId, "inbox");
    const processedPath = join(inboxPath, "processed");

    await mkdir(processedPath, { recursive: true });

    // Find message file
    const files = await readdir(inboxPath);
    const msgFile = files.find((f) => f.includes(messageId));
    if (!msgFile) {
      // Message not found (already processed or invalid ID)
      return;
    }

    // Update message with ack timestamp
    const msgPath = join(inboxPath, msgFile);
    const content = await readFile(msgPath, "utf-8");
    const msg = JSON.parse(content) as Message;
    msg.ackedAt = new Date().toISOString();

    // Write updated message
    await this.atomicWrite(msgPath, JSON.stringify(msg, null, 2));

    // Move to processed/
    await rename(msgPath, join(processedPath, msgFile));
  }

  /**
   * Wait for acknowledgment of a sent message.
   *
   * Checks for explicit ack messages in the sender's inbox. The ack message
   * should have `replyTo` field set to the original message ID.
   *
   * @param messageId - Message ID to wait for
   * @param opts - Timeout and polling interval options
   * @returns true if acked within timeout, false if timeout
   *
   * @example
   * const msgId = await mailbox.send("ao-10", {
   *   type: "fix_ci_failure",
   *   payload: { ... },
   *   requiresAck: true
   * });
   *
   * const acked = await mailbox.waitForAck(msgId, { timeout: 30000 });
   * if (!acked) {
   *   console.error("Message not acknowledged within 30s");
   * }
   */
  async waitForAck(messageId: string, opts?: WaitForAckOptions): Promise<boolean> {
    const timeout = opts?.timeout ?? 60_000;
    const pollInterval = opts?.pollInterval ?? 1000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      // Check inbox for explicit ack message
      const ackMessages = await this.receive({ type: "ack", unreadOnly: true });
      const ackMsg = ackMessages.find((m) => m.replyTo === messageId);
      if (ackMsg) {
        await this.ack(ackMsg.id);
        return true;
      }

      await sleep(pollInterval);
    }

    return false;
  }

  /**
   * Get the count of unread messages in inbox.
   *
   * @returns Number of unread messages
   */
  async getUnreadCount(): Promise<number> {
    const messages = await this.receive({ unreadOnly: true });
    return messages.length;
  }

  /**
   * Clear all processed messages older than the specified age.
   *
   * @param maxAgeMs - Max age in milliseconds (default: 30 days)
   * @returns Number of messages deleted
   *
   * @example
   * // Delete messages older than 7 days
   * await mailbox.clearOldMessages(7 * 24 * 60 * 60 * 1000);
   */
  async clearOldMessages(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    const processedPath = join(this.dataDir, this.sessionId, "inbox", "processed");

    let files: string[];
    try {
      files = await readdir(processedPath);
    } catch {
      return 0;
    }

    const now = Date.now();
    let deleted = 0;

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const msgPath = join(processedPath, file);
      try {
        const content = await readFile(msgPath, "utf-8");
        const msg = JSON.parse(content) as Message;

        const msgAge = now - new Date(msg.timestamp).getTime();
        if (msgAge > maxAgeMs) {
          const { unlink } = await import("node:fs/promises");
          await unlink(msgPath);
          deleted++;
        }
      } catch {
        // Skip invalid files
      }
    }

    return deleted;
  }

  /**
   * Atomic write using tempfile + rename pattern.
   *
   * Prevents partial reads during concurrent access by writing to
   * a temporary file first, then atomically renaming it to the
   * final path. This is safe on all POSIX filesystems.
   *
   * @private
   */
  private async atomicWrite(path: string, content: string): Promise<void> {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });

    const tmpPath = `${path}.tmp.${randomUUID()}`;
    try {
      await writeFile(tmpPath, content, "utf-8");
      await rename(tmpPath, path);
    } catch (err: unknown) {
      // Clean up temp file on error
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create inbox and outbox directories for a session.
 *
 * Call this when spawning a new session to ensure mailbox directories exist.
 *
 * @param dataDir - Base directory for session data
 * @param sessionId - Session ID
 *
 * @example
 * await initializeSessionMailbox("~/.ao-sessions", "ao-10");
 */
export async function initializeSessionMailbox(dataDir: string, sessionId: SessionId): Promise<void> {
  const inboxPath = join(dataDir, sessionId, "inbox");
  const outboxPath = join(dataDir, sessionId, "outbox");
  const processedPath = join(inboxPath, "processed");

  await mkdir(inboxPath, { recursive: true });
  await mkdir(outboxPath, { recursive: true });
  await mkdir(processedPath, { recursive: true });
}

/**
 * Format a message for display to an agent.
 *
 * Converts structured message into human-readable text that can be
 * injected into the agent's input stream.
 *
 * @param message - Message to format
 * @returns Formatted text
 *
 * @example
 * const text = formatMessageForAgent(message);
 * await runtime.sendMessage(handle, text);
 */
export function formatMessageForAgent(message: Message): string {
  const timestamp = new Date(message.timestamp).toLocaleString();
  const emoji = getEmojiForMessageType(message.type);

  let text = `${emoji} Message from ${message.from}\n`;
  text += `Time: ${timestamp}\n`;
  text += `Priority: ${message.priority}\n\n`;

  // Type-specific formatting
  switch (message.type) {
    case "fix_ci_failure":
      text += "🔧 CI FAILURE DETECTED\n\n";
      text += `Your PR has a failing CI check. Please fix:\n\n`;
      text += `Error: ${message.payload["error"] ?? "Unknown"}\n`;
      text += `PR: ${message.payload["pr"] ?? "Unknown"}\n`;
      text += `Check: ${message.payload["check"] ?? "Unknown"}\n`;
      break;

    case "fix_review_comments":
      text += "📝 REVIEW COMMENTS\n\n";
      text += `Your PR has unresolved review comments. Please address them:\n\n`;
      if (Array.isArray(message.payload["comments"])) {
        for (const comment of message.payload["comments"] as Array<Record<string, unknown>>) {
          text += `- ${comment["path"] ?? ""}:${comment["line"] ?? ""} - ${comment["body"] ?? ""}\n`;
        }
      }
      text += `\nPR: ${message.payload["pr"] ?? "Unknown"}\n`;
      break;

    case "status_request":
      text += "📊 STATUS REQUEST\n\n";
      text += `Please provide a status update on your current task.\n\n`;
      text += `Include: current branch, PR status, blockers, ETA.\n`;
      break;

    case "shutdown":
      text += "🛑 SHUTDOWN REQUEST\n\n";
      text += `The orchestrator is requesting you to shut down.\n\n`;
      text += `Reason: ${message.payload["reason"] ?? "Unknown"}\n`;
      break;

    case "ack":
      text += "✅ ACKNOWLEDGMENT\n\n";
      text += `Message acknowledged: ${message.replyTo ?? "unknown"}\n`;
      if (message.payload["text"]) {
        text += `\nResponse: ${message.payload["text"]}\n`;
      }
      break;

    case "error":
      text += "❌ ERROR\n\n";
      text += `An error occurred:\n\n`;
      text += `${message.payload["error"] ?? "Unknown error"}\n`;
      break;

    default:
      // Custom or unknown message type
      if (message.payload["text"]) {
        text += `${message.payload["text"]}\n`;
      } else {
        text += JSON.stringify(message.payload, null, 2);
      }
  }

  if (message.requiresAck) {
    text += `\n⚠️  This message requires acknowledgment.`;
  }

  return text;
}

/** Get emoji for message type */
function getEmojiForMessageType(type: MessageType): string {
  switch (type) {
    case "fix_ci_failure":
      return "🔧";
    case "fix_review_comments":
      return "📝";
    case "status_request":
      return "📊";
    case "status_response":
      return "✅";
    case "shutdown":
      return "🛑";
    case "ack":
      return "✅";
    case "error":
      return "❌";
    default:
      return "📬";
  }
}
