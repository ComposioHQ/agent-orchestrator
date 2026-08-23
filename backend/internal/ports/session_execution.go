package ports

import (
	"context"
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

var ErrWorkspaceProjectUnsupported = errors.New("workspace project materialization is not supported by workspace adapter")

// SessionExecution is the single placement seam for session lifecycle and
// content. The workspace paths it returns are opaque outside the selected
// environment and must never be opened by the control plane.
type SessionExecution interface {
	Workspace() Workspace
	Runtime() Runtime
	Messenger() AgentMessenger
	Observation() WorkspaceObservation
	BeginSession(ctx context.Context, spec ExecutionSpec) (SessionProvision, error)
	StageSystemPrompt(ctx context.Context, id domain.SessionID, prompt string) (string, error)
	DiscardSystemPrompt(ctx context.Context, id domain.SessionID) error
	InstallAgent(ctx context.Context, spec RemoteAgentPrepareSpec) error
	ResolveLaunch(ctx context.Context, argv []string, env map[string]string) (map[string]string, error)
	BindRuntime(ctx context.Context, cfg RuntimeConfig) (RuntimeConfig, error)
	ReadProjectFile(ctx context.Context, projectPath, rel string) ([]byte, error)
	ImportAttachments(ctx context.Context, id domain.SessionID, workspacePath string) error
	RestoreAttachments(ctx context.Context, id domain.SessionID, workspacePath string) (bool, error)
	RemoveAttachments(ctx context.Context, id domain.SessionID) error
}

// SessionProvision is the atomic new-session boundary. Calls are ordered as
// prompt, workspace, provisioning, attachments, agent setup, runtime launch,
// then Commit. Rollback is idempotent and owns every prior side effect.
type SessionProvision interface {
	StageSystemPrompt(ctx context.Context, id domain.SessionID, prompt string) (string, error)
	CreateWorkspace(ctx context.Context, spec WorkspaceCreateSpec) (WorkspaceInfo, *WorkspaceProjectInfo, error)
	ProvisionWorkspace(ctx context.Context, spec WorkspaceProvisionSpec) error
	StageAttachments(ctx context.Context, id domain.SessionID, workspacePath string, attachments []SpawnAttachment) ([]string, error)
	InstallAgent(ctx context.Context, spec RemoteAgentPrepareSpec) error
	ResolveLaunch(ctx context.Context, argv []string, env map[string]string) (map[string]string, error)
	BindRuntime(ctx context.Context, cfg RuntimeConfig) (RuntimeConfig, error)
	LaunchRuntime(ctx context.Context, cfg RuntimeConfig) (RuntimeHandle, error)
	ResolveDiffBase(ctx context.Context, workspacePath, defaultBranch string) (sha, ref string)
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) ExecutionRollback
}

type ExecutionSpec struct {
	SessionID domain.SessionID
	ProjectID domain.ProjectID
	Kind      domain.SessionKind
	Harness   domain.AgentHarness
	Branch    string
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

type RemoteAgentPrepareSpec struct {
	Harness   domain.AgentHarness
	SessionID domain.SessionID
	Hooks     WorkspaceHookConfig
	PreLaunch LaunchConfig
}

type ExecutionRollback struct {
	WorkspaceDestroyed bool
}

// RemoteSessionExecutionClient is the wire-safe compute contract implemented
// by the runtime HTTP client. No method accepts an in-process Agent.
type RemoteSessionExecutionClient interface {
	WorkspaceClient() Workspace
	RuntimeClient() Runtime
	MessengerClient() AgentMessenger
	ObservationClient() WorkspaceObservationClient
	BeginExecution(ctx context.Context, spec ExecutionSpec) (string, error)
	StageExecutionSystemPrompt(ctx context.Context, executionID string, id domain.SessionID, prompt string) (string, error)
	CreateExecutionWorkspace(ctx context.Context, executionID string, spec WorkspaceCreateSpec) (WorkspaceInfo, *WorkspaceProjectInfo, error)
	ProvisionExecutionWorkspace(ctx context.Context, executionID string, spec WorkspaceProvisionSpec) error
	StageExecutionAttachments(ctx context.Context, executionID string, id domain.SessionID, workspacePath string, attachments []SpawnAttachment) ([]string, error)
	InstallExecutionAgent(ctx context.Context, executionID string, spec RemoteAgentPrepareSpec) error
	ResolveExecutionLaunch(ctx context.Context, executionID string, argv []string, env map[string]string) (map[string]string, error)
	BindExecutionRuntime(ctx context.Context, executionID string, cfg RuntimeConfig) (RuntimeConfig, error)
	LaunchExecutionRuntime(ctx context.Context, executionID string, cfg RuntimeConfig) (RuntimeHandle, error)
	ResolveExecutionDiffBase(ctx context.Context, executionID, workspacePath, defaultBranch string) (string, string)
	CommitExecution(ctx context.Context, executionID string) error
	RollbackExecution(ctx context.Context, executionID string) ExecutionRollback
	StageExistingSystemPrompt(ctx context.Context, id domain.SessionID, prompt string) (string, error)
	DiscardExistingSystemPrompt(ctx context.Context, id domain.SessionID) error
	InstallExistingAgent(ctx context.Context, spec RemoteAgentPrepareSpec) error
	ResolveExistingLaunch(ctx context.Context, argv []string, env map[string]string) (map[string]string, error)
	BindExistingRuntime(ctx context.Context, cfg RuntimeConfig) (RuntimeConfig, error)
	ReadExecutionProjectFile(ctx context.Context, projectPath, rel string) ([]byte, error)
	ImportExecutionAttachments(ctx context.Context, id domain.SessionID, workspacePath string) error
	RestoreExecutionAttachments(ctx context.Context, id domain.SessionID, workspacePath string) (bool, error)
	RemoveExecutionAttachments(ctx context.Context, id domain.SessionID) error
}
