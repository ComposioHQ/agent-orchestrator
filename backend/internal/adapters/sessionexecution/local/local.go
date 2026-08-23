package local

import (
	"context"
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Config binds the existing local adapters and placement-sensitive helpers.
// The callbacks preserve established local behavior rather than duplicating it.
type Config struct {
	Workspace           ports.Workspace
	Runtime             ports.Runtime
	Messenger           ports.AgentMessenger
	Observation         ports.WorkspaceObservation
	StageSystemPrompt   func(context.Context, domain.SessionID, string) (string, error)
	DiscardSystemPrompt func(context.Context, domain.SessionID) error
	ProvisionWorkspace  func(context.Context, ports.WorkspaceProvisionSpec) error
	StageAttachments    func(context.Context, domain.SessionID, string, []ports.SpawnAttachment) ([]string, error)
	InstallAgent        func(context.Context, ports.RemoteAgentPrepareSpec) error
	ResolveLaunch       func(context.Context, []string, map[string]string) (map[string]string, error)
	BindRuntime         func(context.Context, ports.RuntimeConfig) (ports.RuntimeConfig, error)
	ResolveDiffBase     func(context.Context, string, string) (string, string)
	ReadProjectFile     func(context.Context, string, string) ([]byte, error)
	ImportAttachments   func(context.Context, domain.SessionID, string) error
	RestoreAttachments  func(context.Context, domain.SessionID, string) (bool, error)
	RemoveAttachments   func(context.Context, domain.SessionID) error
}

type execution struct{ cfg Config }

var _ ports.SessionExecution = (*execution)(nil)

// New constructs a provider-neutral session execution adapter.
func New(cfg Config) *execution                              { return &execution{cfg: cfg} }
func (e *execution) Workspace() ports.Workspace              { return e.cfg.Workspace }
func (e *execution) Runtime() ports.Runtime                  { return e.cfg.Runtime }
func (e *execution) Messenger() ports.AgentMessenger         { return e.cfg.Messenger }
func (e *execution) Observation() ports.WorkspaceObservation { return e.cfg.Observation }
func (e *execution) StageSystemPrompt(ctx context.Context, id domain.SessionID, prompt string) (string, error) {
	return e.cfg.StageSystemPrompt(ctx, id, prompt)
}
func (e *execution) DiscardSystemPrompt(ctx context.Context, id domain.SessionID) error {
	if e.cfg.DiscardSystemPrompt == nil {
		return nil
	}
	return e.cfg.DiscardSystemPrompt(ctx, id)
}
func (e *execution) InstallAgent(ctx context.Context, spec ports.RemoteAgentPrepareSpec) error {
	return e.cfg.InstallAgent(ctx, spec)
}
func (e *execution) ResolveLaunch(ctx context.Context, argv []string, env map[string]string) (map[string]string, error) {
	return e.cfg.ResolveLaunch(ctx, argv, env)
}
func (e *execution) BindRuntime(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeConfig, error) {
	if e.cfg.BindRuntime == nil {
		return cfg, nil
	}
	return e.cfg.BindRuntime(ctx, cfg)
}
func (e *execution) ReadProjectFile(ctx context.Context, projectPath, rel string) ([]byte, error) {
	return e.cfg.ReadProjectFile(ctx, projectPath, rel)
}
func (e *execution) ImportAttachments(ctx context.Context, id domain.SessionID, path string) error {
	return e.cfg.ImportAttachments(ctx, id, path)
}
func (e *execution) RestoreAttachments(ctx context.Context, id domain.SessionID, path string) (bool, error) {
	return e.cfg.RestoreAttachments(ctx, id, path)
}
func (e *execution) RemoveAttachments(ctx context.Context, id domain.SessionID) error {
	return e.cfg.RemoveAttachments(ctx, id)
}
func (e *execution) BeginSession(context.Context, ports.ExecutionSpec) (ports.SessionProvision, error) {
	return &provision{execution: e}, nil
}

type provision struct {
	execution *execution
	workspace ports.WorkspaceInfo
	project   *ports.WorkspaceProjectInfo
	runtime   ports.RuntimeHandle
	closed    bool
}

func (p *provision) StageSystemPrompt(ctx context.Context, id domain.SessionID, prompt string) (string, error) {
	return p.execution.cfg.StageSystemPrompt(ctx, id, prompt)
}
func (p *provision) CreateWorkspace(ctx context.Context, spec ports.WorkspaceCreateSpec) (ports.WorkspaceInfo, *ports.WorkspaceProjectInfo, error) {
	if spec.Project != nil {
		adapter, ok := p.execution.cfg.Workspace.(ports.WorkspaceProject)
		if !ok {
			return ports.WorkspaceInfo{}, nil, ports.ErrWorkspaceProjectUnsupported
		}
		info, err := adapter.CreateWorkspaceProject(ctx, *spec.Project)
		if err == nil {
			p.workspace, p.project = info.Root, &info
		}
		return info.Root, &info, err
	}
	ws, err := p.execution.cfg.Workspace.Create(ctx, spec.Workspace)
	if err == nil {
		p.workspace = ws
	}
	return ws, nil, err
}
func (p *provision) ProvisionWorkspace(ctx context.Context, spec ports.WorkspaceProvisionSpec) error {
	return p.execution.cfg.ProvisionWorkspace(ctx, spec)
}
func (p *provision) StageAttachments(ctx context.Context, id domain.SessionID, path string, values []ports.SpawnAttachment) ([]string, error) {
	return p.execution.cfg.StageAttachments(ctx, id, path, values)
}
func (p *provision) InstallAgent(ctx context.Context, spec ports.RemoteAgentPrepareSpec) error {
	return p.execution.cfg.InstallAgent(ctx, spec)
}
func (p *provision) ResolveLaunch(ctx context.Context, argv []string, env map[string]string) (map[string]string, error) {
	return p.execution.cfg.ResolveLaunch(ctx, argv, env)
}
func (p *provision) BindRuntime(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeConfig, error) {
	if p.execution.cfg.BindRuntime == nil {
		return cfg, nil
	}
	return p.execution.cfg.BindRuntime(ctx, cfg)
}
func (p *provision) LaunchRuntime(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	h, err := p.execution.cfg.Runtime.Create(ctx, cfg)
	if err == nil {
		p.runtime = h
	}
	return h, err
}
func (p *provision) ResolveDiffBase(ctx context.Context, path, branch string) (string, string) {
	return p.execution.cfg.ResolveDiffBase(ctx, path, branch)
}
func (p *provision) Commit(context.Context) error { p.closed = true; return nil }
func (p *provision) Rollback(ctx context.Context) ports.ExecutionRollback {
	if p.closed {
		return ports.ExecutionRollback{}
	}
	p.closed = true
	if p.runtime.ID != "" {
		_ = p.execution.cfg.Runtime.Destroy(ctx, p.runtime)
	}
	if p.project != nil {
		if adapter, ok := p.execution.cfg.Workspace.(ports.WorkspaceProject); ok {
			return ports.ExecutionRollback{WorkspaceDestroyed: adapter.DestroyWorkspaceProject(ctx, *p.project) == nil}
		}
		return ports.ExecutionRollback{}
	}
	if p.workspace.Path == "" {
		return ports.ExecutionRollback{WorkspaceDestroyed: true}
	}
	err := p.execution.cfg.Workspace.Destroy(ctx, p.workspace)
	return ports.ExecutionRollback{WorkspaceDestroyed: err == nil || errors.Is(err, ports.ErrWorkspaceStale)}
}
