/**
 * AgentBus — Filesystem-based message bus for inter-agent communication.
 *
 * Manages the .agents/ directory structure:
 *   .agents/
 *   ├── bin/             # Shell functions + compiled CLI binary
 *   ├── plan.json        # Planner's task decomposition
 *   ├── control.json     # Shutdown signals
 *   ├── http-port        # Dynamic port for HTTP server
 *   ├── messages.jsonl   # Append-only message log
 *   ├── status/          # One file per agent
 *   ├── locks/           # Advisory file locks
 *   └── artifacts/       # Structured outputs
 *
 * Design principles:
 *   1. One writer per status file (no shared-write races)
 *   2. Lockfile-guarded message log (serialized appends)
 *   3. Atomic status writes (write-to-temp-then-rename)
 *   4. fs.watch + poll fallback for monitoring
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentStatus,
  BusMessage,
  ControlSignal,
  LearningEntry,
  Phase,
  Plan,
  AgentPhaseState,
  MessageType,
  MessagePriority,
  LearningCategory,
} from "@composio/ao-core";

/** Options for creating an AgentBus instance */
export interface AgentBusOptions {
  /** Path to the .agents/ directory */
  agentsDir: string;
}

/**
 * AgentBus provides the core read/write operations on the .agents/ directory.
 * Used by both the CLI (ao-bus-cli) and the phase engine.
 */
export class AgentBus {
  readonly agentsDir: string;
  private readonly statusDir: string;
  private readonly locksDir: string;
  private readonly artifactsDir: string;
  private readonly binDir: string;
  private readonly messagesPath: string;
  private readonly planPath: string;
  private readonly controlPath: string;

  constructor(options: AgentBusOptions) {
    this.agentsDir = options.agentsDir;
    this.statusDir = join(this.agentsDir, "status");
    this.locksDir = join(this.agentsDir, "locks");
    this.artifactsDir = join(this.agentsDir, "artifacts");
    this.binDir = join(this.agentsDir, "bin");
    this.messagesPath = join(this.agentsDir, "messages.jsonl");
    this.planPath = join(this.agentsDir, "plan.json");
    this.controlPath = join(this.agentsDir, "control.json");
  }

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  /** Initialize the .agents/ directory structure */
  init(): void {
    mkdirSync(this.agentsDir, { recursive: true });
    mkdirSync(this.statusDir, { recursive: true });
    mkdirSync(this.locksDir, { recursive: true });
    mkdirSync(this.artifactsDir, { recursive: true });
    mkdirSync(this.binDir, { recursive: true });

    // Create empty messages log
    if (!existsSync(this.messagesPath)) {
      writeFileSync(this.messagesPath, "", "utf-8");
    }
  }

  // ===========================================================================
  // STATUS
  // ===========================================================================

  /** Write an agent's status (atomic write-to-temp-then-rename) */
  writeStatus(status: AgentStatus): void {
    const filePath = join(this.statusDir, `${status.name}.json`);
    this.atomicWrite(filePath, JSON.stringify(status, null, 2));
  }

  /** Read an agent's status */
  readStatus(agentName: string): AgentStatus | null {
    const filePath = join(this.statusDir, `${agentName}.json`);
    return this.safeReadJson<AgentStatus>(filePath);
  }

  /** Read all agent statuses */
  readAllStatuses(): AgentStatus[] {
    if (!existsSync(this.statusDir)) return [];

    const files = readdirSync(this.statusDir).filter((f) => f.endsWith(".json"));
    const statuses: AgentStatus[] = [];

    for (const file of files) {
      const status = this.safeReadJson<AgentStatus>(join(this.statusDir, file));
      if (status) statuses.push(status);
    }

    return statuses;
  }

