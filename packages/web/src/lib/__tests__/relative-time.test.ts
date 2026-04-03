import { describe, it, expect, vi, afterEach } from "vitest";
import { getRelativeTime } from "../relative-time";

describe("getRelativeTime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns seconds ago for diffs under 60s (default minUnit=second)", () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2024-01-01T00:00:30Z").getTime());
    expect(getRelativeTime("2024-01-01T00:00:00Z")).toBe("30s ago");
  });

  it("returns nowLabel when minUnit=minute and diff < 60s", () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2024-01-01T00:00:30Z").getTime());
    expect(getRelativeTime("2024-01-01T00:00:00Z", { minUnit: "minute" })).toBe("just now");
  });

  it("uses custom nowLabel when minUnit=minute", () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2024-01-01T00:00:10Z").getTime());
    expect(
      getRelativeTime("2024-01-01T00:00:00Z", { minUnit: "minute", nowLabel: "now" }),
    ).toBe("now");
  });

  it("returns minutes ago for diffs between 60s and 60m", () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2024-01-01T00:05:00Z").getTime());
    expect(getRelativeTime("2024-01-01T00:00:00Z")).toBe("5m ago");
  });

  it("returns hours ago for diffs between 1h and 24h", () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2024-01-01T03:00:00Z").getTime());
    expect(getRelativeTime("2024-01-01T00:00:00Z")).toBe("3h ago");
  });

  it("returns days ago for diffs >= 24h", () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2024-01-04T00:00:00Z").getTime());
    expect(getRelativeTime("2024-01-01T00:00:00Z")).toBe("3d ago");
  });

  it("returns minutes with minUnit=minute when diff >= 60s", () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2024-01-01T00:10:00Z").getTime());
    expect(getRelativeTime("2024-01-01T00:00:00Z", { minUnit: "minute" })).toBe("10m ago");
  });
});
