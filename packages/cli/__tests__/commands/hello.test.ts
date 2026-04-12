import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerHello } from "../../src/commands/hello.js";

describe("hello command", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerHello(program);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints hello world", async () => {
    await program.parseAsync(["node", "test", "hello"]);

    expect(console.log).toHaveBeenCalledWith("hello world");
  });
});
