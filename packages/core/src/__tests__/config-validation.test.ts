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
        },
        proj2: {
          path: "/other/integrator", // Same basename!
          repo: "org/integrator",
          defaultBranch: "main",
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
        },
        proj2: {
          path: "/other/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
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
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
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
          sessionPrefix: "app",
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
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
          // Auto-generates: "int"
        },
        proj2: {
          path: "/repos/international",
          repo: "org/international",
          defaultBranch: "main",
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
        },
        proj2: {
          path: "/repos/international",
          repo: "org/international",
          defaultBranch: "main",
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
          sessionPrefix: "app",
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
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
          sessionPrefix: "int",
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
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
          sessionPrefix: "int", // Explicit
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
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
          // Auto-generates: "int"
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
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
            sessionPrefix: prefix,
          },
        },
      };

      expect(() => validateConfig(config)).toThrow();
    }
  });
});

describe("Config Validation - SCM webhook contract", () => {
  it("accepts a project scm webhook block and defaults enabled=true", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          scm: {
            plugin: "github",
            webhook: {
              path: "/api/webhooks/github",
              secretEnvVar: "GITHUB_WEBHOOK_SECRET",
              eventHeader: "x-github-event",
              deliveryHeader: "x-github-delivery",
              signatureHeader: "x-hub-signature-256",
              maxBodyBytes: 1048576,
            },
          },
        },
      },
    });

    expect(config.projects["proj1"]?.scm).toEqual({
      plugin: "github",
      webhook: {
        enabled: true,
        path: "/api/webhooks/github",
        secretEnvVar: "GITHUB_WEBHOOK_SECRET",
        eventHeader: "x-github-event",
        deliveryHeader: "x-github-delivery",
        signatureHeader: "x-hub-signature-256",
        maxBodyBytes: 1048576,
      },
    });
  });

  it("rejects non-positive scm webhook maxBodyBytes", () => {
    expect(() =>
      validateConfig({
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            scm: {
              plugin: "github",
              webhook: {
                maxBodyBytes: 0,
              },
            },
          },
        },
      }),
    ).toThrow();
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
          // Missing path
        },
      },
    };

    const missingRepo = {
      projects: {
        proj1: {
          path: "/repos/test",
          defaultBranch: "main",
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
          // No sessionPrefix - will be auto-generated
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.sessionPrefix).toBeDefined();
    expect(validated.projects.proj1.sessionPrefix).toBe("test"); // "test" is 4 chars, used as-is
  });

  it("accepts orchestratorModel in agentConfig", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          agentConfig: {
            model: "worker-model",
            orchestratorModel: "orchestrator-model",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.agentConfig?.model).toBe("worker-model");
    expect(validated.projects.proj1.agentConfig?.orchestratorModel).toBe("orchestrator-model");
  });

  it("accepts role-specific agent overrides at defaults and project scope", () => {
    const config = {
      defaults: {
        agent: "claude-code",
        orchestrator: {
          agent: "opencode",
        },
        worker: {
          agent: "codex",
        },
      },
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          orchestrator: {
            agent: "claude-code",
            agentConfig: {
              model: "orchestrator-model",
            },
          },
          worker: {
            agent: "codex",
            agentConfig: {
              model: "worker-model",
            },
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.defaults.orchestrator?.agent).toBe("opencode");
    expect(validated.defaults.worker?.agent).toBe("codex");
    expect(validated.projects.proj1.orchestrator?.agent).toBe("claude-code");
    expect(validated.projects.proj1.orchestrator?.agentConfig?.model).toBe("orchestrator-model");
    expect(validated.projects.proj1.worker?.agent).toBe("codex");
    expect(validated.projects.proj1.worker?.agentConfig?.model).toBe("worker-model");
  });

  it("does not inject default permissions into role-specific agent config", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          agentConfig: {
            permissions: "suggest",
          },
          worker: {
            agent: "codex",
            agentConfig: {
              model: "worker-model",
            },
          },
        },
      },
    });

    expect(config.projects.proj1.agentConfig?.permissions).toBe("suggest");
    expect(config.projects.proj1.worker?.agentConfig?.permissions).toBeUndefined();
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
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.scm).toEqual({ plugin: "github" });
  });

  it("applies default tracker (GitHub issues)", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.tracker).toEqual({ plugin: "github" });
  });

  it("infers GitLab tracker default from scm plugin", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          scm: {
            plugin: "gitlab",
            host: "gitlab.company.com",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.scm).toEqual({ plugin: "gitlab", host: "gitlab.company.com" });
    expect(validated.projects.proj1.tracker).toEqual({ plugin: "gitlab" });
  });

  it("infers GitLab scm default from tracker plugin", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            plugin: "gitlab",
            host: "gitlab.com",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.tracker).toEqual({ plugin: "gitlab", host: "gitlab.com" });
    expect(validated.projects.proj1.scm).toEqual({ plugin: "gitlab" });
  });

  it("infers Forgejo tracker/scm defaults from configured plugin", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          scm: {
            plugin: "forgejo",
            host: "git.rankworld.games",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.scm).toEqual({ plugin: "forgejo", host: "git.rankworld.games" });
    expect(validated.projects.proj1.tracker).toEqual({ plugin: "forgejo" });
  });

  it("keeps explicit github plugin even when host contains forgejo", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          scm: {
            plugin: "github",
            host: "forgejo.company.internal",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.scm).toEqual({ plugin: "github", host: "forgejo.company.internal" });
    expect(validated.projects.proj1.tracker).toEqual({ plugin: "github" });
  });

  it("prefers GitLab when host is a GitLab domain containing forgejo-like subdomain", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          scm: {
            plugin: "custom",
            host: "forgejo.gitlab.com",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.scm).toEqual({ host: "forgejo.gitlab.com", plugin: "custom" });
    expect(validated.projects.proj1.tracker).toEqual({ plugin: "gitlab" });
  });
});
