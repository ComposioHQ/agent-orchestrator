package remote

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Execution adapts a compute-plane client to the placement-neutral session
// execution port. It never reads or writes a host path.
type Execution struct {
	backend ports.RemoteSessionExecutionBackend
}

var _ ports.SessionExecution = (*Execution)(nil)

func New(backend ports.RemoteSessionExecutionBackend) *Execution {
	return &Execution{backend: backend}
}

func (e *Execution) Workspace() ports.Workspace      { return e.backend.WorkspaceBackend() }
func (e *Execution) Runtime() ports.Runtime          { return e.backend.RuntimeBackend() }
func (e *Execution) Messenger() ports.AgentMessenger { return e.backend.MessengerBackend() }
func (e *Execution) Observation() ports.WorkspaceObservation {
	return e.backend.ObservationBackend()
}

func (e *Execution) BeginSession(ctx context.Context, spec ports.ExecutionSpec) (ports.SessionProvision, error) {
	id, err := e.backend.BeginExecution(ctx, spec)
	if err != nil {
		return nil, err
	}
	if id == "" {
		return nil, errors.New("remote session execution: empty execution id")
	}
	return &provision{Execution: e, id: id}, nil
}

func (e *Execution) ValidateHostPrerequisites(ctx context.Context) error {
	return e.backend.ValidateExecutionHost(ctx)
}

func (e *Execution) ReadProjectFile(ctx context.Context, projectPath, rel string) ([]byte, error) {
	return e.backend.ReadExecutionProjectFile(ctx, projectPath, rel)
}

func (e *Execution) StageSystemPrompt(context.Context, domain.SessionID, string) (string, error) {
	return "", errors.New("remote session execution: system prompt staging requires a provisioning transaction")
}

func (e *Execution) DiscardSystemPrompt(ctx context.Context, id domain.SessionID) {
	_ = e.backend.DiscardExecutionSystemPrompt(ctx, id)
}

func (e *Execution) StageAttachments(context.Context, domain.SessionID, string, []ports.SpawnAttachment) ([]string, error) {
	return nil, errors.New("remote session execution: attachment staging requires a provisioning transaction")
}

func (e *Execution) PutAttachment(ctx context.Context, id domain.SessionID, workspacePath, name string, data []byte) error {
	return e.backend.PutExecutionAttachment(ctx, id, workspacePath, name, data)
}

func (e *Execution) ImportAttachments(ctx context.Context, id domain.SessionID, workspacePath string) error {
	return e.backend.ImportExecutionAttachments(ctx, id, workspacePath)
}

func (e *Execution) RestoreAttachments(ctx context.Context, id domain.SessionID, workspacePath string) (bool, error) {
	return e.backend.RestoreExecutionAttachments(ctx, id, workspacePath)
}

func (e *Execution) RemoveAttachments(ctx context.Context, id domain.SessionID) error {
	return e.backend.RemoveExecutionAttachments(ctx, id)
}

func (e *Execution) Provision(context.Context, ports.WorkspaceProvisionSpec) error {
	return errors.New("remote session execution: workspace provisioning requires a provisioning transaction")
}

func (e *Execution) InstallAgentHooks(context.Context, ports.AgentPrepareSpec) error {
	return errors.New("remote session execution: agent installation requires a provisioning transaction")
}

func (e *Execution) RemoveAgentState(ctx context.Context, spec ports.AgentPrepareSpec) error {
	return e.backend.RemoveExecutionAgentState(ctx, remoteAgentSpec(spec))
}

func (e *Execution) ResolveLaunchBinary(ctx context.Context, argv []string, env map[string]string) (map[string]string, error) {
	// Existing sessions (restore/switch) resolve inside their already-materialized
	// sandbox. New sessions use the transaction override below.
	return e.backend.ResolveExecutionBinary(ctx, "", argv, env)
}

func (e *Execution) BindRuntimeConfig(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeConfig, error) {
	return e.backend.BindExistingRuntime(ctx, cfg)
}

func (e *Execution) ResolveDiffBase(ctx context.Context, workspacePath, defaultBranch string) (string, string) {
	return e.backend.ResolveExistingDiffBase(ctx, workspacePath, defaultBranch)
}

type step uint8

const (
	stepBegun step = iota
	stepPrompt
	stepWorkspace
	stepProvisioned
	stepAttachments
	stepHooks
	stepBinary
	stepBound
	stepLaunched
	stepDiffBase
	stepCommitted
	stepRolledBack
)

type provision struct {
	*Execution
	id string

	mu   sync.Mutex
	step step
	done bool
}

var _ ports.SessionProvision = (*provision)(nil)

