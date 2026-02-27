/**
 * Unit tests for config validation (project uniqueness, prefix collisions).
 */

import { describe, it, expect } from "vitest";
import { validateConfig } from "../config.js";

describe("Config Validation - Project Uniqueness", () => {
  it("rejects duplicate project IDs (same basename)", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
        proj2: {
          path: "/other/integrator", // Same basename!
          repo: "org/integrator",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(/Duplicate project ID/);
    expect(() => validateConfig(config)).toThrow(/integrator/);
  });

  it("error message shows conflicting paths", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
        proj2: {
          path: "/other/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
      },
    };

    try {
      validateConfig(config);
      expect.fail("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("/repos/integrator");
      expect(message).toContain("/other/integrator");
    }
  });

  it("accepts unique basenames", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });
});

describe("Config Validation - Session Prefix Uniqueness", () => {
  it("rejects duplicate explicit prefixes", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          sessionPrefix: "app",
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          sessionPrefix: "app", // Same prefix!
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(/Duplicate session prefix/);
    expect(() => validateConfig(config)).toThrow(/"app"/);
  });

  it("rejects duplicate auto-generated prefixes", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          // Auto-generates: "int"
        },
        proj2: {
          path: "/repos/international",
          repo: "org/international",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          // Auto-generates: "int" (collision!)
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(/Duplicate session prefix/);
    expect(() => validateConfig(config)).toThrow(/"int"/);
  });

  it("error shows both conflicting projects", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
        proj2: {
          path: "/repos/international",
          repo: "org/international",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
      },
    };

    try {
      validateConfig(config);
      expect.fail("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("integrator");
      expect(message).toContain("international");
    }
  });

  it("error suggests explicit sessionPrefix override", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          sessionPrefix: "app",
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          sessionPrefix: "app",
        },
      },
    };

    try {
      validateConfig(config);
      expect.fail("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("sessionPrefix");
    }
  });

  it("accepts unique prefixes", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          sessionPrefix: "int",
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          sessionPrefix: "be",
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  it("validates mix of explicit and auto-generated prefixes", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          sessionPrefix: "int", // Explicit
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          // Auto-generates: "bac"
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  it("detects collision when explicit matches auto-generated", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          // Auto-generates: "int"
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          sessionPrefix: "int", // Explicit collision with auto-generated
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(/Duplicate session prefix/);
  });
});

describe("Config Validation - Session Prefix Regex", () => {
  it("accepts valid session prefixes", () => {
    const validPrefixes = ["int", "app", "my-app", "app_v2", "app123"];

    for (const prefix of validPrefixes) {
      const config = {
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            tracker: { plugin: "linear", teamId: "team-1" },
            sessionPrefix: prefix,
          },
        },
      };

      expect(() => validateConfig(config)).not.toThrow();
    }
  });

  it("rejects invalid session prefixes", () => {
    const invalidPrefixes = ["app!", "app@test", "app space", "app/test"];

    for (const prefix of invalidPrefixes) {
      const config = {
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            tracker: { plugin: "linear", teamId: "team-1" },
            sessionPrefix: prefix,
          },
        },
      };

      expect(() => validateConfig(config)).toThrow();
    }
  });
});

describe("Config Schema Validation", () => {
  it("requires projects field", () => {
    const config = {
      // No projects
    };

    expect(() => validateConfig(config)).toThrow();
  });

  it("requires path, repo, and defaultBranch for each project", () => {
    const missingPath = {
      projects: {
        proj1: {
          repo: "org/test",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          // Missing path
        },
      },
    };

    const missingRepo = {
      projects: {
        proj1: {
          path: "/repos/test",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          // Missing repo
        },
      },
    };

    const missingBranch = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          // Missing defaultBranch (should use default)
          automation: {
            mode: "standard",
          },
        },
      },
    };

    expect(() => validateConfig(missingPath)).toThrow();
    expect(() => validateConfig(missingRepo)).toThrow();
    // missingBranch should work (defaults to "main")
    expect(() => validateConfig(missingBranch)).not.toThrow();
  });

  it("sessionPrefix is optional", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          // No sessionPrefix - will be auto-generated
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.sessionPrefix).toBeDefined();
    expect(validated.projects.proj1.sessionPrefix).toBe("test"); // "test" is 4 chars, used as-is
  });

  it("accepts orchestratorAgentConfig field", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          agentConfig: {
            model: "gpt-5.3-codex-spark",
          },
          orchestratorAgentConfig: {
            model: "gpt-5.3-codex",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.agentConfig?.model).toBe("gpt-5.3-codex-spark");
    expect(validated.projects.proj1.orchestratorAgentConfig?.model).toBe("gpt-5.3-codex");
  });
});

