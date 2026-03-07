/**
 * ao-teams — Team orchestration type definitions.
 *
 * These types extend the base Agent Orchestrator types to support
 * coordinated teams of role-based agents sharing a single worktree.
 *
 * Architecture:
 *   Session -> Workspace -> Team -> [Runtime -> Agent] x N
 *
 * Team sits between Workspace and Agent. Each agent gets its own
 * tmux pane; all share one worktree and branch.
 */

// =============================================================================
// PHASES
// =============================================================================

/** All possible team phases */
export type Phase =
  | "plan"
  | "validate"
  | "implement"
  | "integrate"
  | "review"
  | "revise"
  | "test"
  | "finalize"
  | "refine";

/** Phase state during execution */
export type PhaseState = "pending" | "running" | "completed" | "failed" | "skipped";

/** Phase execution record */
export interface PhaseRecord {
  phase: Phase;
  state: PhaseState;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** Number of attempts (for retryable phases like plan) */
  attempts: number;
}

// =============================================================================
// AGENT ROLES
// =============================================================================

/** Predefined agent roles */
export type AgentRole = "planner" | "driver" | "reviewer" | "tester";

/** Agent status within a phase */
export type AgentPhaseState = "idle" | "spawning" | "working" | "done" | "failed" | "crashed";

/** Per-agent status file content (.agents/status/<name>.json) */
export interface AgentStatus {
  name: string;
  role: AgentRole;
  phase: Phase;
  state: AgentPhaseState;
  currentFile?: string;
  startedAt: string;
  updatedAt: string;
  crashCount: number;
}

// =============================================================================
// TEAM CONFIGURATION
// =============================================================================

/** Configuration for a single agent within a team */
export interface TeamAgentConfig {
  /** Agent role (planner, driver, reviewer, tester) */
  role: AgentRole;
  /** Model to use (sonnet, opus, haiku) */
  model?: string;
  /** Agent plugin override (defaults to team/global default) */
  agent?: string;
  /** Max conversation turns (agent-specific, e.g. Claude Code) */
  maxTurns?: number;
  /** Path to role-specific prompt file */
  promptFile?: string;
  /** Additional skill files for this agent */
  skills?: string[];
  /** Whether this agent is spawned only on demand (e.g. tester) */
  onDemand?: boolean;
}

/** Team definition from YAML config */
export interface TeamDefinition {
  /** Human-readable description */
  description: string;
  /** Ordered list of phases this team executes */
  phases: Phase[];
  /** Max review/revise cycles before aborting (default: 2) */
  maxReviewCycles?: number;
  /** Agent configurations keyed by agent name */
  agents: Record<string, TeamAgentConfig>;
}

/** Team presets */
export const TEAM_PRESETS: Record<string, TeamDefinition> = {
  solo: {
    description: "Single agent, AO-compatible",
    phases: ["implement", "finalize", "refine"],
    agents: {
      worker: { role: "driver", model: "sonnet" },
    },
  },
  pair: {
    description: "Planner + driver",
    phases: ["plan", "validate", "implement", "finalize", "refine"],
    agents: {
      planner: {
        role: "planner",
        model: "sonnet",
        maxTurns: 10,
      },
      driver: {
        role: "driver",
        model: "sonnet",
      },
    },
  },
  quad: {
    description: "Full team for complex tasks",
    phases: [
      "plan",
      "validate",
      "implement",
      "integrate",
      "review",
      "revise",
      "test",
      "finalize",
      "refine",
    ],
    maxReviewCycles: 2,
    agents: {
      planner: {
        role: "planner",
        model: "sonnet",
        maxTurns: 10,
      },
      driver: {
        role: "driver",
        model: "sonnet",
      },
      reviewer: {
        role: "reviewer",
        model: "opus",
      },
      tester: {
        role: "tester",
        model: "haiku",
        onDemand: true,
      },
    },
  },
};

// =============================================================================
// PLAN SCHEMA
// =============================================================================

/** A single unit of work within a plan */
export interface WorkUnit {
  /** Unique identifier (e.g. "wu-1") */
  id: string;
  /** Description of the work to be done */
  description: string;
  /** Agent name this unit is assigned to */
  assignedTo: string;
  /** Files this agent has exclusive write access to */
  files: string[];
  /** Files the unit may read but must not modify */
  sharedReads?: string[];
  /** Acceptance criteria for this work unit */
  criteria: string;
}

/** The plan contract between planner agent and phase engine */
export interface Plan {
  /** Brief description of the overall task */
  summary: string;
  /** Individual work units */
  workUnits: WorkUnit[];
  /** Files no agent may modify during implement (only during integrate) */
  sharedFiles: string[];
  /** Sequence of agent names for the integrate phase */
  integrateOrder: string[];
}

/** Result of plan validation */
export interface PlanValidationResult {
  valid: boolean;
  errors: PlanValidationError[];
}

/** A single plan validation error */
export interface PlanValidationError {
  field: string;
  message: string;
}

// =============================================================================
// MESSAGES
// =============================================================================

/** Message types for inter-agent communication */
export type MessageType =
  | "task_assignment"
  | "status_update"
  | "revision_request"
  | "review_feedback"
  | "question"
  | "response"
  | "system";

/** Priority levels for messages */
export type MessagePriority = "high" | "normal" | "low";

/** A message in the .agents/messages.jsonl log */
export interface BusMessage {
  /** Monotonically increasing sequence number */
  seq: number;
  /** ISO 8601 timestamp */
  ts: string;
  /** Sender agent name or "engine" */
  from: string;
  /** Recipient agent name or "all" */
  to: string;
  /** Current phase when message was sent */
  phase: Phase;
  /** Message type */
  type: MessageType;
  /** Message content */
  content: string;
  /** Referenced files (optional) */
  filesReferenced?: string[];
  /** Message priority */
  priority?: MessagePriority;
}

