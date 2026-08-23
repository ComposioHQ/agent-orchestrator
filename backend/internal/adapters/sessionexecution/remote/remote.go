package remote

import (
	"context"
	"errors"
	"fmt"
	"sync"

	observationremote "github.com/aoagents/agent-orchestrator/backend/internal/adapters/workspaceobservation/remote"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type Execution struct {
	client      ports.RemoteSessionExecutionClient
	observation ports.WorkspaceObservation
}

var _ ports.SessionExecution = (*Execution)(nil)

func New(client ports.RemoteSessionExecutionClient) *Execution {
	return &Execution{client: client, observation: observationremote.New(client.ObservationClient())}
}

func (e *Execution) Workspace() ports.Workspace              { return e.client.WorkspaceClient() }
func (e *Execution) Runtime() ports.Runtime                  { return e.client.RuntimeClient() }
func (e *Execution) Messenger() ports.AgentMessenger         { return e.client.MessengerClient() }
func (e *Execution) Observation() ports.WorkspaceObservation { return e.observation }
func (e *Execution) StageSystemPrompt(ctx context.Context, id domain.SessionID, prompt string) (string, error) {
	return e.client.StageExistingSystemPrompt(ctx, id, prompt)
}
func (e *Execution) DiscardSystemPrompt(ctx context.Context, id domain.SessionID) error {
	return e.client.DiscardExistingSystemPrompt(ctx, id)
}
func (e *Execution) InstallAgent(ctx context.Context, spec ports.RemoteAgentPrepareSpec) error {
	return e.client.InstallExistingAgent(ctx, spec)
}
func (e *Execution) ResolveLaunch(ctx context.Context, argv []string, env map[string]string) (map[string]string, error) {
	return e.client.ResolveExistingLaunch(ctx, argv, env)
}
func (e *Execution) BindRuntime(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeConfig, error) {
	return e.client.BindExistingRuntime(ctx, cfg)
}
func (e *Execution) ReadProjectFile(ctx context.Context, projectPath, rel string) ([]byte, error) {
	return e.client.ReadExecutionProjectFile(ctx, projectPath, rel)
}
func (e *Execution) ImportAttachments(ctx context.Context, id domain.SessionID, path string) error {
	return e.client.ImportExecutionAttachments(ctx, id, path)
}
func (e *Execution) RestoreAttachments(ctx context.Context, id domain.SessionID, path string) (bool, error) {
	return e.client.RestoreExecutionAttachments(ctx, id, path)
}
func (e *Execution) RemoveAttachments(ctx context.Context, id domain.SessionID) error {
	return e.client.RemoveExecutionAttachments(ctx, id)
}

func (e *Execution) BeginSession(ctx context.Context, spec ports.ExecutionSpec) (ports.SessionProvision, error) {
	id, err := e.client.BeginExecution(ctx, spec)
	if err != nil {
		return nil, err
	}
	if id == "" {
		return nil, errors.New("remote session execution: empty execution id")
	}
	return &provision{client: e.client, id: id}, nil
}

type step uint8

const (
	stepBegun step = iota
	stepPrompt
	stepWorkspace
	stepProvisioned
	stepAttachments
	stepAgent
	stepResolved
	stepBound
	stepLaunched
	stepDiff
	stepCommitted
	stepRolledBack
)

type provision struct {
	client ports.RemoteSessionExecutionClient
	id     string
	mu     sync.Mutex
	step   step
	closed bool
}

func (p *provision) advance(min, next step) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return errors.New("remote session execution: transaction closed")
	}
	if p.step < min || p.step >= next {
		return fmt.Errorf("remote session execution: invalid order at step %d before %d", p.step, next)
	}
	p.step = next
	return nil
}

func (p *provision) StageSystemPrompt(ctx context.Context, id domain.SessionID, prompt string) (string, error) {
	if err := p.advance(stepBegun, stepPrompt); err != nil {
		return "", err
	}
	return p.client.StageExecutionSystemPrompt(ctx, p.id, id, prompt)
}
func (p *provision) CreateWorkspace(ctx context.Context, spec ports.WorkspaceCreateSpec) (ports.WorkspaceInfo, *ports.WorkspaceProjectInfo, error) {
	if err := p.advance(stepPrompt, stepWorkspace); err != nil {
		return ports.WorkspaceInfo{}, nil, err
	}
	return p.client.CreateExecutionWorkspace(ctx, p.id, spec)
}
func (p *provision) ProvisionWorkspace(ctx context.Context, spec ports.WorkspaceProvisionSpec) error {
	if err := p.advance(stepWorkspace, stepProvisioned); err != nil {
		return err
	}
	return p.client.ProvisionExecutionWorkspace(ctx, p.id, spec)
}
func (p *provision) StageAttachments(ctx context.Context, id domain.SessionID, path string, attachments []ports.SpawnAttachment) ([]string, error) {
	if err := p.advance(stepProvisioned, stepAttachments); err != nil {
		return nil, err
	}
	return p.client.StageExecutionAttachments(ctx, p.id, id, path, attachments)
}
func (p *provision) InstallAgent(ctx context.Context, spec ports.RemoteAgentPrepareSpec) error {
	if err := p.advance(stepProvisioned, stepAgent); err != nil {
		return err
	}
	return p.client.InstallExecutionAgent(ctx, p.id, spec)
}
func (p *provision) ResolveLaunch(ctx context.Context, argv []string, env map[string]string) (map[string]string, error) {
	if err := p.advance(stepAgent, stepResolved); err != nil {
		return env, err
	}
	return p.client.ResolveExecutionLaunch(ctx, p.id, argv, env)
}
func (p *provision) BindRuntime(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeConfig, error) {
	if err := p.advance(stepResolved, stepBound); err != nil {
		return ports.RuntimeConfig{}, err
	}
	return p.client.BindExecutionRuntime(ctx, p.id, cfg)
}
func (p *provision) LaunchRuntime(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	if err := p.advance(stepBound, stepLaunched); err != nil {
		return ports.RuntimeHandle{}, err
	}
	return p.client.LaunchExecutionRuntime(ctx, p.id, cfg)
}
func (p *provision) ResolveDiffBase(ctx context.Context, path, branch string) (string, string) {
	if err := p.advance(stepLaunched, stepDiff); err != nil {
		return "", ""
	}
	return p.client.ResolveExecutionDiffBase(ctx, p.id, path, branch)
}
func (p *provision) Commit(ctx context.Context) error {
	p.mu.Lock()
	if p.closed || p.step < stepLaunched {
		p.mu.Unlock()
		return errors.New("remote session execution: cannot commit incomplete transaction")
	}
	p.mu.Unlock()
	if err := p.client.CommitExecution(ctx, p.id); err != nil {
		return err
	}
	p.mu.Lock()
	p.step, p.closed = stepCommitted, true
	p.mu.Unlock()
	return nil
}
func (p *provision) Rollback(ctx context.Context) ports.ExecutionRollback {
	p.mu.Lock()
	if p.closed {
		out := ports.ExecutionRollback{WorkspaceDestroyed: p.step == stepRolledBack}
		p.mu.Unlock()
		return out
	}
	p.closed, p.step = true, stepRolledBack
	p.mu.Unlock()
	return p.client.RollbackExecution(ctx, p.id)
}
