import { describe, expect, it, vi } from "vitest";

vi.mock("node:module", () => ({
  createRequire: () => (specifier: string) => {
    if (specifier === "node:sqlite") {
      throw new Error("Cannot find module 'node:sqlite'");
    }
    throw new Error(`unexpected require: ${specifier}`);
  },
}));

import { readStoreData } from "./index.js";

describe("readStoreData when node:sqlite cannot be loaded", () => {
  it("returns null instead of throwing", () => {
    expect(readStoreData("/tmp/does-not-matter.db")).toBeNull();
  });
});
