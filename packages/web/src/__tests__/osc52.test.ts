import { describe, it, expect } from "vitest";

/**
 * Pure-logic tests for OSC 52 clipboard parsing.
 *
 * The actual handler lives inside DirectTerminal's useEffect (registered via
 * xterm's `terminal.parser.registerOscHandler`), so we extract the parsing
 * logic here to validate it independently of the DOM/xterm runtime.
 */

/** Mirrors the parsing logic in DirectTerminal's OSC 52 handler. */
function parseOsc52(data: string): { handled: boolean; text?: string } {
  const semicolonIndex = data.indexOf(";");
  if (semicolonIndex === -1) return { handled: false };

  const base64Content = data.substring(semicolonIndex + 1);
  if (base64Content === "?") {
    // Query request — acknowledge but no text
    return { handled: true };
  }

  try {
    const text = atob(base64Content);
    return { handled: true, text };
  } catch {
    return { handled: true }; // malformed base64 — swallow
  }
}

describe("OSC 52 parsing", () => {
  it("decodes clipboard selection (c)", () => {
    // "c" = clipboard, base64("hello") = "aGVsbG8="
    const result = parseOsc52("c;aGVsbG8=");
    expect(result).toEqual({ handled: true, text: "hello" });
  });

  it("decodes primary selection (p)", () => {
    const result = parseOsc52("p;aGVsbG8=");
    expect(result).toEqual({ handled: true, text: "hello" });
  });

  it("decodes multi-target selection (pc)", () => {
    // tmux sometimes sends multiple targets like "pc"
    const result = parseOsc52("pc;aGVsbG8=");
    expect(result).toEqual({ handled: true, text: "hello" });
  });

  it("handles query request (? payload)", () => {
    const result = parseOsc52("c;?");
    expect(result).toEqual({ handled: true });
  });

  it("returns unhandled when no semicolon present", () => {
    const result = parseOsc52("garbage");
    expect(result).toEqual({ handled: false });
  });

  it("handles invalid base64 gracefully", () => {
    const result = parseOsc52("c;!!!not-base64!!!");
    expect(result).toEqual({ handled: true }); // swallowed
  });

  it("decodes unicode text", () => {
    // btoa can't encode non-latin1 directly, but tmux sends UTF-8 bytes
    // as base64. In a browser, atob returns a byte string which is valid
    // for ASCII-subset UTF-8.
    const base64 = btoa("line1\nline2\ttab");
    const result = parseOsc52(`c;${base64}`);
    expect(result).toEqual({ handled: true, text: "line1\nline2\ttab" });
  });

  it("decodes empty string payload", () => {
    // base64("") = ""
    const result = parseOsc52("c;");
    expect(result).toEqual({ handled: true, text: "" });
  });
});
