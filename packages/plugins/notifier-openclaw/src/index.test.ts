import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyAction, OrchestratorEvent } from "@composio/ao-core";
import { create, manifest } from "./index.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "reaction.escalated",
    priority: "urgent",
    sessionId: "ao-5",
    projectId: "ao",
    timestamp: new Date("2026-03-08T12:00:00Z"),
    message: "Reaction escalated after retries",
    data: { attempts: 5, reason: "ci_failed" },
    ...overrides,
  };
}

describe("notifier-openclaw", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENCLAW_HOOKS_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("has correct manifest", () => {
    expect(manifest.name).toBe("openclaw");
    expect(manifest.slot).toBe("notifier");
  });

  it("uses default OpenClaw hooks endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ token: "tok" });
    await notifier.notify(makeEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:18789/hooks/agent");
  });

  it("uses token from OPENCLAW_HOOKS_TOKEN env", async () => {
    process.env.OPENCLAW_HOOKS_TOKEN = "env-token";

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create();
    await notifier.notify(makeEvent());

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer env-token");
  });

  it("resolves token from ${VAR} syntax in config", async () => {
    process.env.OPENCLAW_HOOKS_TOKEN = "env-token";

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ token: "${OPENCLAW_HOOKS_TOKEN}" });
    await notifier.notify(makeEvent());

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer env-token");
  });

  it("warns and sends without Authorization when token missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create();
    await notifier.notify(makeEvent());

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No token configured"));
  });

  it("builds per-session OpenClaw session key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ token: "tok", sessionKeyPrefix: "hook:ao:" });
    await notifier.notify(makeEvent({ sessionId: "ao-12" }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sessionKey).toBe("hook:ao:ao-12");
  });

  it("sanitizes invalid characters in session id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ token: "tok" });
    await notifier.notify(makeEvent({ sessionId: "ao/12?x" }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sessionKey).toBe("hook:ao:ao-12-x");
  });

  it("notifyWithActions appends action labels", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ token: "tok" });
    const actions: NotifyAction[] = [{ label: "retry" }, { label: "kill" }];
    await notifier.notifyWithActions!(makeEvent(), actions);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.message).toContain("Actions available: retry, kill");
  });

  it("post uses context sessionId when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ token: "tok" });
    await notifier.post!("ready", { sessionId: "ao-77" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sessionKey).toBe("hook:ao:ao-77");
    expect(body.message).toBe("ready");
  });

  it("defaults wakeMode=now and deliver=true", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ token: "tok" });
    await notifier.notify(makeEvent());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.wakeMode).toBe("now");
    expect(body.deliver).toBe(true);
    expect(body.channel).toBeUndefined();
    expect(body.to).toBeUndefined();
  });

  it("supports wakeMode=next-heartbeat when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ token: "tok", wakeMode: "next-heartbeat" });
    await notifier.notify(makeEvent());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.wakeMode).toBe("next-heartbeat");
  });

  it("includes explicit destination override when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({
      token: "tok",
      channel: "discord",
      to: "1481253232679325817",
    });
    await notifier.notify(makeEvent());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.channel).toBe("discord");
    expect(body.to).toBe("1481253232679325817");
  });

  it("retries on 5xx response", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve("down") })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ token: "tok", retries: 1, retryDelayMs: 50 });
    const promise = notifier.notify(makeEvent());

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await promise;
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Retry 1/1 for session=ao-5 after HTTP 503"),
    );
  });

  it("does not retry on 4xx response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ token: "tok", retries: 2, retryDelayMs: 1 });
    await expect(notifier.notify(makeEvent())).rejects.toThrow("OpenClaw webhook failed (401)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
