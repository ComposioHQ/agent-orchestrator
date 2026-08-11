export type DemoSessionStatus =
  | "working"
  | "needs_input"
  | "review_pending"
  | "mergeable";

export interface DemoSession {
  id: string;
  harness: "claude-code" | "codex" | "cursor";
  displayName: string;
  branch: string;
  activityState: "active" | "waiting_input" | "blocked" | "idle" | "exited";
  status: DemoSessionStatus;
  age: string;
}
