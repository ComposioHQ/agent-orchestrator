import type { ActivityState } from "@composio/ao-core/types";

/** Emoji indicators for each activity state, shared across components. */
export const activityIcon: Record<ActivityState, string> = {
  active: "\u26A1", // ⚡
  ready: "\uD83D\uDFE2", // 🟢
  idle: "\uD83D\uDCA4", // 💤
  waiting_input: "\u2753", // ❓
  blocked: "\uD83D\uDEA7", // 🚧
  exited: "\uD83D\uDC80", // 💀
};
