/** Base fields shared by all messages in the file-based protocol. */
export interface BaseMessage {
  /** Schema version. Currently 1. */
  v: 1;
  /** Monotonic counter per session. Sortable, debuggable. */
  id: number;
  /** Session generation counter. Increments on respawn. */
  epoch: number;
  /** ISO 8601 timestamp. */
  ts: string;
}

// ---------------------------------------------------------------------------
// Inbox messages (orchestrator -> agent)
// ---------------------------------------------------------------------------

export type InboxMessageType =
  | "instruction"
  | "resolution"
  | "warning"
  | "abort"
  | "context";

export interface InboxMessage extends BaseMessage {
  source: "orchestrator";
  type: InboxMessageType;
  /** Idempotency key. Agent tracks last N keys, skips duplicates. */
  dedup: string;
  /** Message payload. */
  message: string;
  /** Additional structured data depending on type. */
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Agent events (agent -> system, written to agent-events file)
// ---------------------------------------------------------------------------

export type AgentEventType =
  | "escalation"
  | "file_report"
  | "status"
  | "completion"
  | "reject"
  | "ack";

export interface AgentEvent extends BaseMessage {
  source: "agent";
  type: AgentEventType;
  /** Free-form payload. */
  message?: string;
  /** Additional structured data depending on type. */
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// System events (lifecycle worker -> system, written to system-events file)
// ---------------------------------------------------------------------------

export type SystemEventType =
  | "ci_failure"
  | "ci_recovery"
  | "review_pending"
  | "review_approved"
  | "merge_conflict"
  | "merge_ready";

export interface SystemEvent extends BaseMessage {
  source: "system";
  type: SystemEventType;
  /** Free-form payload. */
  message?: string;
  /** Additional structured data depending on type. */
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Union type for any message in the protocol
// ---------------------------------------------------------------------------

export type ProtocolMessage = InboxMessage | AgentEvent | SystemEvent;

// ---------------------------------------------------------------------------
// Communication file names (constants)
// ---------------------------------------------------------------------------

export const INBOX_FILE = "inbox";
export const AGENT_EVENTS_FILE = "agent-events";
export const SYSTEM_EVENTS_FILE = "system-events";
export const HEARTBEAT_FILE = "heartbeat";

/** Suffix appended to a communication file to form its cursor path. */
export const CURSOR_SUFFIX = ".cursor";

// ---------------------------------------------------------------------------
// Agent injection modes
// ---------------------------------------------------------------------------

/**
 * How messages get injected into an agent's context after being written to
 * the inbox file. The inbox write is universal; the injection is per-agent.
 */
export type AgentInjectionMode =
  /** Claude Code: subprocess with stream-json stdin NDJSON */
  | "subprocess"
  /** Codex: app-server JSON-RPC sidecar (turn/start) */
  | "jsonrpc"
  /** OpenCode, Aider, unknown: inbox file only, inner runtime fallback */
  | "inbox-only";

/**
 * Resolve the injection mode for an agent based on its name.
 * Falls back to "inbox-only" for unknown agents.
 */
export function resolveInjectionMode(agentName: string): AgentInjectionMode {
  switch (agentName) {
    case "claude-code":
      return "subprocess";
    case "codex":
      return "jsonrpc";
    default:
      return "inbox-only";
  }
}
