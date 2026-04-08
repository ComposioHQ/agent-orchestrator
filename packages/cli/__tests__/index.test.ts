import { describe, expect, it, vi } from "vitest";

const parse = vi.fn();

vi.mock("../src/program.js", () => ({
  createProgram: () => ({ parse }),
}));

describe("cli entrypoint", () => {
  it("parses the created program", async () => {
    await import("../src/index.js");
    expect(parse).toHaveBeenCalledOnce();
  });
});
