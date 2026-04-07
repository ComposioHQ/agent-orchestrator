import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@composio/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    findPidByPort: vi.fn().mockResolvedValue(null),
  };
});

describe("findRunningDashboardPid", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("delegates to findPidByPort from platform adapter", async () => {
    const { findPidByPort } = await import("@composio/ao-core");
    const { findRunningDashboardPid } = await import("../../src/lib/dashboard-rebuild.js");
    await findRunningDashboardPid(3000);
    expect(findPidByPort).toHaveBeenCalledWith(3000);
  });
});
