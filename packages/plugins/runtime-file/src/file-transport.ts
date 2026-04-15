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
  writeFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import {
  INBOX_FILE,
  AGENT_EVENTS_FILE,
  SYSTEM_EVENTS_FILE,
  CURSOR_SUFFIX,
  type InboxMessage,
  type InboxMessageType,
  type ProtocolMessage,
} from "./message-types.js";

export interface SessionCommsFiles {
  dir: string;
  inbox: string;
  agentEvents: string;
  systemEvents: string;
}

export function resolveCommsFiles(sessionsDir: string, sessionId: string): SessionCommsFiles {
  const dir = join(sessionsDir, sessionId, "comms");
  return {
    dir,
    inbox: join(dir, INBOX_FILE),
    agentEvents: join(dir, AGENT_EVENTS_FILE),
    systemEvents: join(dir, SYSTEM_EVENTS_FILE),
  };
}

export function createCommsFiles(files: SessionCommsFiles): void {
  mkdirSync(files.dir, { recursive: true });
  for (const path of [files.inbox, files.agentEvents, files.systemEvents]) {
    if (!existsSync(path)) {
      writeFileSync(path, "", "utf-8");
      chmodSync(path, 0o666);
    }
  }
}

export function removeCommsFiles(files: SessionCommsFiles): void {
  try { rmSync(files.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

// In-memory message counters — monotonic per session:source pair.
const messageCounters = new Map<string, number>();

export function appendMessage(
  filePath: string,
  sessionId: string,
  epoch: number,
  source: "orchestrator" | "agent" | "system",
  type: string,
  message: string,
  extra?: Record<string, unknown>,
): ProtocolMessage {
  const counterKey = `${sessionId}:${source}`;
  if (!messageCounters.has(counterKey)) {
    try {
      const last = readFileSync(filePath, "utf-8").trimEnd().split("\n").pop();
      if (last) messageCounters.set(counterKey, (JSON.parse(last) as { id?: number }).id ?? 0);
    } catch { /* empty/missing — start at 0 */ }
  }
  const nextId = (messageCounters.get(counterKey) ?? 0) + 1;
  messageCounters.set(counterKey, nextId);

  const entry: ProtocolMessage = {
    v: 1, id: nextId, epoch,
    ts: new Date().toISOString(),
    source, type, message,
    ...extra,
  } as ProtocolMessage;

  const line = JSON.stringify(entry) + "\n";
  if (Buffer.byteLength(line, "utf-8") > 4096) {
    throw new Error(`Message exceeds 4KB limit (${Buffer.byteLength(line, "utf-8")} bytes). Use a context file for larger payloads.`);
  }
  appendFileSync(filePath, line, { encoding: "utf-8", flag: "a" });
  return entry;
}

export function appendInboxMessage(
  inboxPath: string,
  sessionId: string,
  epoch: number,
  type: InboxMessageType,
  message: string,
  dedup: string,
  data?: Record<string, unknown>,
): InboxMessage {
  return appendMessage(inboxPath, sessionId, epoch, "orchestrator", type, message, { dedup, data }) as InboxMessage;
}

export function readNewMessages(filePath: string): { messages: ProtocolMessage[]; newCursor: number } {
  const cursorPath = filePath + CURSOR_SUFFIX;

  let cursor = 0;
  try {
    const raw = readFileSync(cursorPath, "utf-8").trim();
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed >= 0) cursor = parsed;
  } catch { /* no cursor file yet */ }

  let fd: number;
  try { fd = openSync(filePath, "r"); } catch { return { messages: [], newCursor: cursor }; }

  let fileSize: number;
  try { fileSize = fstatSync(fd).size; } catch { closeSync(fd); return { messages: [], newCursor: cursor }; }

  if (fileSize < cursor) { cursor = 0; atomicWrite(cursorPath, "0"); }
  if (fileSize <= cursor) { closeSync(fd); return { messages: [], newCursor: cursor }; }

  const bytesToRead = Math.min(fileSize - cursor, 65536);
  const buf = Buffer.alloc(bytesToRead);
  readSync(fd, buf, 0, bytesToRead, cursor);
  closeSync(fd);

  const lines = buf.toString("utf-8").split("\n");
  const messages: ProtocolMessage[] = [];
  let bytesConsumed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === lines.length - 1 && !line) break;
    const lineBytes = Buffer.byteLength(line + "\n", "utf-8");
    if (!line.trim()) { bytesConsumed += lineBytes; continue; }
    try {
      messages.push(JSON.parse(line) as ProtocolMessage);
      bytesConsumed += lineBytes;
    } catch {
      const isLast = i === lines.length - 1 || (i === lines.length - 2 && !lines[lines.length - 1]?.trim());
      if (isLast) break;
      console.warn(`[file-transport] Corrupt JSONL line skipped in ${filePath} at offset ${cursor + bytesConsumed}: ${line.slice(0, 100)}`);
      bytesConsumed += lineBytes;
    }
  }

  const newCursor = cursor + bytesConsumed;
  atomicWrite(cursorPath, String(newCursor));
  return { messages, newCursor };
}