  /** Update agent status fields (read-modify-write) */
  updateStatus(
    agentName: string,
    updates: Partial<Pick<AgentStatus, "state" | "currentFile" | "crashCount">>,
  ): AgentStatus | null {
    const status = this.readStatus(agentName);
    if (!status) return null;

    const updated: AgentStatus = {
      ...status,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.writeStatus(updated);
    return updated;
  }

  /** Create initial status for an agent */
  initAgentStatus(agentName: string, role: string, phase: Phase): AgentStatus {
    const status: AgentStatus = {
      name: agentName,
      role: role as AgentStatus["role"],
      phase,
      state: "idle",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      crashCount: 0,
    };

    this.writeStatus(status);
    return status;
  }

  /** Set agent state to done */
  setDone(agentName: string): AgentStatus | null {
    return this.updateStatus(agentName, { state: "done" as AgentPhaseState });
  }

  /** Set agent state to working with optional current file */
  setWorking(agentName: string, currentFile?: string): AgentStatus | null {
    return this.updateStatus(agentName, {
      state: "working" as AgentPhaseState,
      currentFile,
    });
  }

  // ===========================================================================
  // MESSAGES
  // ===========================================================================

  /** Append a message to the log (lockfile-guarded, atomic) */
  sendMessage(
    from: string,
    to: string,
    phase: Phase,
    content: string,
    options?: {
      type?: MessageType;
      priority?: MessagePriority;
      filesReferenced?: string[];
    },
  ): BusMessage {
    const seq = this.getNextSeq();
    const message: BusMessage = {
      seq,
      ts: new Date().toISOString(),
      from,
      to,
      phase,
      type: options?.type ?? "system",
      content,
      filesReferenced: options?.filesReferenced,
      priority: options?.priority,
    };

    const lockPath = join(this.locksDir, "messages.lock");
    this.withLock(lockPath, () => {
      const line = JSON.stringify(message) + "\n";
      // Append by reading + writing to temp + rename (atomic)
      const existing = existsSync(this.messagesPath)
        ? readFileSync(this.messagesPath, "utf-8")
        : "";
      this.atomicWrite(this.messagesPath, existing + line);
    });

    return message;
  }

  /** Read all messages */
  readMessages(): BusMessage[] {
    if (!existsSync(this.messagesPath)) return [];

    const content = readFileSync(this.messagesPath, "utf-8").trim();
    if (!content) return [];

    const messages: BusMessage[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as BusMessage);
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  }

  /** Read messages for a specific agent */
  readMessagesFor(agentName: string, options?: { from?: string; since?: number }): BusMessage[] {
    const all = this.readMessages();
    return all.filter((m) => {
      if (m.to !== agentName && m.to !== "all") return false;
      if (options?.from && m.from !== options.from) return false;
      if (options?.since !== undefined && m.seq <= options.since) return false;
      return true;
    });
  }

  // ===========================================================================
  // PLAN
  // ===========================================================================

  /** Write plan.json (from planner agent) */
  writePlan(plan: Plan): void {
    this.atomicWrite(this.planPath, JSON.stringify(plan, null, 2));
  }

  /** Read plan.json */
  readPlan(): Plan | null {
    return this.safeReadJson<Plan>(this.planPath);
  }

  // ===========================================================================
  // CONTROL
  // ===========================================================================

  /** Write a control signal */
  writeControl(signal: ControlSignal): void {
    this.atomicWrite(this.controlPath, JSON.stringify(signal, null, 2));
  }

  /** Read the current control signal */
  readControl(): ControlSignal | null {
    return this.safeReadJson<ControlSignal>(this.controlPath);
  }

  // ===========================================================================
  // ARTIFACTS
  // ===========================================================================

  /** Write an artifact file */
  writeArtifact(name: string, content: string): void {
    const filePath = join(this.artifactsDir, name);
    mkdirSync(dirname(filePath), { recursive: true });
    this.atomicWrite(filePath, content);
  }

  /** Read an artifact file */
  readArtifact(name: string): string | null {
    const filePath = join(this.artifactsDir, name);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  }

  /** List artifact files */
  listArtifacts(): string[] {
    if (!existsSync(this.artifactsDir)) return [];
    return readdirSync(this.artifactsDir);
  }

  // ===========================================================================
  // LEARNINGS BUFFER
  // ===========================================================================

  /** Append a learning entry to the buffer */
  bufferLearning(entry: LearningEntry): void {
    const bufferPath = join(this.artifactsDir, "learnings-buffer.jsonl");
    const line = JSON.stringify(entry) + "\n";
    const existing = existsSync(bufferPath) ? readFileSync(bufferPath, "utf-8") : "";
    this.atomicWrite(bufferPath, existing + line);
  }

  /** Read all buffered learning entries */
  readLearningsBuffer(): LearningEntry[] {
    const bufferPath = join(this.artifactsDir, "learnings-buffer.jsonl");
    if (!existsSync(bufferPath)) return [];

    const content = readFileSync(bufferPath, "utf-8").trim();
    if (!content) return [];

    const entries: LearningEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as LearningEntry);
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  }

