/**
 * Reaction engine — runs configured reactions, tracks retry attempts, and
 * escalates to human notification when limits are exceeded.
 *
 * The lifecycle manager owns state transitions; this module owns the "event
 * happened -> run the configured reaction" side of the loop.
 */

import type {
  EventPriority,
  OpenCodeSessionManager,
  OrchestratorConfig,
  OrchestratorEvent,
  ReactionConfig,
  ReactionResult,
  Session,
  SessionId,
} from "./types.js";
import { createEvent, parseDuration } from "./lifecycle-events.js";

/** Per-session, per-reaction retry/escalation tracker. */
interface ReactionTracker {
  attempts: number;
  firstTriggered: Date;
}

export interface ReactionEngine {
  executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
  ): Promise<ReactionResult>;
  clearTracker(sessionId: SessionId, reactionKey: string): void;
  getReactionConfigForSession(session: Session, reactionKey: string): ReactionConfig | null;
  /** Drop trackers for sessions no longer present. */
  pruneTrackers(currentSessionIds: Set<SessionId>): void;
}

export interface ReactionEngineDeps {
  config: OrchestratorConfig;
  sessionManager: OpenCodeSessionManager;
  notifyHuman(event: OrchestratorEvent, priority: EventPriority): Promise<void>;
}

export function createReactionEngine(deps: ReactionEngineDeps): ReactionEngine {
  const { config, sessionManager, notifyHuman } = deps;
  // Nested so we can prune/clear by sessionId without parsing a compound key —
  // SessionId is an unconstrained string and could contain ":".
  const reactionTrackers = new Map<SessionId, Map<string, ReactionTracker>>();

  async function executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
  ): Promise<ReactionResult> {
    let sessionTrackers = reactionTrackers.get(sessionId);
    if (!sessionTrackers) {
      sessionTrackers = new Map();
      reactionTrackers.set(sessionId, sessionTrackers);
    }
    let tracker = sessionTrackers.get(reactionKey);
    if (!tracker) {
      tracker = { attempts: 0, firstTriggered: new Date() };
      sessionTrackers.set(reactionKey, tracker);
    }

    // Increment attempts before checking escalation
    tracker.attempts++;

    const maxRetries = reactionConfig.retries ?? Infinity;
    const escalateAfter = reactionConfig.escalateAfter;
    let shouldEscalate = false;

    if (tracker.attempts > maxRetries) {
      shouldEscalate = true;
    }

    if (typeof escalateAfter === "string") {
      const durationMs = parseDuration(escalateAfter);
      if (durationMs > 0 && Date.now() - tracker.firstTriggered.getTime() > durationMs) {
        shouldEscalate = true;
      }
    }

    if (typeof escalateAfter === "number" && tracker.attempts > escalateAfter) {
      shouldEscalate = true;
    }

    if (shouldEscalate) {
      const event = createEvent("reaction.escalated", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' escalated after ${tracker.attempts} attempts`,
        data: { reactionKey, attempts: tracker.attempts },
      });
      await notifyHuman(event, reactionConfig.priority ?? "urgent");
      return {
        reactionType: reactionKey,
        success: true,
        action: "escalated",
        escalated: true,
      };
    }

    const action = reactionConfig.action ?? "notify";

    switch (action) {
      case "send-to-agent": {
        if (reactionConfig.message) {
          try {
            await sessionManager.send(sessionId, reactionConfig.message);

            return {
              reactionType: reactionKey,
              success: true,
              action: "send-to-agent",
              message: reactionConfig.message,
              escalated: false,
            };
          } catch {
            // Send failed — allow retry on next poll cycle (don't escalate immediately)
            return {
              reactionType: reactionKey,
              success: false,
              action: "send-to-agent",
              escalated: false,
            };
          }
        }
        break;
      }

      case "notify": {
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered notification`,
          data: { reactionKey },
        });
        await notifyHuman(event, reactionConfig.priority ?? "info");
        return {
          reactionType: reactionKey,
          success: true,
          action: "notify",
          escalated: false,
        };
      }

      case "auto-merge": {
        // Auto-merge is handled by the SCM plugin
        // For now, just notify
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered auto-merge`,
          data: { reactionKey },
        });
        await notifyHuman(event, "action");
        return {
          reactionType: reactionKey,
          success: true,
          action: "auto-merge",
          escalated: false,
        };
      }
    }

    return {
      reactionType: reactionKey,
      success: false,
      action,
      escalated: false,
    };
  }

  function clearTracker(sessionId: SessionId, reactionKey: string): void {
    const sessionTrackers = reactionTrackers.get(sessionId);
    if (!sessionTrackers) return;
    sessionTrackers.delete(reactionKey);
    if (sessionTrackers.size === 0) {
      reactionTrackers.delete(sessionId);
    }
  }

  function getReactionConfigForSession(
    session: Session,
    reactionKey: string,
  ): ReactionConfig | null {
    const project = config.projects[session.projectId];
    const globalReaction = config.reactions[reactionKey];
    const projectReaction = project?.reactions?.[reactionKey];
    const reactionConfig = projectReaction
      ? { ...globalReaction, ...projectReaction }
      : globalReaction;
    return reactionConfig ? (reactionConfig as ReactionConfig) : null;
  }

  function pruneTrackers(currentSessionIds: Set<SessionId>): void {
    for (const sessionId of reactionTrackers.keys()) {
      if (!currentSessionIds.has(sessionId)) {
        reactionTrackers.delete(sessionId);
      }
    }
  }

  return {
    executeReaction,
    clearTracker,
    getReactionConfigForSession,
    pruneTrackers,
  };
}
