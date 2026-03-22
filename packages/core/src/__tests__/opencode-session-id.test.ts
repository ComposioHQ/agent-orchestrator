import { describe, expect, it } from "vitest";
import { asValidOpenCodeSessionId } from "../opencode-session-id.js";

describe("asValidOpenCodeSessionId", () => {
  it("accepts valid OpenCode session ids", () => {
    expect(asValidOpenCodeSessionId("ses_abc123")).toBe("ses_abc123");
    expect(asValidOpenCodeSessionId(" ses_ABC-123_xyz ")).toBe("ses_ABC-123_xyz");
  });

  it("rejects invalid OpenCode session ids", () => {
    expect(asValidOpenCodeSessionId("")).toBeUndefined();
    expect(asValidOpenCodeSessionId("ses bad")).toBeUndefined();
    expect(asValidOpenCodeSessionId("abc123")).toBeUndefined();
    expect(asValidOpenCodeSessionId(123)).toBeUndefined();
  });
});
