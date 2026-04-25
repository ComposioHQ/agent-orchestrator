import { describe, expect, it } from "vitest";
import * as serverAuth from "../../../server/terminal-auth";
import * as libAuth from "../server/terminal-auth";

describe("terminal auth re-export", () => {
  it("re-exports the server terminal auth helpers", () => {
    expect(libAuth.issueTerminalAccess).toBe(serverAuth.issueTerminalAccess);
    expect(libAuth.verifyTerminalAccess).toBe(serverAuth.verifyTerminalAccess);
    expect(libAuth.resetTerminalAuthStateForTests).toBe(serverAuth.resetTerminalAuthStateForTests);
    expect(libAuth.TerminalAuthError).toBe(serverAuth.TerminalAuthError);
  });
});
