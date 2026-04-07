import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import {
  INBOX_FILE,
  AGENT_EVENTS_FILE,
  SYSTEM_EVENTS_FILE,
  HEARTBEAT_FILE,
  CURSOR_SUFFIX,
  type InboxMessage,
  type InboxMessageType,
  type ProtocolMessage,
} from "./message-types.js";

// ---------------------------------------------------------------------------
// Session communication directory
// ---------------------------------------------------------------------------

/** Paths to all communication files for a session. */
export interface SessionCommsFiles {
  dir: string;
  inbox: string;
  agentEvents: string;
  systemEvents: string;
  heartbeat: string;
}

/**
 * Resolve communication file paths for a session.
 * Uses the existing metadata directory layout: {sessionsDir}/{sessionId}/
 */
export function resolveCommsFiles(
  sessionsDir: string,
  sessionId: string,
): SessionCommsFiles {
  const dir = join(sessionsDir, sessionId, "comms");
  return {
    dir,
    inbox: join(dir, INBOX_FILE),
    agentEvents: join(dir, AGENT_EVENTS_FILE),
    systemEvents: join(dir, SYSTEM_EVENTS_FILE),
    heartbeat: join(dir, HEARTBEAT_FILE),
  };
}

/**
 * Create all communication files for a session.
 * Idempotent: safe to call multiple times.
 */
export function createCommsFiles(files: SessionCommsFiles): void {
  mkdirSync(files.dir, { recursive: true });
  for (const path of [files.inbox, files.agentEvents, files.systemEvents]) {
    if (!existsSync(path)) {
      writeFileSync(path, "", "utf-8");
      chmodSync(path, 0o666);
    }
  }
  touchFile(files.heartbeat);
  chmodSync(files.heartbeat, 0o666);
}

/**
 * Remove all communication files for a session.
 * Best-effort: ignores missing files.
 */
