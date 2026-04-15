export interface BaseMessage {
  v: 1;
  id: number;
  epoch: number;
  ts: string;
}

export type InboxMessageType = "instruction" | "resolution" | "warning" | "abort" | "context";

export interface InboxMessage extends BaseMessage {
  source: "orchestrator";
  type: InboxMessageType;
  dedup: string;
  message: string;
  data?: Record<string, unknown>;
}

export type AgentEventType = "escalation" | "file_report" | "status" | "completion" | "reject" | "ack";

export interface AgentEvent extends BaseMessage {
  source: "agent";
  type: AgentEventType;
  message?: string;
  data?: Record<string, unknown>;
}

export type SystemEventType = "ci_failure" | "ci_recovery" | "review_pending" | "review_approved" | "merge_conflict" | "merge_ready";

export interface SystemEvent extends BaseMessage {
  source: "system";
  type: SystemEventType;
  message?: string;
  data?: Record<string, unknown>;
}

export type ProtocolMessage = InboxMessage | AgentEvent | SystemEvent;

export const INBOX_FILE = "inbox";
export const AGENT_EVENTS_FILE = "agent-events";
export const SYSTEM_EVENTS_FILE = "system-events";
export const CURSOR_SUFFIX = ".cursor";
