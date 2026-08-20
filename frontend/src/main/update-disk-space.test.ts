// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import {
  DOWNLOAD_RESERVE_BYTES,
  INSTALL_RESERVE_BYTES,
  freeBytesOnVolume,
  gbRoundedUp,
  minFreeBytes,
} from "./update-disk-space";

// node:fs's ESM namespace is not configurable, so statfsSync is mocked at the
// module level instead of via spyOn.
const statfsMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statfsSync: statfsMock as unknown as typeof actual.statfsSync };
});

const BSIZE = 4096;

function stubStatfsBytes(freeBytes: number | "throw"): void {
  statfsMock.mockReset();
  if (freeBytes === "throw") {
    statfsMock.mockImplementation(() => {
      throw new Error("statfs unavailable");
    });
  } else {
    statfsMock.mockImplementation(() => ({ bsize: BSIZE, bavail: Math.floor(freeBytes / BSIZE) }));
  }
}

describe("update-disk-space (#3528)", () => {
  it("computes free bytes from statfs bavail*bsize", () => {
    stubStatfsBytes(2 * BSIZE);
    expect(freeBytesOnVolume(os.tmpdir())).toBe(2 * BSIZE);
  });

  it("returns undefined (fail open) when statfs errors", () => {
    stubStatfsBytes("throw");
    expect(freeBytesOnVolume(os.tmpdir())).toBeUndefined();
  });

  it("minFreeBytes takes the smallest across volumes and skips failed ones", () => {
    statfsMock.mockReset();
    statfsMock.mockImplementation(((p: unknown) => {
      if (String(p).includes("big")) return { bsize: BSIZE, bavail: 4 };
      if (String(p).includes("small")) return { bsize: BSIZE, bavail: 1 };
      throw new Error("statfs unavailable");
    }) as never);
    expect(minFreeBytes(["a", "big", "small", "b"])).toBe(BSIZE);
    expect(minFreeBytes(["a", "b"])).toBeUndefined();
  });

  it("gbRoundedUp rounds up with a floor of 1", () => {
    expect(gbRoundedUp(1)).toBe(1);
    expect(gbRoundedUp(1.5 * 1024 ** 3)).toBe(2);
  });

  it("keeps the reserves the issue sized: ~250MB download, ~1.5GB install", () => {
    expect(DOWNLOAD_RESERVE_BYTES).toBe(250 * 1024 * 1024);
    expect(INSTALL_RESERVE_BYTES).toBe(1.5 * 1024 * 1024 * 1024);
  });
});