export interface FileWatcher { close(): void; }

export function watchDirectory(dirPath: string, handler: (filename: string | null) => void): FileWatcher {
  let nativeWatcher: FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  function startPolling(): void {
    if (closed || pollTimer) return;
    let lastMtime = 0;
    try { lastMtime = statSync(dirPath).mtimeMs; } catch { /* ignore */ }
    pollTimer = setInterval(() => {
      try {
        const mtime = statSync(dirPath).mtimeMs;
        if (mtime > lastMtime) { lastMtime = mtime; handler(null); }
      } catch { /* ignore */ }
    }, 2000);
  }

  try {
    let fired = false;
    nativeWatcher = watch(dirPath, { persistent: false }, (_e, f) => { fired = true; handler(f?.toString() ?? null); });
    nativeWatcher.on("error", () => {
      if (closed) return;
      try { nativeWatcher?.close(); } catch { /* best effort */ }
      nativeWatcher = null;
      startPolling();
    });
    // Probe fs.watch health after 1s — fall back to polling if events never fire.
    setTimeout(() => {
      if (fired || closed || !nativeWatcher) return;
      try {
        const probe = join(dirPath, `.watch-probe-${process.pid}`);
        writeFileSync(probe, "t", "utf-8");
        rmSync(probe, { force: true });
      } catch { /* ignore */ }
      setTimeout(() => { if (!fired && !closed) { try { nativeWatcher?.close(); } catch { /* best effort */ } nativeWatcher = null; startPolling(); } }, 500);
    }, 1000);
  } catch { startPolling(); }

  return {
    close() {
      closed = true;
      try { nativeWatcher?.close(); } catch { /* best effort */ }
      if (pollTimer) clearInterval(pollTimer);
    },
  };
}

export function readEpoch(sessionsDir: string, sessionId: string): number {
  try {
    const raw = readFileSync(join(sessionsDir, sessionId, "comms", "epoch"), "utf-8").trim();
    const n = parseInt(raw, 10);
    return isNaN(n) ? 0 : n;
  } catch { return 0; }
}

export function writeEpoch(sessionsDir: string, sessionId: string, epoch: number): void {
  mkdirSync(join(sessionsDir, sessionId, "comms"), { recursive: true });
  atomicWrite(join(sessionsDir, sessionId, "comms", "epoch"), String(epoch));
}

let dedupCounter = 0;
export function generateDedupKey(): string {
  return `${process.pid}-${Date.now()}-${++dedupCounter}`;
}

export function resetCursors(files: SessionCommsFiles): void {
  rmSync(files.inbox + CURSOR_SUFFIX, { force: true });
  rmSync(files.inbox + ".hook-cursor", { force: true });
}
