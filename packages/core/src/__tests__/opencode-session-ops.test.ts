import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { findOpenCodeSessionIds } from "../opencode-session-ops.js";

describe("findOpenCodeSessionIds", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = join(tmpdir(), `ao-opencode-ops-${randomUUID()}`);
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(join(sessionsDir, "archive"), { recursive: true });
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  function writeActive(id: string, fields: Record<string, string>): void {
    const content = Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    writeFileSync(join(sessionsDir, id), content + "\n");
  }

  function writeArchived(id: string, timestamp: string, fields: Record<string, string>): void {
    const content = Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    writeFileSync(join(sessionsDir, "archive", `${id}_${timestamp}`), content + "\n");
  }

  it("returns only opencode agent sessions with a valid mapping", () => {
    writeActive("app-1", { agent: "opencode", opencodeSessionId: "ses_abc1" });
    writeActive("app-2", { agent: "claude-code", opencodeSessionId: "ses_abc2" });
    writeActive("app-3", { agent: "opencode" });

    expect(findOpenCodeSessionIds(sessionsDir, {})).toEqual(["ses_abc1"]);
  });

  it("filters by issueId when provided", () => {
    writeActive("app-1", { agent: "opencode", issue: "INT-1", opencodeSessionId: "ses_one" });
    writeActive("app-2", { agent: "opencode", issue: "INT-2", opencodeSessionId: "ses_two" });

    expect(findOpenCodeSessionIds(sessionsDir, { issueId: "INT-2" })).toEqual(["ses_two"]);
  });

  it("sorts higher numeric suffixes first to prefer the most recent session", () => {
    writeActive("app-2", { agent: "opencode", opencodeSessionId: "ses_two" });
    writeActive("app-10", { agent: "opencode", opencodeSessionId: "ses_ten" });
    writeActive("app-1", { agent: "opencode", opencodeSessionId: "ses_one" });

    expect(findOpenCodeSessionIds(sessionsDir, {})).toEqual(["ses_ten", "ses_two", "ses_one"]);
  });

  it("falls back to archived metadata when active metadata is missing", () => {
    writeArchived("app-1", "2025-01-01T00:00:00Z", {
      agent: "opencode",
      opencodeSessionId: "ses_archived",
    });

    expect(findOpenCodeSessionIds(sessionsDir, { sessionId: "app-1" })).toEqual(["ses_archived"]);
  });

  it("deduplicates results when the same opencode id appears in active and archive", () => {
    writeActive("app-1", { agent: "opencode", opencodeSessionId: "ses_dup" });
    writeArchived("app-1", "2025-01-01T00:00:00Z", {
      agent: "opencode",
      opencodeSessionId: "ses_dup",
    });

    expect(findOpenCodeSessionIds(sessionsDir, {})).toEqual(["ses_dup"]);
  });

  it("skips entries whose mapping fails opencode session id validation", () => {
    writeActive("app-1", { agent: "opencode", opencodeSessionId: "not a valid id" });
    writeActive("app-2", { agent: "opencode", opencodeSessionId: "ses_ok" });

    expect(findOpenCodeSessionIds(sessionsDir, {})).toEqual(["ses_ok"]);
  });
});
