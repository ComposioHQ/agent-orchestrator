import { describe, expect, it } from "vitest";
import * as shim from "../server/terminal-auth";

describe("terminal-auth re-export shim", () => {
  it("exports all terminal auth APIs used by app routes", () => {
    expect(typeof shim.issueTerminalAccess).toBe("function");
    expect(typeof shim.verifyTerminalAccess).toBe("function");
    expect(typeof shim.verifyTerminalAccessNoRateLimit).toBe("function");
    expect(typeof shim.resetTerminalAuthStateForTests).toBe("function");
    expect(typeof shim.TerminalAuthError).toBe("function");
  });
});
