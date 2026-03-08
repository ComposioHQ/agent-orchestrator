import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OrchestratorEvent, NotifyAction } from "@composio/ao-core";
import { manifest, create } from "./index.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "session.spawned",
    priority: "info",
    sessionId: "app-1",
    projectId: "my-project",
    timestamp: new Date("2025-06-15T12:00:00Z"),
    message: "Session app-1 spawned successfully",
    data: {},
    ...overrides,
  };
}

const mockExecute = vi.fn().mockResolvedValue({ successful: true });

vi.mock("@composio/core", () => {
  function MockComposio() {
    return { tools: { execute: mockExecute } };
  }
  return { Composio: MockComposio };
});

function getLastExecuteCall(): { action: string; params: Record<string, any> } {
  const call = mockExecute.mock.calls.at(-1);
  if (!call) throw new Error("Expected Composio execute to be called");
  return { action: call[0] as string, params: call[1] as Record<string, any> };
}

describe("notifier-composio", () => {
  const originalEnv = process.env.COMPOSIO_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.COMPOSIO_API_KEY;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.COMPOSIO_API_KEY = originalEnv;
    } else {
      delete process.env.COMPOSIO_API_KEY;
    }
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("composio");
      expect(manifest.slot).toBe("notifier");
    });

    it("has a version", () => {
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create — config parsing", () => {
    it("reads apiKey from config", () => {
      const notifier = create({ composioApiKey: "test-key" });
      expect(notifier.name).toBe("composio");
    });

    it("reads apiKey from COMPOSIO_API_KEY env var", () => {
      process.env.COMPOSIO_API_KEY = "env-key";
      const notifier = create();
      expect(notifier.name).toBe("composio");
    });

    it("throws on invalid defaultApp", () => {
      expect(() => create({ composioApiKey: "k", defaultApp: "telegram" })).toThrow(
        'Invalid defaultApp: "telegram"',
      );
    });

    it("accepts slack as defaultApp", () => {
      expect(() => create({ composioApiKey: "k", defaultApp: "slack" })).not.toThrow();
    });

    it("accepts discord as defaultApp", () => {
      expect(() => create({ composioApiKey: "k", defaultApp: "discord" })).not.toThrow();
    });

    it("accepts gmail as defaultApp with emailTo", () => {
      expect(() =>
        create({ composioApiKey: "k", defaultApp: "gmail", emailTo: "a@b.com" }),
      ).not.toThrow();
    });

    it("throws when gmail is defaultApp without emailTo", () => {
      expect(() => create({ composioApiKey: "k", defaultApp: "gmail" })).toThrow(
        "emailTo is required",
      );
    });

    it("defaults to slack when defaultApp not specified", async () => {
      const notifier = create({ composioApiKey: "k" });
      await notifier.notify(makeEvent());

      expect(getLastExecuteCall().action).toBe("SLACK_SEND_MESSAGE");
    });
  });

  describe("notify", () => {
    it("accepts legacy _clientOverride objects with executeAction", async () => {
      const legacyExecuteAction = vi.fn().mockResolvedValue({ successful: true });
      const notifier = create({
        composioApiKey: "k",
        _clientOverride: { executeAction: legacyExecuteAction },
      });

      await notifier.notify(makeEvent());

      expect(legacyExecuteAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "SLACK_SEND_MESSAGE",
          params: expect.objectContaining({
            text: expect.stringContaining("Session app-1 spawned successfully"),
          }),
        }),
      );
    });

    it("calls SLACK_SEND_MESSAGE for slack app", async () => {
      const notifier = create({ composioApiKey: "k", defaultApp: "slack" });
      await notifier.notify(makeEvent());

      expect(getLastExecuteCall().action).toBe("SLACK_SEND_MESSAGE");
    });

    it("calls DISCORD_SEND_MESSAGE for discord app", async () => {
      const notifier = create({ composioApiKey: "k", defaultApp: "discord" });
      await notifier.notify(makeEvent());

      expect(getLastExecuteCall().action).toBe("DISCORD_SEND_MESSAGE");
    });

    it("calls GMAIL_SEND_EMAIL for gmail app", async () => {
      const notifier = create({
        composioApiKey: "k",
        defaultApp: "gmail",
        emailTo: "test@test.com",
      });
      await notifier.notify(makeEvent());

      expect(getLastExecuteCall().action).toBe("GMAIL_SEND_EMAIL");
    });

    it("routes to channelId when set", async () => {
      const notifier = create({ composioApiKey: "k", channelId: "C123" });
      await notifier.notify(makeEvent());

      const callArgs = getLastExecuteCall();
      expect(callArgs.params.arguments.channel).toBe("C123");
    });

    it("routes to channelName when channelId not set", async () => {
      const notifier = create({ composioApiKey: "k", channelName: "#general" });
      await notifier.notify(makeEvent());

      const callArgs = getLastExecuteCall();
      expect(callArgs.params.arguments.channel).toBe("#general");
    });

    it("includes priority emoji in text", async () => {
      const notifier = create({ composioApiKey: "k" });
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const callArgs = getLastExecuteCall();
      expect(callArgs.params.arguments.text).toContain("\u{1F6A8}");
    });

    it("includes prUrl when present as string", async () => {
      const notifier = create({ composioApiKey: "k" });
      await notifier.notify(makeEvent({ data: { prUrl: "https://github.com/pull/1" } }));

      const callArgs = getLastExecuteCall();
      expect(callArgs.params.arguments.text).toContain("https://github.com/pull/1");
    });

    it("ignores prUrl when not a string", async () => {
      const notifier = create({ composioApiKey: "k" });
      await notifier.notify(makeEvent({ data: { prUrl: 42 } }));

      const callArgs = getLastExecuteCall();
      expect(callArgs.params.arguments.text).not.toContain("PR:");
    });
  });

  describe("notifyWithActions", () => {
    it("includes action labels in text", async () => {
      const notifier = create({ composioApiKey: "k" });
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/merge" },
        { label: "Kill", callbackEndpoint: "/api/kill" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const callArgs = getLastExecuteCall();
      expect(callArgs.params.arguments.text).toContain("Merge");
      expect(callArgs.params.arguments.text).toContain("Kill");
    });

    it("includes URL actions as links", async () => {
      const notifier = create({ composioApiKey: "k" });
      const actions: NotifyAction[] = [{ label: "View PR", url: "https://github.com/pull/42" }];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const callArgs = getLastExecuteCall();
      expect(callArgs.params.arguments.text).toContain("https://github.com/pull/42");
    });

    it("renders callback-only actions without URL", async () => {
      const notifier = create({ composioApiKey: "k" });
      const actions: NotifyAction[] = [{ label: "Restart", callbackEndpoint: "/api/restart" }];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const callArgs = getLastExecuteCall();
      expect(callArgs.params.arguments.text).toContain("- Restart");
    });

    it("uses correct tool slug for configured app", async () => {
      const notifier = create({ composioApiKey: "k", defaultApp: "discord" });
      const actions: NotifyAction[] = [{ label: "Test", url: "https://example.com" }];
      await notifier.notifyWithActions!(makeEvent(), actions);

      expect(getLastExecuteCall().action).toBe("DISCORD_SEND_MESSAGE");
    });
  });

  describe("post", () => {
    it("sends text payload", async () => {
      const notifier = create({ composioApiKey: "k" });
      await notifier.post!("Hello from AO");

      const callArgs = getLastExecuteCall();
      expect(callArgs.params.arguments.text).toBe("Hello from AO");
    });

    it("overrides channel from context", async () => {
      const notifier = create({ composioApiKey: "k", channelName: "#default" });
      await notifier.post!("test", { channel: "#override" });

      const callArgs = getLastExecuteCall();
      expect(callArgs.params.arguments.channel).toBe("#override");
    });

    it("returns null", async () => {
      const notifier = create({ composioApiKey: "k" });
      const result = await notifier.post!("test");
      expect(result).toBeNull();
    });
  });

  describe("error handling", () => {
    it("throws when SDK returns unsuccessful result", async () => {
      mockExecute.mockResolvedValueOnce({
        successful: false,
        error: "channel not found",
      });

      const notifier = create({ composioApiKey: "k" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("channel not found");
    });

    it("wraps SDK error with descriptive message", async () => {
      mockExecute.mockResolvedValueOnce({
        successful: false,
        error: undefined,
      });

      const notifier = create({ composioApiKey: "k" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("unknown error");
    });
  });

  describe("no-op when no apiKey", () => {
    it("does nothing when no api key", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create();
      await notifier.notify(makeEvent());
      expect(mockExecute).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No composioApiKey"));
      warnSpy.mockRestore();
    });
  });
});
