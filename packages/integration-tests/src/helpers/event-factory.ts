import type {
  OrchestratorEvent,
  Session,
  EventPriority,
  EventType,
  SessionStatus,
  ActivityState,
} from "@aoagents/ao-core";

/**
 * Create a test OrchestratorEvent with sensible defaults.
 * Override any field as needed.
 */
export function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-test-1",
    type: "session.spawned" as EventType,
    priority: "info" as EventPriority,
    sessionId: "app-1",
    projectId: "my-project",
    timestamp: new Date("2025-06-15T12:00:00Z"),
    message: "Session app-1 spawned successfully",
    data: {},
    ...overrides,
  };
}

/**
 * Create a test Session with sensible defaults.
 * Override any field as needed.
 */
export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-project",
    status: "working" as SessionStatus,
    activity: "active" as ActivityState,
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/workspace",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date("2025-06-15T12:00:00Z"),
    lastActivityAt: new Date("2025-06-15T12:00:00Z"),
    metadata: {},
    ...overrides,
  };
}