func (p *provision) transition(wantMin, next step) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.done {
		return errors.New("remote session execution: provisioning transaction is closed")
	}
	if p.step < wantMin || p.step >= next {
		return fmt.Errorf("remote session execution: invalid provisioning order at step %d before %d", p.step, next)
	}
	p.step = next
	return nil
}

func (p *provision) StageSystemPrompt(ctx context.Context, id domain.SessionID, prompt string) (string, error) {
	if err := p.transition(stepBegun, stepPrompt); err != nil {
		return "", err
	}
	return p.backend.StageExecutionSystemPrompt(ctx, p.id, id, prompt)
}

func (p *provision) CreateWorkspace(ctx context.Context, spec ports.WorkspaceCreateSpec) (ports.WorkspaceInfo, *ports.WorkspaceProjectInfo, error) {
	if err := p.transition(stepPrompt, stepWorkspace); err != nil {
		return ports.WorkspaceInfo{}, nil, err
	}
	return p.backend.CreateExecutionWorkspace(ctx, p.id, spec)
}

func (p *provision) Provision(ctx context.Context, spec ports.WorkspaceProvisionSpec) error {
	if err := p.transition(stepWorkspace, stepProvisioned); err != nil {
		return err
	}
	return p.backend.ProvisionExecutionWorkspace(ctx, p.id, spec)
}

func (p *provision) StageAttachments(ctx context.Context, id domain.SessionID, workspacePath string, attachments []ports.SpawnAttachment) ([]string, error) {
	if err := p.transition(stepProvisioned, stepAttachments); err != nil {
		return nil, err
	}
	return p.backend.StageExecutionAttachments(ctx, p.id, id, workspacePath, attachments)
}

func (p *provision) InstallAgentHooks(ctx context.Context, spec ports.AgentPrepareSpec) error {
	if err := p.transition(stepProvisioned, stepHooks); err != nil {
		return err
	}
	return p.backend.InstallExecutionAgent(ctx, p.id, remoteAgentSpec(spec))
}

func (p *provision) ResolveLaunchBinary(ctx context.Context, argv []string, env map[string]string) (map[string]string, error) {
	if err := p.transition(stepHooks, stepBinary); err != nil {
		return env, err
	}
	return p.backend.ResolveExecutionBinary(ctx, p.id, argv, env)
}

func (p *provision) BindRuntimeConfig(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeConfig, error) {
	if err := p.transition(stepBinary, stepBound); err != nil {
		return ports.RuntimeConfig{}, err
	}
	return p.backend.BindExecutionRuntime(ctx, p.id, cfg)
}

func (p *provision) LaunchRuntime(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	if err := p.transition(stepBound, stepLaunched); err != nil {
		return ports.RuntimeHandle{}, err
	}
	return p.backend.LaunchExecutionRuntime(ctx, p.id, cfg)
}

func (p *provision) ResolveDiffBase(ctx context.Context, workspacePath, defaultBranch string) (string, string) {
	if err := p.transition(stepLaunched, stepDiffBase); err != nil {
		return "", ""
	}
	return p.backend.ResolveExecutionDiffBase(ctx, p.id, workspacePath, defaultBranch)
}

func (p *provision) Commit(ctx context.Context) error {
	p.mu.Lock()
	if p.done {
		p.mu.Unlock()
		return errors.New("remote session execution: provisioning transaction is closed")
	}
	if p.step < stepProvisioned {
		p.mu.Unlock()
		return errors.New("remote session execution: cannot commit before workspace provisioning")
	}
	p.mu.Unlock()
	if err := p.backend.CommitExecution(ctx, p.id); err != nil {
		return err
	}
	p.mu.Lock()
	p.step, p.done = stepCommitted, true
	p.mu.Unlock()
	return nil
}

func (p *provision) Rollback(ctx context.Context, opts ports.RollbackOptions) ports.RollbackOutcome {
	p.mu.Lock()
	if p.done {
		outcome := ports.RollbackOutcome{WorkspaceDestroyed: p.step == stepRolledBack}
		p.mu.Unlock()
		return outcome
	}
	p.mu.Unlock()
	outcome := p.backend.RollbackExecution(ctx, p.id, opts)
	if outcome.WorkspaceDestroyed {
		p.mu.Lock()
		p.step, p.done = stepRolledBack, true
		p.mu.Unlock()
	}
	return outcome
}

func remoteAgentSpec(spec ports.AgentPrepareSpec) ports.RemoteAgentPrepareSpec {
	return ports.RemoteAgentPrepareSpec{
		Harness: spec.Harness, SessionID: spec.SessionID,
		Hooks: spec.Hooks, PreLaunch: spec.PreLaunch,
	}
}
