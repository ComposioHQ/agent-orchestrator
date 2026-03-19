import { describe, it, expect } from "vitest";

import { Command } from "commander";
import { registerInit } from "../../src/commands/init.js";

describe("init command", () => {
  it("registers as a deprecated command", () => {
    const program = new Command();
    registerInit(program);

    const initCmd = program.commands.find((c) => c.name() === "init");
    expect(initCmd).toBeDefined();
    expect(initCmd!.description()).toContain("deprecated");
  });

  it("has no --output, --auto, or --smart flags", () => {
    const program = new Command();
    registerInit(program);

    const initCmd = program.commands.find((c) => c.name() === "init");
    expect(initCmd).toBeDefined();

    const optionNames = initCmd!.options.map((o) => o.long);
    expect(optionNames).not.toContain("--output");
    expect(optionNames).not.toContain("--auto");
    expect(optionNames).not.toContain("--smart");
  });
});
