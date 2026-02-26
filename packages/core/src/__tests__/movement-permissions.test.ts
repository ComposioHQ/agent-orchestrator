import { describe, it, expect } from "vitest";
import {
  createMovementPermissions,
  type PermissionsConfig,
} from "../movement-permissions.js";

// =============================================================================
// Default permission resolution for all standard phases
// =============================================================================

describe("createMovementPermissions", () => {
  describe("default permissions for standard phases", () => {
    const svc = createMovementPermissions();

    it("plan phase defaults to readonly", () => {
      expect(svc.getEffectiveMode("plan")).toBe("readonly");
    });

    it("implement phase defaults to edit", () => {
      expect(svc.getEffectiveMode("implement")).toBe("edit");
    });

    it("review phase defaults to readonly", () => {
      expect(svc.getEffectiveMode("review")).toBe("readonly");
    });

    it("fix phase defaults to edit", () => {
      expect(svc.getEffectiveMode("fix")).toBe("edit");
    });

    it("test phase defaults to readonly", () => {
      expect(svc.getEffectiveMode("test")).toBe("readonly");
    });

    it("deploy phase defaults to full", () => {
      expect(svc.getEffectiveMode("deploy")).toBe("full");
    });

    it("custom phase defaults to edit", () => {
      expect(svc.getEffectiveMode("custom")).toBe("edit");
    });

    it("plan has correct default tool allowlist", () => {
      const permission = svc.resolvePermission("plan");
      expect(permission.allowedTools).toEqual([
        "Read",
        "Glob",
        "Grep",
        "WebSearch",
        "WebFetch",
      ]);
    });

    it("review has correct default tool allowlist", () => {
      const permission = svc.resolvePermission("review");
      expect(permission.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    });

    it("test has correct default tool allowlist", () => {
      const permission = svc.resolvePermission("test");
      expect(permission.allowedTools).toEqual([
        "Read",
        "Glob",
        "Grep",
        "Bash",
      ]);
    });

    it("implement has no explicit allowedTools (uses mode default)", () => {
      const permission = svc.resolvePermission("implement");
      expect(permission.allowedTools).toBeUndefined();
    });
  });

  // ===========================================================================
  // Global config overrides
  // ===========================================================================

  describe("global config overrides", () => {
    it("overrides default mode globally", () => {
      const svc = createMovementPermissions({ defaultMode: "readonly" });
      // Unknown phase should use global default
      expect(svc.getEffectiveMode("unknown-phase")).toBe("readonly");
    });

    it("overrides specific movement permissions", () => {
      const svc = createMovementPermissions({
        movements: {
          plan: { mode: "edit" },
        },
      });
      expect(svc.getEffectiveMode("plan")).toBe("edit");
    });

    it("override with custom allowedTools replaces defaults", () => {
      const svc = createMovementPermissions({
        movements: {
          plan: { mode: "readonly", allowedTools: ["Read", "Grep"] },
        },
      });
      const permission = svc.resolvePermission("plan");
      expect(permission.allowedTools).toEqual(["Read", "Grep"]);
    });
  });

  // ===========================================================================
  // Project-level overrides
  // ===========================================================================

  describe("project-level overrides", () => {
    const config: PermissionsConfig = {
      defaultMode: "edit",
      movements: {
        plan: { mode: "readonly" },
        implement: { mode: "edit" },
      },
      projectOverrides: {
        "my-project": {
          defaultMode: "full",
          movements: {
            plan: { mode: "edit", allowedTools: ["Read", "Edit"] },
          },
        },
        "locked-project": {
          defaultMode: "readonly",
        },
      },
    };

    const svc = createMovementPermissions(config);

    it("project override takes precedence over global movement config", () => {
      expect(svc.getEffectiveMode("plan", "my-project")).toBe("edit");
    });

    it("falls back to global movement config when project has no override for phase", () => {
      expect(svc.getEffectiveMode("implement", "my-project")).toBe("edit");
    });

    it("project default mode is used for unknown phases", () => {
      expect(svc.getEffectiveMode("unknown-phase", "my-project")).toBe("full");
    });

    it("different project can have different default", () => {
      expect(svc.getEffectiveMode("unknown-phase", "locked-project")).toBe(
        "readonly",
      );
    });

    it("project override allowedTools are used", () => {
      const permission = svc.resolvePermission("plan", "my-project");
      expect(permission.allowedTools).toEqual(["Read", "Edit"]);
    });

    it("no project ID falls back to global config", () => {
      expect(svc.getEffectiveMode("plan")).toBe("readonly");
    });

    it("unknown project ID falls back to global config", () => {
      expect(svc.getEffectiveMode("plan", "nonexistent-project")).toBe(
        "readonly",
      );
    });
  });

  // ===========================================================================
  // Tool allowlist checks
  // ===========================================================================

  describe("tool allowlist checks", () => {
    const svc = createMovementPermissions();

    it("Read is allowed in plan phase", () => {
      const result = svc.isToolAllowed("Read", "plan");
      expect(result.allowed).toBe(true);
      expect(result.effectiveMode).toBe("readonly");
    });

    it("Edit is not allowed in plan phase", () => {
      const result = svc.isToolAllowed("Edit", "plan");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Edit");
      expect(result.reason).toContain("plan");
    });

    it("Edit is allowed in implement phase", () => {
      const result = svc.isToolAllowed("Edit", "implement");
      expect(result.allowed).toBe(true);
    });

    it("Bash is allowed in test phase", () => {
      const result = svc.isToolAllowed("Bash", "test");
      expect(result.allowed).toBe(true);
    });

    it("Edit is not allowed in test phase", () => {
      const result = svc.isToolAllowed("Edit", "test");
      expect(result.allowed).toBe(false);
    });

    it("all standard tools allowed in implement phase", () => {
      const result = svc.isToolAllowed("Edit", "implement");
      expect(result.allowed).toBe(true);
      expect(result.allowedTools).toContain("Edit");
      expect(result.allowedTools).toContain("Write");
      expect(result.allowedTools).toContain("Bash");
      expect(result.allowedTools).toContain("Read");
    });

    it("returns the full allowed tools list on check", () => {
      const result = svc.isToolAllowed("Read", "plan");
      expect(result.allowedTools).toEqual([
        "Read",
        "Glob",
        "Grep",
        "WebSearch",
        "WebFetch",
      ]);
    });
  });

  // ===========================================================================
  // Denied tools
  // ===========================================================================

  describe("denied tools", () => {
    it("deniedTools removes tools from the allowed list", () => {
      const svc = createMovementPermissions({
        movements: {
          implement: { mode: "edit", deniedTools: ["Bash"] },
        },
      });
      const result = svc.isToolAllowed("Bash", "implement");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Bash");
    });

    it("deniedTools does not affect other tools", () => {
      const svc = createMovementPermissions({
        movements: {
          implement: { mode: "edit", deniedTools: ["Bash"] },
        },
      });
      const result = svc.isToolAllowed("Edit", "implement");
      expect(result.allowed).toBe(true);
    });

    it("deniedTools works with custom allowedTools", () => {
      const svc = createMovementPermissions({
        movements: {
          plan: {
            mode: "readonly",
            allowedTools: ["Read", "Grep", "Bash"],
            deniedTools: ["Bash"],
          },
        },
      });
      const result = svc.isToolAllowed("Bash", "plan");
      expect(result.allowed).toBe(false);
      // Read should still be allowed
      expect(svc.isToolAllowed("Read", "plan").allowed).toBe(true);
    });
  });

  // ===========================================================================
  // Permission mode hierarchy (minimumMode floor)
  // ===========================================================================

  describe("permission mode hierarchy and minimumMode", () => {
    it("minimumMode elevates readonly to edit", () => {
      const svc = createMovementPermissions({
        movements: {
          plan: { mode: "readonly", minimumMode: "edit" },
        },
      });
      expect(svc.getEffectiveMode("plan")).toBe("edit");
    });

    it("minimumMode elevates readonly to full", () => {
      const svc = createMovementPermissions({
        movements: {
          review: { mode: "readonly", minimumMode: "full" },
        },
      });
      expect(svc.getEffectiveMode("review")).toBe("full");
    });

    it("minimumMode does not downgrade edit to readonly", () => {
      const svc = createMovementPermissions({
        movements: {
          implement: { mode: "edit", minimumMode: "readonly" },
        },
      });
      expect(svc.getEffectiveMode("implement")).toBe("edit");
    });

    it("minimumMode does not downgrade full to edit", () => {
      const svc = createMovementPermissions({
        movements: {
          deploy: { mode: "full", minimumMode: "edit" },
        },
      });
      expect(svc.getEffectiveMode("deploy")).toBe("full");
    });

    it("minimumMode equal to mode is a no-op", () => {
      const svc = createMovementPermissions({
        movements: {
          implement: { mode: "edit", minimumMode: "edit" },
        },
      });
      expect(svc.getEffectiveMode("implement")).toBe("edit");
    });

    it("minimumMode is respected in project overrides", () => {
      const svc = createMovementPermissions({
        projectOverrides: {
          proj: {
            movements: {
              plan: { mode: "readonly", minimumMode: "edit" },
            },
          },
        },
      });
      expect(svc.getEffectiveMode("plan", "proj")).toBe("edit");
    });
  });

  // ===========================================================================
  // toAgentPermissions conversion
  // ===========================================================================

  describe("toAgentPermissions", () => {
    const svc = createMovementPermissions();

    it("readonly maps to 'default'", () => {
      expect(svc.toAgentPermissions("plan")).toBe("default");
    });

    it("edit maps to 'skip'", () => {
      expect(svc.toAgentPermissions("implement")).toBe("skip");
    });

    it("full maps to 'skip'", () => {
      expect(svc.toAgentPermissions("deploy")).toBe("skip");
    });

    it("respects project overrides in conversion", () => {
      const custom = createMovementPermissions({
        projectOverrides: {
          proj: {
            movements: {
              plan: { mode: "edit" },
            },
          },
        },
      });
      // Without project: default plan is readonly → "default"
      expect(custom.toAgentPermissions("plan")).toBe("default");
      // With project: overridden to edit → "skip"
      expect(custom.toAgentPermissions("plan", "proj")).toBe("skip");
    });
  });

  // ===========================================================================
  // getToolsForMode
  // ===========================================================================

  describe("getToolsForMode", () => {
    const svc = createMovementPermissions();

    it("readonly returns read-only tools", () => {
      const tools = svc.getToolsForMode("readonly");
      expect(tools).toContain("Read");
      expect(tools).toContain("Glob");
      expect(tools).toContain("Grep");
      expect(tools).toContain("WebSearch");
      expect(tools).toContain("WebFetch");
      expect(tools).not.toContain("Edit");
      expect(tools).not.toContain("Write");
      expect(tools).not.toContain("Bash");
    });

    it("edit returns standard tools", () => {
      const tools = svc.getToolsForMode("edit");
      expect(tools).toContain("Read");
      expect(tools).toContain("Edit");
      expect(tools).toContain("Write");
      expect(tools).toContain("Bash");
      expect(tools).not.toContain("EnterWorktree");
    });

    it("full returns all tools including dangerous ones", () => {
      const tools = svc.getToolsForMode("full");
      expect(tools).toContain("Read");
      expect(tools).toContain("Edit");
      expect(tools).toContain("Bash");
      expect(tools).toContain("EnterWorktree");
    });

    it("returns a new array each call (no mutation risk)", () => {
      const tools1 = svc.getToolsForMode("edit");
      const tools2 = svc.getToolsForMode("edit");
      expect(tools1).toEqual(tools2);
      expect(tools1).not.toBe(tools2);
    });
  });

  // ===========================================================================
  // Custom movements
  // ===========================================================================

  describe("custom movements", () => {
    it("registers custom movements via config", () => {
      const svc = createMovementPermissions({
        movements: {
          "code-review": { mode: "readonly", allowedTools: ["Read", "Grep"] },
          "security-audit": { mode: "full" },
        },
      });
      expect(svc.getEffectiveMode("code-review")).toBe("readonly");
      expect(svc.getEffectiveMode("security-audit")).toBe("full");
    });

    it("custom movements appear in listMovements", () => {
      const svc = createMovementPermissions({
        movements: {
          "code-review": { mode: "readonly" },
        },
      });
      const movements = svc.listMovements();
      expect(movements["code-review"]).toBeDefined();
      expect(movements["code-review"].mode).toBe("readonly");
    });

    it("project-specific custom movements appear in listMovements", () => {
      const svc = createMovementPermissions({
        projectOverrides: {
          proj: {
            movements: {
              "special-phase": { mode: "full" },
            },
          },
        },
      });
      const movements = svc.listMovements("proj");
      expect(movements["special-phase"]).toBeDefined();
      expect(movements["special-phase"].mode).toBe("full");
    });
  });

  // ===========================================================================
  // listMovements
  // ===========================================================================

  describe("listMovements", () => {
    it("lists all standard phases with no config", () => {
      const svc = createMovementPermissions();
      const movements = svc.listMovements();
      expect(Object.keys(movements)).toContain("plan");
      expect(Object.keys(movements)).toContain("implement");
      expect(Object.keys(movements)).toContain("review");
      expect(Object.keys(movements)).toContain("fix");
      expect(Object.keys(movements)).toContain("test");
      expect(Object.keys(movements)).toContain("deploy");
      expect(Object.keys(movements)).toContain("custom");
    });

    it("includes all 7 standard phases", () => {
      const svc = createMovementPermissions();
      const movements = svc.listMovements();
      expect(Object.keys(movements).length).toBeGreaterThanOrEqual(7);
    });

    it("project-specific listing resolves overrides", () => {
      const svc = createMovementPermissions({
        projectOverrides: {
          proj: {
            movements: {
              plan: { mode: "edit" },
            },
          },
        },
      });
      const movements = svc.listMovements("proj");
      expect(movements["plan"].mode).toBe("edit");
      // Other phases should still use defaults
      expect(movements["review"].mode).toBe("readonly");
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe("edge cases", () => {
    it("unknown phase with no config uses global default mode (edit)", () => {
      const svc = createMovementPermissions();
      expect(svc.getEffectiveMode("nonexistent")).toBe("edit");
    });

    it("unknown phase with custom default mode uses that mode", () => {
      const svc = createMovementPermissions({ defaultMode: "readonly" });
      expect(svc.getEffectiveMode("nonexistent")).toBe("readonly");
    });

    it("works with no config at all", () => {
      const svc = createMovementPermissions();
      expect(svc.getEffectiveMode("plan")).toBe("readonly");
      expect(svc.getEffectiveMode("implement")).toBe("edit");
    });

    it("works with undefined config", () => {
      const svc = createMovementPermissions(undefined);
      expect(svc.getEffectiveMode("plan")).toBe("readonly");
    });

    it("empty movements config falls back to defaults", () => {
      const svc = createMovementPermissions({ movements: {} });
      expect(svc.getEffectiveMode("plan")).toBe("readonly");
      expect(svc.getEffectiveMode("implement")).toBe("edit");
    });

    it("empty projectOverrides falls back to global", () => {
      const svc = createMovementPermissions({ projectOverrides: {} });
      expect(svc.getEffectiveMode("plan", "any-project")).toBe("readonly");
    });

    it("resolvePermission returns a copy (no mutation risk)", () => {
      const svc = createMovementPermissions();
      const p1 = svc.resolvePermission("plan");
      const p2 = svc.resolvePermission("plan");
      expect(p1).toEqual(p2);
      expect(p1).not.toBe(p2);
    });

    it("isToolAllowed returns reason on denial", () => {
      const svc = createMovementPermissions();
      const result = svc.isToolAllowed("Write", "review");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
      expect(typeof result.reason).toBe("string");
    });

    it("isToolAllowed returns no reason on allow", () => {
      const svc = createMovementPermissions();
      const result = svc.isToolAllowed("Read", "plan");
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("empty string tool is not allowed in readonly", () => {
      const svc = createMovementPermissions();
      const result = svc.isToolAllowed("", "plan");
      expect(result.allowed).toBe(false);
    });

    it("handles project override with only defaultMode (no movements)", () => {
      const svc = createMovementPermissions({
        projectOverrides: {
          proj: { defaultMode: "full" },
        },
      });
      // Known phase should still use built-in defaults (not project default)
      expect(svc.getEffectiveMode("plan", "proj")).toBe("readonly");
      // Unknown phase should use project default
      expect(svc.getEffectiveMode("unknown", "proj")).toBe("full");
    });
  });

  // ===========================================================================
  // Full resolution priority chain
  // ===========================================================================

  describe("resolution priority chain", () => {
    const config: PermissionsConfig = {
      defaultMode: "readonly",
      movements: {
        plan: { mode: "edit" },
      },
      projectOverrides: {
        proj: {
          defaultMode: "full",
          movements: {
            plan: { mode: "full" },
          },
        },
      },
    };

    const svc = createMovementPermissions(config);

    it("project movement override > global movement override > built-in default", () => {
      // Project override for plan is "full"
      expect(svc.getEffectiveMode("plan", "proj")).toBe("full");
    });

    it("global movement override > built-in default", () => {
      // Global override for plan is "edit" (built-in is "readonly")
      expect(svc.getEffectiveMode("plan")).toBe("edit");
    });

    it("project default > global default for unknown phases", () => {
      // Project default is "full", global default is "readonly"
      expect(svc.getEffectiveMode("unknown", "proj")).toBe("full");
    });

    it("global default for unknown phases without project", () => {
      expect(svc.getEffectiveMode("unknown")).toBe("readonly");
    });
  });
});
