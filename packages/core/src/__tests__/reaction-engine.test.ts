import { describe, it, expect, beforeEach, vi } from "vitest";
import { createReactionEngine } from "../reaction-engine.js";
import type {
  OrchestratorConfig,
  ReactionConfig,
  OpenCodeSessionManager,
  OrchestratorEvent,
  EventPriority,
} from "../types.js";
import { createMockSessionManager, makeSession } from "./test-utils.js";

function makeConfig(
  reactions: Record<string, ReactionConfig> = {},
  projectReactions: Record<string, ReactionConfig> = {},
): OrchestratorConfig {
  return {
    configPath: "/tmp/ao.yaml",
    port: 3000,
    power: { preventIdleSleep: false },
    defaults: { runtime: "mock", agent: "mock-agent", workspace: "mock-ws", notifiers: [] },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: "/tmp/my-app",
        storageKey: "111111111111",
        defaultBranch: "main",
        sessionPrefix: "app",
        reactions: projectReactions,
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions,
    readyThresholdMs: 300_000,
  };
}

describe("reaction-engine", () => {
  let sessionManager: OpenCodeSessionManager;
  let notified: Array<{ event: OrchestratorEvent; priority: EventPriority }>;
  let notifyHuman: (event: OrchestratorEvent, priority: EventPriority) => Promise<void>;

  beforeEach(() => {
    sessionManager = createMockSessionManager();
    notified = [];
    notifyHuman = async (event, priority) => {
      notified.push({ event, priority });
    };
  });

  describe("executeReaction — actions", () => {
    it("sends a message to the agent when action=send-to-agent", async () => {
      const engine = createReactionEngine({
        config: makeConfig(),
        sessionManager,
        notifyHuman,
      });
      const result = await engine.executeReaction("s-1", "my-app", "ci-failed", {
        auto: true,
        action: "send-to-agent",
        message: "Fix CI please",
      });
      expect(result).toEqual({
        reactionType: "ci-failed",
        success: true,
        action: "send-to-agent",
        message: "Fix CI please",
        escalated: false,
      });
      expect(sessionManager.send).toHaveBeenCalledWith("s-1", "Fix CI please");
    });

    it("notifies the human when action=notify", async () => {
      const engine = createReactionEngine({
        config: makeConfig(),
        sessionManager,
        notifyHuman,
      });
      const result = await engine.executeReaction("s-1", "my-app", "agent-stuck", {
        auto: true,
        action: "notify",
        priority: "urgent",
      });
      expect(result.success).toBe(true);
      expect(result.action).toBe("notify");
      expect(notified).toHaveLength(1);
      expect(notified[0]?.priority).toBe("urgent");
      expect(notified[0]?.event.type).toBe("reaction.triggered");
    });

    it("returns success=false when send-to-agent throws", async () => {
      sessionManager.send = vi.fn().mockRejectedValue(new Error("boom"));
      const engine = createReactionEngine({
        config: makeConfig(),
        sessionManager,
        notifyHuman,
      });
      const result = await engine.executeReaction("s-1", "my-app", "ci-failed", {
        auto: true,
        action: "send-to-agent",
        message: "Fix CI",
      });
      expect(result.success).toBe(false);
      expect(result.escalated).toBe(false);
    });
  });

  describe("executeReaction — retry/escalation", () => {
    it("escalates after retries are exceeded", async () => {
      const engine = createReactionEngine({
        config: makeConfig(),
        sessionManager,
        notifyHuman,
      });
      const cfg: ReactionConfig = {
        auto: true,
        action: "send-to-agent",
        message: "retry me",
        retries: 2,
      };
      // attempts 1, 2 -> within retries budget
      await engine.executeReaction("s-1", "my-app", "ci-failed", cfg);
      await engine.executeReaction("s-1", "my-app", "ci-failed", cfg);
      // attempt 3 -> escalated
      const result = await engine.executeReaction("s-1", "my-app", "ci-failed", cfg);
      expect(result.escalated).toBe(true);
      expect(result.action).toBe("escalated");
      expect(notified).toHaveLength(1);
      expect(notified[0]?.event.type).toBe("reaction.escalated");
    });

    it("escalates after numeric escalateAfter threshold", async () => {
      const engine = createReactionEngine({
        config: makeConfig(),
        sessionManager,
        notifyHuman,
      });
      const cfg: ReactionConfig = {
        auto: true,
        action: "send-to-agent",
        message: "m",
        escalateAfter: 1,
      };
      // attempt 1 -> not yet (1 > 1 is false)
      await engine.executeReaction("s-1", "my-app", "k", cfg);
      // attempt 2 -> escalated (2 > 1)
      const result = await engine.executeReaction("s-1", "my-app", "k", cfg);
      expect(result.escalated).toBe(true);
    });

    it("escalates after duration-based escalateAfter elapses", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const engine = createReactionEngine({
          config: makeConfig(),
          sessionManager,
          notifyHuman,
        });
        const cfg: ReactionConfig = {
          auto: true,
          action: "send-to-agent",
          message: "m",
          escalateAfter: "30m",
        };
        await engine.executeReaction("s-1", "my-app", "k", cfg);
        // Jump forward 31 minutes
        vi.setSystemTime(new Date("2026-01-01T00:31:00Z"));
        const result = await engine.executeReaction("s-1", "my-app", "k", cfg);
        expect(result.escalated).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("tracker lifecycle", () => {
    it("clearTracker resets the attempt count", async () => {
      const engine = createReactionEngine({
        config: makeConfig(),
        sessionManager,
        notifyHuman,
      });
      const cfg: ReactionConfig = {
        auto: true,
        action: "send-to-agent",
        message: "m",
        retries: 2,
      };
      await engine.executeReaction("s-1", "my-app", "k", cfg);
      await engine.executeReaction("s-1", "my-app", "k", cfg);
      engine.clearTracker("s-1", "k");
      // Cleared — should not escalate on next attempt
      const result = await engine.executeReaction("s-1", "my-app", "k", cfg);
      expect(result.escalated).toBe(false);
    });

    it("pruneTrackers drops state for sessions no longer present", async () => {
      const engine = createReactionEngine({
        config: makeConfig(),
        sessionManager,
        notifyHuman,
      });
      const cfg: ReactionConfig = {
        auto: true,
        action: "send-to-agent",
        message: "m",
        retries: 1,
      };
      // s-1 reaches retries budget
      await engine.executeReaction("s-1", "my-app", "k", cfg);
      await engine.executeReaction("s-1", "my-app", "k", cfg);
      // Prune removes s-1 because it's not in the active set
      engine.pruneTrackers(new Set(["s-2"]));
      // After pruning, a fresh execution should not be escalated
      const result = await engine.executeReaction("s-1", "my-app", "k", cfg);
      expect(result.escalated).toBe(false);
    });

    it("handles session IDs containing ':' without ambiguity", async () => {
      const engine = createReactionEngine({
        config: makeConfig(),
        sessionManager,
        notifyHuman,
      });
      const cfg: ReactionConfig = {
        auto: true,
        action: "send-to-agent",
        message: "m",
        retries: 1,
      };
      // Session IDs that would collide if a compound "sessionId:reactionKey"
      // key were split on the first ":".
      await engine.executeReaction("sess:abc", "my-app", "ci-failed", cfg);
      await engine.executeReaction("sess:abc", "my-app", "ci-failed", cfg);
      // Pruning with "sess:abc" in the active set must NOT wipe it.
      engine.pruneTrackers(new Set(["sess:abc"]));
      const result = await engine.executeReaction("sess:abc", "my-app", "ci-failed", cfg);
      expect(result.escalated).toBe(true);
    });
  });

  describe("getReactionConfigForSession", () => {
    it("returns null when no config is defined anywhere", () => {
      const engine = createReactionEngine({
        config: makeConfig(),
        sessionManager,
        notifyHuman,
      });
      const session = makeSession({ projectId: "my-app" });
      expect(engine.getReactionConfigForSession(session, "missing")).toBeNull();
    });

    it("returns the global reaction when no project override exists", () => {
      const global: ReactionConfig = { auto: true, action: "notify" };
      const engine = createReactionEngine({
        config: makeConfig({ "ci-failed": global }),
        sessionManager,
        notifyHuman,
      });
      const session = makeSession({ projectId: "my-app" });
      expect(engine.getReactionConfigForSession(session, "ci-failed")).toEqual(global);
    });

    it("merges project reaction on top of global reaction", () => {
      const global: ReactionConfig = {
        auto: true,
        action: "send-to-agent",
        message: "global",
        retries: 3,
      };
      const project: ReactionConfig = {
        auto: true,
        action: "send-to-agent",
        message: "project override",
      };
      const engine = createReactionEngine({
        config: makeConfig({ "ci-failed": global }, { "ci-failed": project }),
        sessionManager,
        notifyHuman,
      });
      const session = makeSession({ projectId: "my-app" });
      const merged = engine.getReactionConfigForSession(session, "ci-failed");
      expect(merged).toMatchObject({
        action: "send-to-agent",
        message: "project override",
        retries: 3,
      });
    });
  });
});