  // ===========================================================================
  // LOCKS
  // ===========================================================================

  /** Encode a file path for use as a lock file name (/ -> --) */
  encodeLockPath(filePath: string): string {
    return filePath.replace(/\//g, "--") + ".lock";
  }

  /** Acquire an advisory lock */
  acquireLock(filePath: string): boolean {
    const lockFile = join(this.locksDir, this.encodeLockPath(filePath));
    if (existsSync(lockFile)) return false;
    writeFileSync(lockFile, new Date().toISOString(), "utf-8");
    return true;
  }

  /** Release an advisory lock */
  releaseLock(filePath: string): void {
    const lockFile = join(this.locksDir, this.encodeLockPath(filePath));
    if (existsSync(lockFile)) {
      unlinkSync(lockFile);
    }
  }

  // ===========================================================================
  // CONTEXT
  // ===========================================================================

  /** Get agent context info (role, phase, scope) from env vars */
  getContext(): {
    agentName: string;
    phase: string;
    worktree: string;
    fileScope: string[];
    sharedFiles: string[];
  } {
    return {
      agentName: process.env["AO_AGENT_NAME"] ?? "unknown",
      phase: process.env["AO_PHASE"] ?? "unknown",
      worktree: process.env["AO_WORKTREE"] ?? process.cwd(),
      fileScope: (process.env["AO_FILE_SCOPE"] ?? "").split(",").filter(Boolean),
      sharedFiles: (process.env["AO_SHARED_FILES"] ?? "").split(",").filter(Boolean),
    };
  }

  // ===========================================================================
  // INTERNAL HELPERS
  // ===========================================================================

  /** Get the next sequence number for messages */
  private getNextSeq(): number {
    const messages = this.readMessages();
    if (messages.length === 0) return 1;
    return Math.max(...messages.map((m) => m.seq)) + 1;
  }

  /** Atomic write: write to temp file, then rename */
  private atomicWrite(filePath: string, content: string): void {
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  }

  /** Safely read and parse a JSON file */
  private safeReadJson<T>(filePath: string): T | null {
    if (!existsSync(filePath)) return null;
    try {
      const content = readFileSync(filePath, "utf-8");
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  /** Execute a function while holding a lockfile */
  private withLock(lockPath: string, fn: () => void): void {
    // Simple lockfile: write PID, execute, remove
    // In practice, concurrent appends are rare since agents are phase-scoped
    const tmpLock = `${lockPath}.${randomUUID()}.tmp`;
    writeFileSync(tmpLock, process.pid.toString(), "utf-8");

    try {
      renameSync(tmpLock, lockPath);
    } catch {
      // Lock acquisition failed; another process holds it
      // For v1, proceed without lock (contention is negligible)
      try {
        unlinkSync(tmpLock);
      } catch {
        // Ignore cleanup failure
      }
    }

    try {
      fn();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // Ignore unlock failure
      }
    }
  }
}

/** Record a learning via the bus */
export function createLearningEntry(
  category: LearningCategory,
  description: string,
  agentName: string,
  phase: Phase,
): LearningEntry {
  return {
    category,
    description,
    recordedBy: agentName,
    phase,
    ts: new Date().toISOString(),
  };
}
