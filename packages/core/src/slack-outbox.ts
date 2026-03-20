import { randomUUID } from "node:crypto";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

export interface OutboxEntry {
  id: string;
  message: string;
  channel?: string;
  threadTs?: string;
  priority: "high" | "normal" | "low";
  createdAt: string;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
  status: "pending" | "in-flight" | "sent" | "dead";
}

export interface OutboxConfig {
  outboxPath: string;
  deadLetterPath: string;
  maxRetries: number;
  timeoutMs: number;
}

export interface SlackOutboxDeps {
  config: OutboxConfig;
}

const PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

function readEntries(filePath: string): OutboxEntry[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  const entries: OutboxEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as OutboxEntry);
    } catch {
      // skip malformed JSONL lines (e.g. from interrupted writes)
    }
  }
  return entries;
}

export class SlackOutbox {
  private readonly config: OutboxConfig;
  private readonly inFlightSends = new Set<string>();

  constructor({ config }: SlackOutboxDeps) {
    this.config = config;
  }

  async enqueue(
    message: string,
    channel?: string,
    threadTs?: string,
    priority: string = "normal",
  ): Promise<void> {
    const normalizedPriority = (
      ["high", "normal", "low"].includes(priority) ? priority : "normal"
    ) as OutboxEntry["priority"];
    const entry: OutboxEntry = {
      id: randomUUID(),
      message,
      ...(channel !== undefined && { channel }),
      ...(threadTs !== undefined && { threadTs }),
      priority: normalizedPriority,
      createdAt: new Date().toISOString(),
      attempts: 0,
      status: "pending",
    };
    mkdirSync(dirname(this.config.outboxPath), { recursive: true });
    appendFileSync(this.config.outboxPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  async processNext(sender: (entry: OutboxEntry) => Promise<void>): Promise<OutboxEntry | null> {
    const entries = readEntries(this.config.outboxPath);
    const pending = entries
      .filter((e) => e.status === "pending")
      .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1));

    if (pending.length === 0) return null;

    const entry: OutboxEntry = { ...pending[0] };

    // In-memory guard for same-process concurrency
    if (this.inFlightSends.has(entry.id)) {
      return null;
    }
    this.inFlightSends.add(entry.id);

    // Mark entry as in-flight in the JSONL before sending so concurrent
    // workers (or a restart after timeout) see the claim and skip it.
    entry.status = "in-flight";
    this.commitEntryUpdate(entries, entry);

    let sendPromise: Promise<void> | null = null;
    let timedOut = false;

    try {
      const timeout = this.config.timeoutMs;
      sendPromise = sender(entry);
      const result =
        timeout > 0
          ? await Promise.race([
              sendPromise.then(() => "ok" as const),
              new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeout)),
            ])
          : await sendPromise.then(() => "ok" as const);
      if (result === "timeout") {
        timedOut = true;
        throw new Error(`Send timed out after ${timeout}ms`);
      }
      entry.status = "sent";
    } catch (err) {
      entry.attempts += 1;
      entry.lastAttemptAt = new Date().toISOString();
      entry.lastError = err instanceof Error ? err.message : String(err);

      if (entry.attempts >= this.config.maxRetries) {
        entry.status = "dead";
        await this.moveToDeadLetter(entry, entry.lastError);
      } else {
        // Return to pending so it can be retried
        entry.status = "pending";
      }
    } finally {
      if (sendPromise) {
        if (!timedOut) {
          await sendPromise.catch(() => {});
        } else {
          sendPromise.catch(() => {});
        }
      }
      this.inFlightSends.delete(entry.id);
    }

    // Re-read entries to avoid dropping concurrent enqueues during send
    const freshEntries = readEntries(this.config.outboxPath);
    const remaining = freshEntries.filter((e) => e.id !== entry.id);
    if (entry.status === "pending") {
      remaining.push(entry);
    }

    const newContent = remaining.map((e) => JSON.stringify(e)).join("\n");
    atomicWriteFileSync(this.config.outboxPath, newContent ? newContent + "\n" : "");

    return entry;
  }

  /**
   * Atomically update a single entry in the outbox JSONL file.
   * Used to durably mark an entry as in-flight before sending.
   */
  private commitEntryUpdate(
    currentEntries: OutboxEntry[],
    updated: OutboxEntry,
  ): void {
    const patched = currentEntries.map((e) =>
      e.id === updated.id ? updated : e,
    );
    const content = patched.map((e) => JSON.stringify(e)).join("\n");
    atomicWriteFileSync(
      this.config.outboxPath,
      content ? content + "\n" : "",
    );
  }

  async moveToDeadLetter(entry: OutboxEntry, error: string): Promise<void> {
    const deadEntry: OutboxEntry = { ...entry, status: "dead", lastError: error };
    mkdirSync(dirname(this.config.deadLetterPath), { recursive: true });
    appendFileSync(this.config.deadLetterPath, JSON.stringify(deadEntry) + "\n", "utf-8");
  }

  async getOutboxLength(): Promise<number> {
    const entries = readEntries(this.config.outboxPath);
    return entries.filter((e) => e.status === "pending").length;
  }

  async getDeadLetterLength(): Promise<number> {
    return readEntries(this.config.deadLetterPath).length;
  }

  async drainOutbox(sender: (entry: OutboxEntry) => Promise<void>): Promise<void> {
    let result = await this.processNext(sender);
    while (result !== null) {
      result = await this.processNext(sender);
    }
  }
}
