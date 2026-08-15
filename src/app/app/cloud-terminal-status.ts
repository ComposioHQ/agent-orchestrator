import type { CloudTerminalConnectionState } from "@/lib/cloud-terminal-pool";

export function terminalWaitingLabel(
  connection: CloudTerminalConnectionState,
  kind: "agent" | "workspace",
  runtimeState?: string,
): string {
  switch (runtimeState) {
    case "provisioning":
      return "Creating a new NodeOps VM…";
    case "paused":
    case "stopped":
      return "Waking the existing NodeOps VM…";
    case "restoring":
      return "Restoring the AO worker…";
    case "bootstrapping":
      return "Starting the AO worker…";
    case "ready":
      if (connection === "connecting" || connection === "waking") {
        return kind === "workspace"
          ? "Starting workspace shell…"
          : "Starting coding-agent terminal…";
      }
      break;
  }

  switch (connection) {
    case "connecting":
      return kind === "workspace"
        ? "Starting workspace shell…"
        : "Connecting coding-agent terminal…";
    case "waking":
      return kind === "workspace"
        ? "Starting workspace shell…"
        : "Waking coding-agent session…";
    case "disconnected":
      return "Reconnecting terminal…";
    case "error":
      return "Terminal unavailable";
    case "connected":
      return "Terminal connected";
  }
}