describe("Config Defaults", () => {
  it("applies default session prefix from project ID", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.sessionPrefix).toBe("int");
  });

  it("applies default project name from config key", () => {
    const config = {
      projects: {
        "my-project": {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects["my-project"].name).toBe("my-project");
  });

  it("applies default SCM from repo", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test", // Contains "/" → GitHub
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.scm).toEqual({ plugin: "github" });
  });

  it("applies default tracker (GitHub issues) only in standard mode", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          automation: {
            mode: "standard",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.tracker).toEqual({ plugin: "github" });
  });

  it("fails local-only mode when tracker is missing", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          automation: {
            mode: "local-only",
          },
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(/automation\.mode=local-only/);
  });

  it("fails local-only mode when tracker plugin is github", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: { plugin: "github" },
          automation: {
            mode: "local-only",
          },
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(/tracker\.plugin=github/);
  });

  it("accepts local-only mode with explicit non-github tracker", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          automation: {
            mode: "local-only",
          },
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });
});

describe("Config Validation - Reactions", () => {
  it("accepts complete-tracker-issue reaction action", () => {
    const config = {
      reactions: {
        "issue-completed": {
          auto: true,
          action: "complete-tracker-issue",
          priority: "action",
        },
      },
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  it("accepts update-tracker-progress reaction action with cooldown", () => {
    const config = {
      reactions: {
        "issue-progress-pr-opened": {
          auto: true,
          action: "update-tracker-progress",
          cooldown: "5m",
          priority: "info",
        },
      },
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  it("injects local-only tracker progress/complete reactions by default", () => {
    const validated = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
      },
    });

    expect(validated.projects.proj1.reactions?.["issue-progress-pr-opened"]).toMatchObject({
      auto: true,
      action: "update-tracker-progress",
      cooldown: "5m",
    });
    expect(validated.projects.proj1.reactions?.["issue-progress-review-updated"]).toMatchObject({
      auto: true,
      action: "update-tracker-progress",
      cooldown: "5m",
    });
    expect(validated.projects.proj1.reactions?.["issue-completed"]).toMatchObject({
      auto: true,
      action: "complete-tracker-issue",
      priority: "action",
    });
  });

  it("lets explicit project reactions override injected local-only defaults", () => {
    const validated = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          reactions: {
            "issue-completed": {
              auto: true,
              action: "notify",
              priority: "warning",
            },
          },
        },
      },
    });

    expect(validated.projects.proj1.reactions?.["issue-completed"]).toMatchObject({
      auto: true,
      action: "notify",
      priority: "warning",
    });
  });
});

