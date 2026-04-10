/**
 * Factory helpers to build Session and RuntimeHandle objects for tests.
 */

import type { RuntimeHandle, Session } from "@aoagents/ao-core";

/** Build a tmux RuntimeHandle for a given session name. */
export function makeTmuxHandle(sessionName: string): RuntimeHandle {
  return {
    id: sessionName,
    runtimeName: "tmux",
    data: {},
  };
}

/** Build a minimal Session object suitable for agent plugin methods. */
export function makeSession(
  id: string,
  handle: RuntimeHandle | null,
  workspacePath: string | null,
): Session {
  return {
    id,
    projectId: "inttest",
    status: "working",
    activity: "active",
    branch: null,
    issueId: null,
    pr: null,
    workspacePath,
    runtimeHandle: handle,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
  };
}