// =============================================================================
// CONTROL
// =============================================================================

/** Control signals written to .agents/control.json */
export interface ControlSignal {
  /** Signal type */
  signal: "shutdown" | "pause" | "resume" | "abort";
  /** ISO 8601 timestamp */
  ts: string;
  /** Reason for the signal */
  reason?: string;
}

// =============================================================================
// LEARNINGS
// =============================================================================

/** Learning entry categories */
export type LearningCategory = "convention" | "pitfall" | "decision";

/** A buffered learning entry from ao-learn commands */
export interface LearningEntry {
  /** Category of the learning */
  category: LearningCategory;
  /** Description of the learning */
  description: string;
  /** Agent that recorded this */
  recordedBy: string;
  /** Phase when recorded */
  phase: Phase;
  /** ISO 8601 timestamp */
  ts: string;
  /** Task count when last confirmed (for staleness tracking) */
  lastConfirmedTask?: number;
}

/** Refinement command types */
export type RefineAction = "add" | "remove" | "update" | "confirm";

/** A refinement command from ao-refine */
export interface RefineCommand {
  action: RefineAction;
  category: LearningCategory;
  description: string;
  /** Reason for removal (required for "remove") */
  reason?: string;
  /** Additional text to append (for "update") */
  append?: string;
}

// =============================================================================
// TEST TASKS
// =============================================================================

/** Action to take when a test fails */
export type TestFailAction = "agent" | "notify" | "ignore";

/** Test task configuration from YAML */
export interface TestTaskConfig {
  /** Shell command to run */
  command: string;
  /** Timeout in seconds */
  timeout: number;
  /** Whether this test is required for finalize */
  required: boolean;
  /** What to do on failure */
  onFail: TestFailAction;
  /** Max retry attempts */
  maxRetries?: number;
}

/** Result of a test task execution */
export interface TestTaskResult {
  /** Test task name (from config key) */
  name: string;
  /** Whether the test passed */
  passed: boolean;
  /** Exit code */
  exitCode: number;
  /** stdout + stderr */
  output: string;
  /** Attempt number */
  attempt: number;
  /** Duration in milliseconds */
  durationMs: number;
}

// =============================================================================
// LEARNINGS CONFIGURATION
// =============================================================================

/** Learnings configuration from YAML */
export interface LearningsConfig {
  /** Enable .ao/learnings/ accumulation and refine phase */
  enabled: boolean;
  /** Hard cap per category file */
  maxEntriesPerFile: number;
  /** Entries flagged as stale after N tasks without confirmation */
  staleAfterTasks: number;
  /** Entries auto-removed after N tasks without confirmation */
  autoPruneAfterTasks: number;
  /** Commit learnings updates (disable for dry-run) */
  autoCommit: boolean;
}

// =============================================================================
// FILE SCOPE AUDIT
// =============================================================================

/** Result of a file scope audit */
export interface FileScopeAuditResult {
  /** Whether the agent stayed within scope */
  inScope: boolean;
  /** Files modified that are outside the agent's scope */
  outOfScopeFiles: string[];
  /** Files the agent was allowed to modify */
  allowedFiles: string[];
}

// =============================================================================
// TEAM SESSION STATE
// =============================================================================

/** Overall team session state tracked by the phase engine */
export interface TeamSessionState {
  /** Team preset name */
  teamName: string;
  /** Team definition used */
  team: TeamDefinition;
  /** Current phase */
  currentPhase: Phase;
  /** Phase execution history */
  phases: PhaseRecord[];
  /** Current review cycle (for revise loops) */
  reviewCycle: number;
  /** The plan (once created) */
  plan?: Plan;
  /** Path to the worktree */
  worktreePath: string;
  /** Path to the .agents directory */
  agentsDir: string;
  /** ISO 8601 timestamp when the team was created */
  createdAt: string;
  /** ISO 8601 timestamp of last update */
  updatedAt: string;
}

// =============================================================================
// EXTENDED CONFIG (added to OrchestratorConfig)
// =============================================================================

/** Extended project config with team support */
export interface TeamProjectConfig {
  /** Default team preset for this project */
  defaultTeam?: string;
}

/** Skills configuration */
export interface SkillsConfig {
  /** Skill files injected into ALL agents */
  globalSkills: string[];
}

// =============================================================================
// SKILL INJECTION
// =============================================================================

/** Skill injection layer ordering */
export const SKILL_INJECTION_ORDER = [
  "toolkit", // Layer 0: ao-bus command reference
  "project_skills", // Layer 1: skills from YAML
  "project_learnings", // Layer 1.5: .ao/learnings/*.md
  "agent_skills", // Layer 2: per-agent skills from YAML
  "role_prompt", // Layer 3: prompt_file from YAML
  "phase_instructions", // Layer 4: generated by phase engine
  "task_context", // Layer 5: issue body, plan summary
  "messages", // Layer 6: pre-loaded from ao-inbox
  "prior_work", // Layer 7: git diff, review report, test output
] as const;

export type SkillInjectionLayer = (typeof SKILL_INJECTION_ORDER)[number];

// =============================================================================
// COMMIT STRATEGY
// =============================================================================

/** Phases that produce git commits */
export const COMMITTING_PHASES: ReadonlySet<Phase> = new Set([
  "implement",
  "integrate",
  "revise",
  "test",
  "refine",
]);

/** Generate a commit message for a given phase */
export function phaseCommitMessage(phase: Phase, detail: string): string {
  return `[${phase}] ${detail}`;
}
