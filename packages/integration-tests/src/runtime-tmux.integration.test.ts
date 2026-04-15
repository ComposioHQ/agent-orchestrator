import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tmuxPlugin from "@aoagents/ao-plugin-runtime-tmux";
import type { RuntimeHandle } from "@aoagents/ao-core";
import { isTmuxAvailable, killSessionsByPrefix } from "./helpers/tmux.js";

const tmuxOk = await isTmuxAvailable();
const SESSION_PREFIX = "ao-inttest-tmux-";

describe.skipIf(!tmuxOk)("runtime-tmux (integration)", () => {
  const runtime = tmuxPlugin.create();
  const sessionId = `${SESSION_PREFIX}${Date.now()}`;
  let handle: RuntimeHandle;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);
  }, 30_000);

  afterAll(async () => {
    try {
      await runtime.destroy(handle);
    } catch {
      /* best-effort cleanup */
    }
    await killSessionsByPrefix(SESSION_PREFIX);
  }, 30_000);

  it("creates a tmux session", async () => {
    handle = await runtime.create({
      sessionId,
      workspacePath: "/tmp",
      launchCommand: "cat", // cat will wait for stdin
      environment: { AO_TEST: "1" },
    });

    expect(handle.id).toBe(sessionId);
    expect(handle.runtimeName).toBe("tmux");
  });

  it("isAlive returns true for running session", async () => {
    expect(await runtime.isAlive(handle)).toBe(true);
  });

  // sendMessage now writes to an inbox file (file-based protocol) and requires
  // an AO-managed session handle with sessionsDir/sessionId. These tests covered
  // the old tmux send-keys path which has been removed per the file-based comms
  // protocol (issue #853). End-to-end message delivery is covered by the
  // runtime-file integration tests.
  it.skip("sendMessage sends text and getOutput captures it", async () => {});
  it.skip("sendMessage handles long text via buffer", async () => {});

  it("getMetrics returns uptime", async () => {
    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThan(0);
  });

  it("getAttachInfo returns tmux command", async () => {
    const info = await runtime.getAttachInfo!(handle);
    expect(info.type).toBe("tmux");
    expect(info.target).toBe(sessionId);
    expect(info.command).toContain("tmux attach");
  });

  it("destroy kills the session", async () => {
    await runtime.destroy(handle);
    expect(await runtime.isAlive(handle)).toBe(false);
  });

  it("destroy is idempotent", async () => {
    // Should not throw even though session is already dead
    await runtime.destroy(handle);
  });
});
