/**
 * Movement Permissions — Core Lifecycle Enhancement
 *
 * Per-movement (lifecycle phase) permission service for the agent orchestrator.
 * Defines three-tier permission levels (readonly, edit, full), maps lifecycle
 * phases to permissions, resolves overrides with priority ordering, and validates
 * tool access per phase.
 *
 * Resolution priority: session-specific override > project default > global default
 */

// =============================================================================
// Types
// =============================================================================

/** Three-tier permission level */
export type PermissionMode = "readonly" | "edit" | "full";

/** Standard lifecycle phases/movements */
export type MovementPhase =
  | "plan"
  | "implement"
  | "review"
  | "fix"
  | "test"
  | "deploy"
  | "custom";

/** Permission configuration for a single movement */
export interface MovementPermission {
  /** The permission mode for this movement */
  mode: PermissionMode;
  /** Optional: specific tools allowed (if not set, all tools for the mode are allowed) */
  allowedTools?: string[];
  /** Optional: specific tools denied */
  deniedTools?: string[];
  /** Minimum required permission mode (floor) — cannot be reduced below this */
  minimumMode?: PermissionMode;
}

/** Top-level permissions configuration */
export interface PermissionsConfig {
  /** Global default permission mode (default: "edit") */
  defaultMode?: PermissionMode;
  /** Per-movement permission overrides */
  movements?: Record<string, MovementPermission>;
  /** Per-project overrides */
  projectOverrides?: Record<
    string,
    {
      defaultMode?: PermissionMode;
      movements?: Record<string, MovementPermission>;
    }
  >;
}

/** Result of a permission check */
export interface PermissionCheck {
  /** Whether the action is allowed */
  allowed: boolean;
  /** The effective permission mode */
  effectiveMode: PermissionMode;
  /** Reason if not allowed */
  reason?: string;
  /** Tools allowed in this context */
  allowedTools?: string[];
}

/** The movement permissions service interface */
export interface MovementPermissions {
  /** Resolve the effective permission for a movement/phase */
  resolvePermission(
    phase: MovementPhase | string,
    projectId?: string,
  ): MovementPermission;

  /** Check if a specific tool is allowed in a phase */
  isToolAllowed(
    tool: string,
    phase: MovementPhase | string,
    projectId?: string,
  ): PermissionCheck;

  /** Get the effective permission mode for a phase */
  getEffectiveMode(
    phase: MovementPhase | string,
    projectId?: string,
  ): PermissionMode;

  /** Convert permission mode to agent-compatible format */
  toAgentPermissions(
    phase: MovementPhase | string,
    projectId?: string,
  ): "skip" | "default";

  /** Get the default tool allowlist for a permission mode */
  getToolsForMode(mode: PermissionMode): string[];

  /** List all configured movements and their permissions */
  listMovements(projectId?: string): Record<string, MovementPermission>;
}

// =============================================================================
// Constants
// =============================================================================

/** Permission mode hierarchy: readonly < edit < full */
const MODE_RANK: Record<PermissionMode, number> = {
  readonly: 0,
  edit: 1,
  full: 2,
};

/** Tools available in readonly mode */
const READONLY_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
];

/** Tools available in edit mode (all standard tools) */
const EDIT_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Edit",
  "Write",
  "Bash",
  "NotebookEdit",
];

/** Tools available in full mode (all tools including dangerous ones) */
const FULL_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Edit",
  "Write",
  "Bash",
  "NotebookEdit",
  "EnterWorktree",
];

/** Default tool allowlists per permission mode */
const MODE_TOOLS: Record<PermissionMode, readonly string[]> = {
  readonly: READONLY_TOOLS,
  edit: EDIT_TOOLS,
  full: FULL_TOOLS,
};

/** Standard phases recognized by the system */
const STANDARD_PHASES: ReadonlySet<string> = new Set([
  "plan",
  "implement",
  "review",
  "fix",
  "test",
  "deploy",
  "custom",
]);

/** Default movement permissions for standard lifecycle phases */
const DEFAULT_MOVEMENT_PERMISSIONS: Record<string, MovementPermission> = {
  plan: {
    mode: "readonly",
    allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
  },
  implement: {
    mode: "edit",
  },
  review: {
    mode: "readonly",
    allowedTools: ["Read", "Glob", "Grep"],
  },
  fix: {
    mode: "edit",
  },
  test: {
    mode: "readonly",
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
  },
  deploy: {
    mode: "full",
  },
  custom: {
    mode: "edit",
  },
};

/** Default global permission mode */
const DEFAULT_MODE: PermissionMode = "edit";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Compare two permission modes.
 * Returns true if `a` is at least as permissive as `b`.
 */
function isAtLeast(a: PermissionMode, b: PermissionMode): boolean {
  return MODE_RANK[a] >= MODE_RANK[b];
}

/**
 * Enforce minimum mode floor on a permission.
 * If the permission has a minimumMode, elevate the mode if necessary.
 */