describe("Config Validation - Automation", () => {
  it("applies automation defaults", () => {
    const validated = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
        },
      },
    });

    expect(validated.projects.proj1.automation).toEqual({
      mode: "local-only",
      queuePickup: {
        enabled: true,
        intervalSec: 60,
        pickupStateName: "Todo",
        requireAoMetaQueued: true,
        maxActiveSessions: 8,
        maxSpawnPerCycle: 4,
      },
      mergeGate: {
        enabled: true,
        method: "squash",
        retryCooldownSec: 300,
        strict: {
          requireVerifyMarker: true,
          requireBrowserMarker: true,
          requireApprovedReviewOrNoRequests: true,
          requireNoUnresolvedThreads: true,
          requirePassingChecks: true,
          requireCompletionDryRun: true,
        },
      },
      completionGate: {
        enabled: true,
        evidencePattern: "AC Evidence:|검증 근거:",
        syncChecklistFromEvidence: false,
      },
      stuckRecovery: {
        enabled: true,
        pattern: "Write tests for @filename",
        thresholdSec: 600,
        cooldownSec: 300,
        message:
          "Infer the concrete target file from issue context and proceed without asking for @filename.",
      },
    });
  });

  it("accepts custom automation overrides", () => {
    const validated = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          automation: {
            mode: "standard",
            queuePickup: {
              enabled: false,
              intervalSec: 120,
              pickupStateName: "Todo",
              transitionStateName: "In Progress",
              requireAoMetaQueued: false,
              maxActiveSessions: 16,
              maxSpawnPerCycle: 2,
            },
            mergeGate: {
              enabled: true,
              method: "rebase",
              retryCooldownSec: 45,
              strict: {
                requireVerifyMarker: true,
                requireBrowserMarker: false,
                requireApprovedReviewOrNoRequests: true,
                requireNoUnresolvedThreads: true,
                requirePassingChecks: true,
                requireCompletionDryRun: false,
              },
            },
            completionGate: {
              enabled: true,
              evidencePattern: "Evidence:",
              syncChecklistFromEvidence: true,
            },
            stuckRecovery: {
              enabled: false,
              pattern: "ping",
              thresholdSec: 30,
              cooldownSec: 15,
              message: "ping",
            },
          },
        },
      },
    });

    expect(validated.projects.proj1.automation?.queuePickup?.enabled).toBe(false);
    expect(validated.projects.proj1.automation?.queuePickup?.intervalSec).toBe(120);
    expect(validated.projects.proj1.automation?.queuePickup?.transitionStateName).toBe(
      "In Progress",
    );
    expect(validated.projects.proj1.automation?.queuePickup?.maxActiveSessions).toBe(16);
    expect(validated.projects.proj1.automation?.queuePickup?.maxSpawnPerCycle).toBe(2);
    expect(validated.projects.proj1.automation?.mode).toBe("standard");
    expect(validated.projects.proj1.automation?.mergeGate?.method).toBe("rebase");
    expect(validated.projects.proj1.automation?.mergeGate?.retryCooldownSec).toBe(45);
    expect(validated.projects.proj1.automation?.completionGate?.syncChecklistFromEvidence).toBe(
      true,
    );
    expect(validated.projects.proj1.automation?.stuckRecovery?.enabled).toBe(false);
  });

  it("promotes transitionStateName to pickupStateName for legacy configs", () => {
    const validated = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          automation: {
            queuePickup: {
              transitionStateName: "In Progress",
            },
          },
        },
      },
    });

    expect(validated.projects.proj1.automation?.queuePickup?.pickupStateName).toBe("In Progress");
    expect(validated.projects.proj1.automation?.queuePickup?.transitionStateName).toBe(
      "In Progress",
    );
  });

  it("keeps explicit pickupStateName when both pickup and transition are set", () => {
    const validated = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: { plugin: "linear", teamId: "team-1" },
          automation: {
            queuePickup: {
              pickupStateName: "Todo",
              transitionStateName: "In Progress",
            },
          },
        },
      },
    });

    expect(validated.projects.proj1.automation?.queuePickup?.pickupStateName).toBe("Todo");
    expect(validated.projects.proj1.automation?.queuePickup?.transitionStateName).toBe(
      "In Progress",
    );
  });

  it("rejects invalid queue pickup limits", () => {
    expect(() =>
      validateConfig({
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            tracker: { plugin: "linear", teamId: "team-1" },
            automation: {
              queuePickup: {
                maxActiveSessions: 0,
              },
            },
          },
        },
      }),
    ).toThrow();

    expect(() =>
      validateConfig({
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            tracker: { plugin: "linear", teamId: "team-1" },
            automation: {
              queuePickup: {
                maxSpawnPerCycle: 1.5,
              },
            },
          },
        },
      }),
    ).toThrow();
  });
});