export function removeCommsFiles(files: SessionCommsFiles): void {
  try {
    rmSync(files.dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Atomic file write (write to .tmp then rename)
// ---------------------------------------------------------------------------

/**
 * Atomically write content to a file via write-to-tmp-then-rename.
 * Prevents corrupt reads if the process crashes mid-write.
 */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Message counter persistence
// ---------------------------------------------------------------------------

/**
 * Message counters are persisted to disk so IDs remain monotonic across
 * orchestrator restarts. Key format: "{sessionId}:{source}".
 */
let messageCounters = new Map<string, number>();
let counterFilePath: string | null = null;

/** Initialize counters from a persisted file. Call once at startup. */
export function initCounters(persistPath: string): void {
  counterFilePath = persistPath;
  try {
    const raw = readFileSync(persistPath, "utf-8");
    const data = JSON.parse(raw) as Record<string, number>;
    messageCounters = new Map(Object.entries(data));
  } catch {
    // No file or corrupt: start fresh
    messageCounters = new Map();
  }
}

/** Persist counters to disk. */
function persistCounters(): void {
  if (!counterFilePath) return;
  const data: Record<string, number> = {};
  for (const [key, val] of messageCounters) {
    data[key] = val;
  }
  try {
    atomicWrite(counterFilePath, JSON.stringify(data));
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// JSONL append (single writer, O_APPEND atomic for <4KB on macOS+Linux)
// ---------------------------------------------------------------------------

/**
 * Append a JSONL message to a communication file.
 * Uses O_APPEND for kernel-level atomicity on macOS (APFS) and Linux (ext4).
 * Messages must stay under 4KB.
 */
const MAX_COMMS_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export function appendMessage(
  filePath: string,
  sessionId: string,
  epoch: number,
  source: "orchestrator" | "agent" | "system",
  type: string,
  message: string,
  extra?: Record<string, unknown>,
): ProtocolMessage {
  try {
    const fileSize = statSync(filePath).size;
    if (fileSize >= MAX_COMMS_FILE_BYTES) {
      throw new Error(
        `Communication file ${filePath} has reached the ${MAX_COMMS_FILE_BYTES / (1024 * 1024)}MB size limit ` +
        `(${fileSize} bytes). Rotate or archive the file before appending more messages.`,
      );
    }
  } catch (err) {
    // Re-throw size-limit errors, ignore stat failures (file may not exist yet)
    if (err instanceof Error && err.message.includes("size limit")) throw err;
  }

  // Compute the prospective id WITHOUT committing it. The counter is only
  // advanced after the size check passes — otherwise an oversized message
  // would burn an id and leave a permanent gap in the JSONL stream.
  const counterKey = `${sessionId}:${source}`;
  const nextId = (messageCounters.get(counterKey) ?? 0) + 1;

  const entry: ProtocolMessage = {
    v: 1,
    id: nextId,
    epoch,
    ts: new Date().toISOString(),
    source,
    type,
    message,
    ...extra,
  } as ProtocolMessage;

  const line = JSON.stringify(entry) + "\n";

  if (Buffer.byteLength(line, "utf-8") > 4096) {
    throw new Error(
      `Message exceeds 4KB safety limit (${Buffer.byteLength(line, "utf-8")} bytes). ` +
      `Use a context file for larger payloads.`,
    );
  }

  // Size check passed — commit the counter and append.
  messageCounters.set(counterKey, nextId);
  persistCounters();
  appendFileSync(filePath, line, { encoding: "utf-8", flag: "a" });
  return entry;
}

/**
 * Append an inbox message with a dedup key.
 */
export function appendInboxMessage(
  inboxPath: string,
  sessionId: string,
  epoch: number,
  type: InboxMessageType,
  message: string,
  dedup: string,
  data?: Record<string, unknown>,
): InboxMessage {
  return appendMessage(
    inboxPath,
    sessionId,
    epoch,
    "orchestrator",
    type,
    message,
    { dedup, data },
  ) as InboxMessage;
}

// ---------------------------------------------------------------------------
// Cursor-based JSONL reader
// ---------------------------------------------------------------------------

/**
 * Read new JSONL lines from a file starting at the cursor byte offset.
 * Returns parsed messages and the new cursor position.
 *
 * Correctness guarantees:
 * - Opens file descriptor ONCE, stats the fd (not the path) to avoid TOCTOU race.
 * - Cursor is persisted atomically via write-to-tmp-then-rename.
 * - Corrupt lines at EOF are NOT consumed (cursor not advanced) to handle
 *   partial writes from crashes. Mid-file corrupt lines are logged and skipped.
 *
 * The cursor byte offset is 0-indexed (position of next byte to read).
 * Bash hooks use tail -c +$(cursor+1) which is 1-indexed — both agree on
 * "read starting at this position" with the +1 conversion.
 */
export function readNewMessages(
  filePath: string,
): { messages: ProtocolMessage[]; newCursor: number } {
  const cursorPath = filePath + CURSOR_SUFFIX;

  let cursor = 0;
  try {
    const raw = readFileSync(cursorPath, "utf-8").trim();
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed >= 0) cursor = parsed;
  } catch {
    // no cursor file yet, start from 0
  }

  // Open fd once, stat via fd (not path) to prevent TOCTOU race.
  // Between statSync(path) and readSync() another process could truncate
  // the file, causing a short read or buffer overrun.
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return { messages: [], newCursor: cursor };
  }

  let fileSize: number;
  try {
    fileSize = fstatSync(fd).size;
  } catch {
    closeSync(fd);
    return { messages: [], newCursor: cursor };
  }

  // Handle file truncation (file smaller than cursor)
  if (fileSize < cursor) {
    cursor = 0;
    atomicWrite(cursorPath, "0");
  }

  if (fileSize <= cursor) {
    closeSync(fd);
    return { messages: [], newCursor: cursor };
  }

  // Read only new bytes from the open fd
  const bytesToRead = fileSize - cursor;
  const buffer = Buffer.alloc(bytesToRead);
  readSync(fd, buffer, 0, bytesToRead, cursor);
  closeSync(fd);

  const raw = buffer.toString("utf-8");
  const lines = raw.split("\n");

  const messages: ProtocolMessage[] = [];
  let bytesConsumed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Last element after split is empty if file ends with \n. Skip without
    // adding a phantom byte.
    if (i === lines.length - 1 && !line) {
      break;
    }

    const lineBytes = Buffer.byteLength(line + "\n", "utf-8");

    if (!line.trim()) {
      bytesConsumed += lineBytes;
      continue;
    }

    try {
      const parsed = JSON.parse(line) as ProtocolMessage;
      messages.push(parsed);
      bytesConsumed += lineBytes;
    } catch {
      // Check if this is the last meaningful line (could be a partial write).
      const isLastMeaningful =
        i === lines.length - 1 ||
        (i === lines.length - 2 && !lines[lines.length - 1]?.trim());

      if (isLastMeaningful) {
        // Don't advance cursor past it. Next read will retry.
        break;
      }
      // Mid-file corrupt line: skip it, advance cursor
      console.warn(
        `[file-transport] Corrupt JSONL line skipped in ${filePath} at offset ${cursor + bytesConsumed}: ${line.slice(0, 100)}`,
      );
      bytesConsumed += lineBytes;
    }
  }

  const newCursor = cursor + bytesConsumed;

  // Persist cursor atomically (write-to-tmp-then-rename)
  atomicWrite(cursorPath, String(newCursor));

  return { messages, newCursor };
}

/**
 * Read all messages from a file (ignoring cursor). For debugging and replay.
 */
export function readAllMessages(filePath: string): ProtocolMessage[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as ProtocolMessage;
        } catch {
          return null;
        }
      })
      .filter((msg): msg is ProtocolMessage => msg !== null);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/** Touch the heartbeat file (update mtime). */
