import { describe, expect, it } from "vitest";

import { terminalWaitingLabel } from "./cloud-terminal-status";

describe("terminalWaitingLabel", () => {
  it("distinguishes a fresh VM from a resumed VM", () => {
    expect(terminalWaitingLabel("waking", "agent", "provisioning")).toBe(
      "Creating a new NodeOps VM…",
    );
    expect(terminalWaitingLabel("waking", "agent", "paused")).toBe(
      "Waking the existing NodeOps VM…",
    );
  });

  it("explains the independent workspace shell startup", () => {
    expect(terminalWaitingLabel("connecting", "workspace", "ready")).toBe(
      "Starting workspace shell…",
    );
  });

  it("reports a reconnect after a previously ready runtime", () => {
    expect(terminalWaitingLabel("disconnected", "agent", "ready")).toBe(
      "Reconnecting terminal…",
    );
  });
});
