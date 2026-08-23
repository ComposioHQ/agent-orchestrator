package ports

import (
	"context"
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

var ErrWorkspaceProjectUnsupported = errors.New("workspace project materialization is not supported by workspace adapter")

// SessionExecution is the single placement seam for a session. Implementations
// own the workspace, runtime, message transport, and every file/process
// operation that must happen where the agent executes.
type SessionExecution interface {
	SessionEnvironment

	Workspace() Workspace
	Runtime() Runtime
	Messenger() AgentMessenger
	Observation() WorkspaceObservation
	BeginSession(ctx context.Context, spec ExecutionSpec) (SessionProvision, error)
}

// SessionEnvironment contains placement-sensitive operations for an existing
// environment. Paths passed to or returned by these methods are paths as seen
// by that environment; callers must never assume they exist on the control
// plane filesystem.
type SessionEnvironment interface {
	ValidateHostPrerequisites(ctx context.Context) error
	ReadProjectFile(ctx context.Context, projectPath, rel string) ([]byte, error)
	StageSystemPrompt(ctx context.Context, id domain.SessionID, systemPrompt string) (string, error)
	DiscardSystemPrompt(ctx context.Context, id domain.SessionID)
	StageAttachments(ctx context.Context, id domain.SessionID, workspacePath string, attachments []SpawnAttachment) ([]string, error)
	PutAttachment(ctx context.Context, id domain.SessionID, workspacePath, name string, data []byte) error
	ImportAttachments(ctx context.Context, id domain.SessionID, workspacePath string) error
	RestoreAttachments(ctx context.Context, id domain.SessionID, workspacePath string) (bool, error)
	RemoveAttachments(ctx context.Context, id domain.SessionID) error
	Provision(ctx context.Context, spec WorkspaceProvisionSpec) error
	InstallAgentHooks(ctx context.Context, spec AgentPrepareSpec) error
	RemoveAgentState(ctx context.Context, spec AgentPrepareSpec) error
	ResolveLaunchBinary(ctx context.Context, argv []string, env map[string]string) (map[string]string, error)
	BindRuntimeConfig(ctx context.Context, cfg RuntimeConfig) (RuntimeConfig, error)
	ResolveDiffBase(ctx context.Context, workspacePath, defaultBranch string) (sha, ref string)
}

// SessionProvision is the rollback boundary for a new execution environment.
// The manager drives it in this order: prompt, workspace, project provisioning,
// attachments, hooks, binary resolution, runtime binding, runtime launch,
// diff-base observation, commit. Rollback must remove all transaction-owned
// artifacts in reverse order and is idempotent.
type SessionProvision interface {
	SessionEnvironment
	CreateWorkspace(ctx context.Context, spec WorkspaceCreateSpec) (WorkspaceInfo, *WorkspaceProjectInfo, error)
	// LaunchRuntime creates the agent runtime inside this transaction. Remote
	// implementations must include it in Commit/Rollback atomically with the
	// sandbox, checkout, and staged files.
	LaunchRuntime(ctx context.Context, cfg RuntimeConfig) (RuntimeHandle, error)
	Commit(ctx context.Context) error
	Rollback(ctx context.Context, opts RollbackOptions) RollbackOutcome
}

type ExecutionSpec struct {
	SessionID   domain.SessionID
	ProjectID   domain.ProjectID
	Kind        domain.SessionKind
	Harness     domain.AgentHarness
	ProjectPath string
	Branch      string
}

type WorkspaceCreateSpec struct {
	Workspace WorkspaceConfig
	Project   *WorkspaceProjectConfig
}

type WorkspaceProvisionSpec struct {
	ProjectPath   string
	WorkspacePath string
	Symlinks      []string
	PostCreate    []string
}

// AgentPrepareSpec carries both the local adapter and its serializable
// identity. Local execution uses Agent; remote execution uses Harness and the
// hook/launch data without attempting to send an in-process interface across
// the sandbox boundary.
type AgentPrepareSpec struct {
	Agent     Agent
	Harness   domain.AgentHarness
	SessionID domain.SessionID
	Hooks     WorkspaceHookConfig
	PreLaunch LaunchConfig
}

type RollbackOptions struct {
	AgentStatePrepared bool
	RuntimeDestroyed   bool
}

type RollbackOutcome struct {
	WorkspaceDestroyed bool
}

// RemoteSessionExecutionBackend is the compute-plane protocol consumed by the
// remote adapter. Implementations may use one RPC or several, but Commit and
// Rollback provide a single atomic provisioning boundary. Transaction methods
// receive an opaque execution id; persistent lifecycle methods use the normal
// Runtime, Workspace, and AgentMessenger contracts.
type RemoteSessionExecutionBackend interface {
	RuntimeBackend() Runtime
	WorkspaceBackend() Workspace
	MessengerBackend() AgentMessenger
	ObservationBackend() WorkspaceObservation

	BeginExecution(ctx context.Context, spec ExecutionSpec) (executionID string, err error)
	StageExecutionSystemPrompt(ctx context.Context, executionID string, id domain.SessionID, prompt string) (string, error)
	CreateExecutionWorkspace(ctx context.Context, executionID string, spec WorkspaceCreateSpec) (WorkspaceInfo, *WorkspaceProjectInfo, error)
	ProvisionExecutionWorkspace(ctx context.Context, executionID string, spec WorkspaceProvisionSpec) error
	StageExecutionAttachments(ctx context.Context, executionID string, id domain.SessionID, workspacePath string, attachments []SpawnAttachment) ([]string, error)
	PutExecutionAttachment(ctx context.Context, id domain.SessionID, workspacePath, name string, data []byte) error
	InstallExecutionAgent(ctx context.Context, executionID string, spec RemoteAgentPrepareSpec) error
	ResolveExecutionBinary(ctx context.Context, executionID string, argv []string, env map[string]string) (map[string]string, error)
	BindExecutionRuntime(ctx context.Context, executionID string, cfg RuntimeConfig) (RuntimeConfig, error)
	LaunchExecutionRuntime(ctx context.Context, executionID string, cfg RuntimeConfig) (RuntimeHandle, error)
	ResolveExecutionDiffBase(ctx context.Context, executionID, workspacePath, defaultBranch string) (sha, ref string)
	CommitExecution(ctx context.Context, executionID string) error
	RollbackExecution(ctx context.Context, executionID string, opts RollbackOptions) RollbackOutcome

	ValidateExecutionHost(ctx context.Context) error
	ReadExecutionProjectFile(ctx context.Context, projectPath, rel string) ([]byte, error)
	DiscardExecutionSystemPrompt(ctx context.Context, id domain.SessionID) error
	ImportExecutionAttachments(ctx context.Context, id domain.SessionID, workspacePath string) error
	RestoreExecutionAttachments(ctx context.Context, id domain.SessionID, workspacePath string) (bool, error)
	RemoveExecutionAttachments(ctx context.Context, id domain.SessionID) error
	RemoveExecutionAgentState(ctx context.Context, spec RemoteAgentPrepareSpec) error
	BindExistingRuntime(ctx context.Context, cfg RuntimeConfig) (RuntimeConfig, error)
	ResolveExistingDiffBase(ctx context.Context, workspacePath, defaultBranch string) (sha, ref string)
}

// RemoteAgentPrepareSpec is the wire-safe form of AgentPrepareSpec.
type RemoteAgentPrepareSpec struct {
	Harness   domain.AgentHarness
	SessionID domain.SessionID
	Hooks     WorkspaceHookConfig
	PreLaunch LaunchConfig
}