export function touchFile(filePath: string): void {
  const now = new Date();
  try {
    if (existsSync(filePath)) {
      utimesSync(filePath, now, now);
    } else {
      writeFileSync(filePath, "", "utf-8");
    }
  } catch {
    // best effort
  }
}

/** Get the last heartbeat time (file mtime). Returns null if missing. */
export function getHeartbeatTime(heartbeatPath: string): Date | null {
  try {
    return statSync(heartbeatPath).mtime;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// fs.watch() watcher
// ---------------------------------------------------------------------------

export interface FileWatcher {
  close(): void;
}

/**
 * Watch a directory for file changes. Calls the handler on any change.
 * Returns a watcher handle that can be closed.
 */
export function watchDirectory(
  dirPath: string,
  handler: (filename: string | null) => void,
): FileWatcher {
  const watcher: FSWatcher = watch(dirPath, { persistent: false }, (_event, filename) => {
    handler(filename?.toString() ?? null);
  });

  return {
    close() {
      watcher.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Epoch management
// ---------------------------------------------------------------------------

/** Read the current epoch for a session. Returns 0 if not set. */
export function readEpoch(sessionsDir: string, sessionId: string): number {
  const epochPath = join(sessionsDir, sessionId, "comms", "epoch");
  try {
    const raw = readFileSync(epochPath, "utf-8").trim();
    const parsed = parseInt(raw, 10);
    return isNaN(parsed) ? 0 : parsed;
  } catch {
    return 0;
  }
}

/** Write the epoch for a session. */
export function writeEpoch(sessionsDir: string, sessionId: string, epoch: number): void {
  const epochPath = join(sessionsDir, sessionId, "comms", "epoch");
  mkdirSync(join(sessionsDir, sessionId, "comms"), { recursive: true });
  atomicWrite(epochPath, String(epoch));
}

// ---------------------------------------------------------------------------
// Dedup key generation
// ---------------------------------------------------------------------------

let dedupCounter = 0;

/** Generate a unique dedup key for inbox messages. */
export function generateDedupKey(): string {
  dedupCounter += 1;
  return `${process.pid}-${Date.now()}-${dedupCounter}`;
}

// ---------------------------------------------------------------------------
// Cursor reset (for session restore)
// ---------------------------------------------------------------------------

/**
 * Delete cursor files for a session's inbox.
 * Called during session restore so the agent re-reads the full inbox.
 */
export function resetCursors(files: SessionCommsFiles): void {
  rmSync(files.inbox + CURSOR_SUFFIX, { force: true });
  rmSync(files.inbox + ".hook-cursor", { force: true });
}

// ---------------------------------------------------------------------------
// Reset (for testing)
// ---------------------------------------------------------------------------

/** Reset internal state. Only for testing. */
export function _resetForTesting(): void {
  messageCounters = new Map();
  counterFilePath = null;
  dedupCounter = 0;
}
