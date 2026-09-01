package reconcile

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/domain"
	"github.com/aoagents/agent-orchestrator/cloud/internal/sandbox"
)

type lifecycleStore struct {
	acceptedPause bool
	acceptCalls   int
	observations  []string
}

func (s *lifecycleStore) ClaimSandboxes(context.Context, string, int, time.Duration) ([]domain.Sandbox, error) {
	return nil, nil
}
func (s *lifecycleStore) RenewSandboxClaim(context.Context, string, string, string, time.Duration) error {
	return nil
}
func (s *lifecycleStore) UpdateSandboxObservation(_ context.Context, _, _, _, _, state, _ string, _ time.Time) error {
	s.observations = append(s.observations, state)
	return nil
}
func (s *lifecycleStore) AcceptSandboxProviderPause(context.Context, string, string, string, string, time.Time) (bool, error) {
	s.acceptCalls++
	return s.acceptedPause, nil
}
func (s *lifecycleStore) RecordSandboxFailure(context.Context, string, string, string, string, string) error {
	return nil
}
func (s *lifecycleStore) ReleaseSandboxClaim(context.Context, string, string, string, time.Time) error {
	return nil
}
func (s *lifecycleStore) IssueAccessTicket(context.Context, string, string, string, []string, time.Duration) (string, error) {
	return "ticket", nil
}
func (s *lifecycleStore) AppendSessionEvent(context.Context, string, string, string, json.RawMessage) (domain.ClientEvent, error) {
	return domain.ClientEvent{}, nil
}
func (s *lifecycleStore) MarkSandboxDeletionRequested(context.Context, string, string, string) error {
	return nil
}
func (s *lifecycleStore) CompleteSandboxDeletion(context.Context, string, string, string) error {
	return nil
}
func (s *lifecycleStore) DisconnectSessionWorkers(context.Context, string, string) error {
	return nil
}

type lifecycleProvider struct {
	environment sandbox.Environment
	starts      int
	extensions  []time.Time
}

func (p *lifecycleProvider) Create(context.Context, sandbox.Spec) (sandbox.Environment, error) {
	return p.environment, nil
}
func (p *lifecycleProvider) Get(context.Context, sandbox.ID) (sandbox.Environment, error) {
	return p.environment, nil
}
func (p *lifecycleProvider) FindBySession(context.Context, string) (sandbox.Environment, bool, error) {
	return p.environment, true, nil
}
func (p *lifecycleProvider) Start(context.Context, sandbox.ID) error {
	p.starts++
	return nil
}
func (p *lifecycleProvider) Stop(context.Context, sandbox.ID) error   { return nil }
func (p *lifecycleProvider) Pause(context.Context, sandbox.ID) error  { return nil }
func (p *lifecycleProvider) Resume(context.Context, sandbox.ID) error { return nil }
func (p *lifecycleProvider) Delete(context.Context, sandbox.ID) error { return nil }
func (p *lifecycleProvider) ExtendDeadline(_ context.Context, _ sandbox.ID, deadline time.Time) error {
	p.extensions = append(p.extensions, deadline)
	return nil
}

type lifecycleResolver struct{ provider sandbox.Provider }

func (r lifecycleResolver) Resolve(context.Context, domain.Sandbox) (sandbox.Provider, error) {
	return r.provider, nil
}

func testReconciler(store Store, provider sandbox.Provider) *Reconciler {
	return New(store, lifecycleResolver{provider: provider}, Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
}

func runningRecord(keepAlive bool) domain.Sandbox {
	now := time.Now()
	return domain.Sandbox{
		SessionID: "session-1", OrgID: "org-1", Provider: "coder",
		ProviderEnvironmentID: "workspace-1",
		DesiredState:          domain.SandboxDesiredRunning,
		ObservedState:         domain.SandboxObservedRunning,
		WorkerLastSeenAt:      &now,
		KeepAlive:             keepAlive,
		UpdatedAt:             now,
	}
}

func TestCoderAutostopBecomesPausedWithoutRestart(t *testing.T) {
	store := &lifecycleStore{acceptedPause: true}
	provider := &lifecycleProvider{environment: sandbox.Environment{
		ID: "workspace-1", State: sandbox.StateStopped, StopCause: sandbox.StopCauseExternalIdle,
	}}
	if err := testReconciler(store, provider).reconcileSandbox(context.Background(), runningRecord(false)); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if store.acceptCalls != 1 || provider.starts != 0 {
		t.Fatalf("accept calls = %d, starts = %d; want 1, 0", store.acceptCalls, provider.starts)
	}
}

func TestActiveWorkRestoresStoppedCoderWorkspace(t *testing.T) {
	store := &lifecycleStore{acceptedPause: true}
	provider := &lifecycleProvider{environment: sandbox.Environment{
		ID: "workspace-1", State: sandbox.StateStopped, StopCause: sandbox.StopCauseExternalIdle,
	}}
	if err := testReconciler(store, provider).reconcileSandbox(context.Background(), runningRecord(true)); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if store.acceptCalls != 0 || provider.starts != 1 {
		t.Fatalf("accept calls = %d, starts = %d; want 0, 1", store.acceptCalls, provider.starts)
	}
	if len(store.observations) != 1 || store.observations[0] != domain.SandboxObservedRestoring {
		t.Fatalf("observations = %v, want restoring", store.observations)
	}
}

func TestAmbiguousProviderStopPreservesExistingRestoreBehavior(t *testing.T) {
	store := &lifecycleStore{acceptedPause: true}
	provider := &lifecycleProvider{environment: sandbox.Environment{
		ID: "workspace-1", State: sandbox.StateStopped,
	}}
	if err := testReconciler(store, provider).reconcileSandbox(context.Background(), runningRecord(false)); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if store.acceptCalls != 0 || provider.starts != 1 {
		t.Fatalf("accept calls = %d, starts = %d; want 0, 1", store.acceptCalls, provider.starts)
	}
}

func TestActiveWorkExtendsNearCoderDeadline(t *testing.T) {
	deadline := time.Now().Add(time.Minute)
	store := &lifecycleStore{}
	provider := &lifecycleProvider{environment: sandbox.Environment{
		ID: "workspace-1", State: sandbox.StateRunning, Deadline: &deadline,
	}}
	started := time.Now()
	if err := testReconciler(store, provider).reconcileSandbox(context.Background(), runningRecord(true)); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(provider.extensions) != 1 {
		t.Fatalf("extensions = %v, want one", provider.extensions)
	}
	if provider.extensions[0].Before(started.Add(activeDeadlineExtension - time.Second)) {
		t.Fatalf("extended deadline = %s, want about %s from now", provider.extensions[0], activeDeadlineExtension)
	}
}

func TestIdleWorkDoesNotExtendCoderDeadline(t *testing.T) {
	deadline := time.Now().Add(time.Minute)
	store := &lifecycleStore{}
	provider := &lifecycleProvider{environment: sandbox.Environment{
		ID: "workspace-1", State: sandbox.StateRunning, Deadline: &deadline,
	}}
	if err := testReconciler(store, provider).reconcileSandbox(context.Background(), runningRecord(false)); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(provider.extensions) != 0 {
		t.Fatalf("extensions = %v, want none", provider.extensions)
	}
}