function enforceMinimumMode(
  permission: MovementPermission,
): MovementPermission {
  if (!permission.minimumMode) return permission;

  if (!isAtLeast(permission.mode, permission.minimumMode)) {
    return {
      ...permission,
      mode: permission.minimumMode,
    };
  }
  return permission;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a movement permissions service.
 *
 * @param config - Optional permissions configuration
 * @returns MovementPermissions service instance
 */
export function createMovementPermissions(
  config?: PermissionsConfig,
): MovementPermissions {
  const globalDefaultMode = config?.defaultMode ?? DEFAULT_MODE;
  const globalMovements = config?.movements ?? {};
  const projectOverrides = config?.projectOverrides ?? {};

  /**
   * Resolve the effective permission for a movement/phase.
   *
   * Resolution priority:
   * 1. Project-specific movement override
   * 2. Project-specific default mode
   * 3. Global movement config
   * 4. Global default mode
   * 5. Built-in default movement permissions
   */
  function resolvePermission(
    phase: MovementPhase | string,
    projectId?: string,
  ): MovementPermission {
    let resolved: MovementPermission | undefined;

    // Priority 1: Project-specific movement override
    if (projectId && projectOverrides[projectId]?.movements?.[phase]) {
      resolved = { ...projectOverrides[projectId].movements![phase] };
    }

    // Priority 2: Global movement config override
    if (!resolved && globalMovements[phase]) {
      resolved = { ...globalMovements[phase] };
    }

    // Priority 3: Built-in default movement permissions
    if (!resolved && DEFAULT_MOVEMENT_PERMISSIONS[phase]) {
      resolved = { ...DEFAULT_MOVEMENT_PERMISSIONS[phase] };
    }

    // Priority 4: Fallback — use project default mode or global default mode
    if (!resolved) {
      const fallbackMode =
        projectId && projectOverrides[projectId]?.defaultMode
          ? projectOverrides[projectId].defaultMode!
          : globalDefaultMode;
      resolved = { mode: fallbackMode };
    }

    // Apply minimum mode floor
    return enforceMinimumMode(resolved);
  }

  /**
   * Get the effective permission mode for a phase.
   */
  function getEffectiveMode(
    phase: MovementPhase | string,
    projectId?: string,
  ): PermissionMode {
    return resolvePermission(phase, projectId).mode;
  }

  /**
   * Compute the effective tool list for a resolved permission.
   */
  function getEffectiveTools(permission: MovementPermission): string[] {
    // Start with either explicit allowedTools or the mode's default tools
    let tools: string[];
    if (permission.allowedTools) {
      tools = [...permission.allowedTools];
    } else {
      tools = [...MODE_TOOLS[permission.mode]];
    }

    // Remove denied tools
    if (permission.deniedTools && permission.deniedTools.length > 0) {
      const denied = new Set(permission.deniedTools);
      tools = tools.filter((t) => !denied.has(t));
    }

    return tools;
  }

  /**
   * Check if a specific tool is allowed in a phase.
   */
  function isToolAllowed(
    tool: string,
    phase: MovementPhase | string,
    projectId?: string,
  ): PermissionCheck {
    const permission = resolvePermission(phase, projectId);
    const effectiveTools = getEffectiveTools(permission);
    const allowed = effectiveTools.includes(tool);

    return {
      allowed,
      effectiveMode: permission.mode,
      reason: allowed
        ? undefined
        : `Tool "${tool}" is not allowed in phase "${phase}" (mode: ${permission.mode})`,
      allowedTools: effectiveTools,
    };
  }

  /**
   * Convert permission mode to agent-compatible format.
   * "readonly" → "default" (agent respects its own permission system)
   * "edit" → "skip" (skip permission prompts for editing)
   * "full" → "skip" (skip all permission prompts)
   */
  function toAgentPermissions(
    phase: MovementPhase | string,
    projectId?: string,
  ): "skip" | "default" {
    const mode = getEffectiveMode(phase, projectId);
    return mode === "readonly" ? "default" : "skip";
  }

  /**
   * Get the default tool allowlist for a permission mode.
   */
  function getToolsForMode(mode: PermissionMode): string[] {
    return [...MODE_TOOLS[mode]];
  }

  /**
   * List all configured movements and their resolved permissions.
   */
  function listMovements(
    projectId?: string,
  ): Record<string, MovementPermission> {
    const result: Record<string, MovementPermission> = {};

    // Start with all standard phases
    for (const phase of STANDARD_PHASES) {
      result[phase] = resolvePermission(phase, projectId);
    }

    // Add any custom movements from global config
    for (const phase of Object.keys(globalMovements)) {
      if (!result[phase]) {
        result[phase] = resolvePermission(phase, projectId);
      }
    }

    // Add any custom movements from project overrides
    if (projectId && projectOverrides[projectId]?.movements) {
      for (const phase of Object.keys(
        projectOverrides[projectId].movements!,
      )) {
        if (!result[phase]) {
          result[phase] = resolvePermission(phase, projectId);
        }
      }
    }

    return result;
  }

  return {
    resolvePermission,
    isToolAllowed,
    getEffectiveMode,
    toAgentPermissions,
    getToolsForMode,
    listMovements,
  };
}
