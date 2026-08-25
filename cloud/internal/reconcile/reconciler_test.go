package reconcile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/domain"
	"github.com/aoagents/agent-orchestrator/cloud/internal/sandbox"
)

// fakeProvider records every lifecycle call so a test can assert on what the
// reconciler decided, not on how it got there.
type fakeProvider struct {
	mu sync.Mutex

	environments map[sandbox.ID]sandbox.Environment
	findResult   *sandbox.Environment
	getErr       error
	createErr    error
	resumeErr    error

	created   []sandbox.Spec
	recreated []sandbox.ID
	deleted   []sandbox.ID
	started   []sandbox.ID
	stopped   []sandbox.ID
	resumed   []sandbox.ID
	nextID    int
}

func newFakeProvider() *fakeProvider {
	return &fakeProvider{environments: map[sandbox.ID]sandbox.Environment{}}
}

func (p *fakeProvider) setState(id sandbox.ID, state string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.environments[id] = sandbox.Environment{ID: id, State: state}
}

func (p *fakeProvider) Create(_ context.Context, spec sandbox.Spec) (sandbox.Environment, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.createErr != nil {
		return sandbox.Environment{}, p.createErr
	}
	p.nextID++
	id := sandbox.ID("env-" + string(rune('0'+p.nextID)))
	p.created = append(p.created, spec)
	environment := sandbox.Environment{ID: id, Name: spec.Name, State: sandbox.StateProvisioning}
	p.environments[id] = environment
	return environment, nil
}

func (p *fakeProvider) Get(_ context.Context, id sandbox.ID) (sandbox.Environment, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.getErr != nil {
		return sandbox.Environment{}, p.getErr
	}
	environment, ok := p.environments[id]
	if !ok {
		return sandbox.Environment{}, sandbox.ErrNotFound
	}
	return environment, nil
}

func (p *fakeProvider) FindBySession(_ context.Context, _ string) (sandbox.Environment, bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.findResult == nil {
		return sandbox.Environment{}, false, nil
	}
	return *p.findResult, true, nil
}

func (p *fakeProvider) Start(_ context.Context, id sandbox.ID) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.started = append(p.started, id)
	return nil
}

func (p *fakeProvider) Stop(_ context.Context, id sandbox.ID) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.stopped = append(p.stopped, id)
	return nil
}

func (p *fakeProvider) Pause(ctx context.Context, id sandbox.ID) error { return p.Stop(ctx, id) }

func (p *fakeProvider) Resume(_ context.Context, id sandbox.ID) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.resumed = append(p.resumed, id)
	return p.resumeErr
}

func (p *fakeProvider) Delete(_ context.Context, id sandbox.ID) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.deleted = append(p.deleted, id)
	delete(p.environments, id)
	return nil
}

// recreatingProvider adds Recreate; the bare fakeProvider deliberately does not
// implement it, so tests can exercise the Start/Resume fallbacks.
type recreatingProvider struct{ *fakeProvider }

func (p *recreatingProvider) Recreate(
	_ context.Context,
	id sandbox.ID,
	spec sandbox.Spec,
) (sandbox.Environment, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.recreated = append(p.recreated, id)
	p.created = append(p.created, spec)
	delete(p.environments, id)
	environment := sandbox.Environment{ID: "env-recreated", Name: spec.Name, State: sandbox.StateProvisioning}
	p.environments[environment.ID] = environment
	return environment, nil
}

type bootstrappingProvider struct {
	*fakeProvider
	bootstraps []sandbox.WorkerBootstrap
}

func (p *bootstrappingProvider) BootstrapWorker(
	_ context.Context,
	_ sandbox.ID,
	bootstrap sandbox.WorkerBootstrap,
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.bootstraps = append(p.bootstraps, bootstrap)
	return nil
}

type recreatingBootstrapProvider struct {
	*recreatingProvider
	bootstraps []sandbox.WorkerBootstrap
}

func (p *recreatingBootstrapProvider) BootstrapWorker(
	_ context.Context,
	_ sandbox.ID,
	bootstrap sandbox.WorkerBootstrap,
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.bootstraps = append(p.bootstraps, bootstrap)
	return nil
}

type slowProvider struct {
	*fakeProvider
	delay time.Duration
}

func (p *slowProvider) Create(
	ctx context.Context,
	spec sandbox.Spec,
) (sandbox.Environment, error) {
	select {
	case <-ctx.Done():
		return sandbox.Environment{}, ctx.Err()
	case <-time.After(p.delay):
		return p.fakeProvider.Create(ctx, spec)
	}
}

// blockingCreateProvider lets concurrency tests observe exactly how many
// provider operations enter Create before the test releases them.
type blockingCreateProvider struct {
	*fakeProvider
	started chan string
	release <-chan struct{}
}

func (p *blockingCreateProvider) Create(
	ctx context.Context,
	spec sandbox.Spec,
) (sandbox.Environment, error) {
	select {
	case p.started <- spec.SessionID:
	case <-ctx.Done():
		return sandbox.Environment{}, ctx.Err()
	}
	select {
	case <-p.release:
		return p.fakeProvider.Create(ctx, spec)
	case <-ctx.Done():
		return sandbox.Environment{}, ctx.Err()
	}
}

type observation struct {
	providerID string
	state      string
	lastError  string
}

type fakeStore struct {
	mu sync.Mutex

	pending      []domain.Sandbox
	observations []observation
	tickets      []string
	ticketScopes [][]string
	events       []string
	completed    []string
	disconnected []string
	renewals     int
	renewErr     error
	ticketErr    error
}

func (s *fakeStore) ClaimSandboxes(_ context.Context, _ string, _ int, _ time.Duration) ([]domain.Sandbox, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	claimed := s.pending
	s.pending = nil
	return claimed, nil
}

func (s *fakeStore) RenewSandboxClaim(
	_ context.Context,
	_, _, _ string,
	_ time.Duration,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.renewals++
	return s.renewErr
}

func (s *fakeStore) UpdateSandboxObservation(
	_ context.Context,
	_, _, _, providerEnvironmentID, observedState, lastError string,
	_ time.Time,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.observations = append(s.observations, observation{providerEnvironmentID, observedState, lastError})
	return nil
}

func (s *fakeStore) RecordSandboxFailure(
	_ context.Context,
	_, _, _ string,
	providerEnvironmentID, lastError string,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.observations = append(
		s.observations, observation{providerEnvironmentID, domain.SandboxObservedFailed, lastError},
	)
	return nil
}

func (s *fakeStore) ReleaseSandboxClaim(_ context.Context, _, _, _ string, _ time.Time) error {
	return nil
}

func (s *fakeStore) IssueAccessTicket(
	_ context.Context,
	_, _, purpose string,
	scopes []string,
	_ time.Duration,
) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ticketErr != nil {
		return "", s.ticketErr
	}
	token := "ticket-" + purpose + "-" + string(rune('a'+len(s.tickets)))
	s.tickets = append(s.tickets, token)
	s.ticketScopes = append(s.ticketScopes, append([]string(nil), scopes...))
	return token, nil
}

func (s *fakeStore) AppendSessionEvent(
	_ context.Context,
	_, _, eventType string,
	_ json.RawMessage,
) (domain.ClientEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, eventType)
	return domain.ClientEvent{}, nil
}

func (s *fakeStore) CompleteSandboxDeletion(_ context.Context, _, _, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.completed = append(s.completed, sessionID)
	return nil
}

func (s *fakeStore) DisconnectSessionWorkers(_ context.Context, _, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.disconnected = append(s.disconnected, sessionID)
	return nil
}

func (s *fakeStore) lastObservation(t *testing.T) observation {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.observations) == 0 {
		t.Fatal("no observation was recorded")
	}
	return s.observations[len(s.observations)-1]
}

type staticResolver struct {
	provider sandbox.Provider
	err      error
}

func (r staticResolver) Resolve(context.Context, domain.Sandbox) (sandbox.Provider, error) {
	return r.provider, r.err
}

func newReconciler(store Store, provider sandbox.Provider) *Reconciler {
	return New(store, staticResolver{provider: provider}, Options{
		PublicURL:        "https://cloud.example/",
		StartupTimeout:   30 * time.Second,
		HeartbeatTimeout: time.Minute,
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
}

func runningSandbox() domain.Sandbox {
	return domain.Sandbox{
		SessionID:     "session-1",
		OrgID:         "org-1",
		Provider:      sandbox.ProviderNodeOps,
		DesiredState:  domain.SandboxDesiredRunning,
		ObservedState: domain.SandboxObservedRequested,
		UpdatedAt:     time.Now(),
	}
}

func TestProvisionCreatesEnvironmentAndTicket(t *testing.T) {
	store := &fakeStore{pending: []domain.Sandbox{runningSandbox()}}
	provider := newFakeProvider()
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.created) != 1 {
		t.Fatalf("Create called %d times, want 1", len(provider.created))
	}
	spec := provider.created[0]
	if spec.Labels["ao.session_id"] != "session-1" {
		t.Errorf("spec label ao.session_id = %q, want session-1", spec.Labels["ao.session_id"])
	}
	if spec.Environment["AO_WORKER_BOOTSTRAP_TOKEN"] == "" {
		t.Error("spec is missing a bootstrap token")
	}
	if got := spec.Environment["AO_CLOUD_PUBLIC_URL"]; got != "https://cloud.example" {
		t.Errorf("AO_CLOUD_PUBLIC_URL = %q, want the trailing slash trimmed", got)
	}
	if len(store.events) != 1 || store.events[0] != "sandbox.provisioning" {
		t.Errorf("events = %v, want [sandbox.provisioning]", store.events)
	}
	if got := store.lastObservation(t); got.state != domain.SandboxObservedProvisioning {
		t.Errorf("observed state = %q, want provisioning", got.state)
	}
}

func TestProvisionAdoptsExistingEnvironment(t *testing.T) {
	store := &fakeStore{pending: []domain.Sandbox{runningSandbox()}}
	provider := newFakeProvider()
	provider.findResult = &sandbox.Environment{ID: "env-orphan", State: sandbox.StateProvisioning}
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.created) != 0 {
		t.Fatalf("Create called %d times, want 0 — the orphan should be adopted", len(provider.created))
	}
	if got := store.lastObservation(t); got.providerID != "env-orphan" {
		t.Errorf("provider id = %q, want env-orphan", got.providerID)
	}
}

func TestCreateFailureRecordsFailedWithoutLosingTheSession(t *testing.T) {
	store := &fakeStore{pending: []domain.Sandbox{runningSandbox()}}
	provider := newFakeProvider()
	provider.createErr = errors.New("nodeops 503")
	reconciler := newReconciler(store, provider)

	_ = reconciler.ReconcileOnce(context.Background())

	got := store.lastObservation(t)
	if got.state != domain.SandboxObservedFailed {
		t.Errorf("observed state = %q, want failed", got.state)
	}
	if got.lastError == "" {
		t.Error("last_error is empty, want the provider error recorded")
	}
	if len(store.completed) != 0 {
		t.Error("session was deleted on a provider error; a failed call must never destroy intent")
	}
}

func TestProbeFailureDoesNotChangeObservedReality(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedRunning
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := newFakeProvider()
	provider.getErr = errors.New("nodeops api unreachable")
	reconciler := newReconciler(store, provider)

	_ = reconciler.ReconcileOnce(context.Background())

	got := store.lastObservation(t)
	if got.providerID != "env-1" {
		t.Errorf("provider id = %q, want env-1 retained through the outage", got.providerID)
	}
	if len(provider.deleted) != 0 || len(provider.recreated) != 0 {
		t.Error("an unreachable API triggered destructive repair")
	}
}

func TestNotFoundReprovisions(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-gone"
	record.ObservedState = domain.SandboxObservedRunning
	store := &fakeStore{pending: []domain.Sandbox{record}}
	reconciler := newReconciler(store, newFakeProvider())

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	got := store.lastObservation(t)
	if got.providerID != "" {
		t.Errorf("provider id = %q, want cleared", got.providerID)
	}
	if got.state != domain.SandboxObservedRequested {
		t.Errorf("observed state = %q, want requested", got.state)
	}
}

func TestStartupTimeoutRecreates(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedBootstrapping
	record.UpdatedAt = time.Now().Add(-31 * time.Second)
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := &recreatingProvider{newFakeProvider()}
	provider.setState("env-1", sandbox.StateRunning)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.recreated) != 1 {
		t.Fatalf("Recreate called %d times, want 1", len(provider.recreated))
	}
	if len(store.tickets) != 1 {
		t.Errorf("issued %d tickets, want 1 fresh ticket for the replacement", len(store.tickets))
	}
}

func TestRecreateInstallsWorkerWithFreshBootstrapTicket(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedStopped
	store := &fakeStore{
		pending: []domain.Sandbox{record},
		tickets: []string{"consumed-ticket"},
	}
	provider := &recreatingBootstrapProvider{
		recreatingProvider: &recreatingProvider{newFakeProvider()},
	}
	provider.resumeErr = errors.New("resume failed")
	provider.setState("env-1", sandbox.StatePaused)
	reconciler := newReconciler(store, provider)
	reconciler.options.WorkerBinary = []byte("worker")

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
	if len(provider.bootstraps) != 1 {
		t.Fatalf("BootstrapWorker called %d times after Recreate, want 1", len(provider.bootstraps))
	}
	got := provider.bootstraps[0].Environment["AO_WORKER_BOOTSTRAP_TOKEN"]
	if got == "" || got == "consumed-ticket" {
		t.Fatalf("recreate launched with ticket %q, want a fresh ticket", got)
	}
	if got != provider.created[len(provider.created)-1].Environment["AO_WORKER_BOOTSTRAP_TOKEN"] {
		t.Fatal("recreate and worker launch received different bootstrap tickets")
	}
}

func TestStartupTimeoutNotReachedLeavesSandboxAlone(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedBootstrapping
	record.UpdatedAt = time.Now().Add(-5 * time.Second)
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := &recreatingProvider{newFakeProvider()}
	provider.setState("env-1", sandbox.StateRunning)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.recreated) != 0 {
		t.Fatal("a sandbox still inside its startup budget was recreated")
	}
}

func TestWorkerThatNeverChecksInIsTerminatedAtTheCeiling(t *testing.T) {
	startedAt := time.Now().Add(-11 * time.Minute)
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedBootstrapping
	record.StartupStartedAt = &startedAt
	record.WorkerLastSeenAt = nil
	store := &fakeStore{pending: []domain.Sandbox{record}}
	// A recreating provider proves termination short-circuits repair: without
	// the ceiling this sandbox would be recreated on every tick forever.
	provider := &recreatingProvider{newFakeProvider()}
	provider.setState("env-1", sandbox.StateRunning)
	reconciler := newReconciler(store, provider)
	reconciler.options.WorkerBinary = []byte("worker")

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.recreated) != 0 {
		t.Fatalf("a terminated sandbox was recreated %d times", len(provider.recreated))
	}
	if got := provider.stopped; len(got) != 1 || got[0] != "env-1" {
		t.Fatalf("stopped = %v, want [env-1] to halt billing", got)
	}
	if len(store.disconnected) != 1 || store.disconnected[0] != "session-1" {
		t.Fatalf("disconnected = %v, want [session-1]", store.disconnected)
	}
	last := store.lastObservation(t)
	if last.state != domain.SandboxObservedTerminated {
		t.Fatalf("observed state = %q, want %q", last.state, domain.SandboxObservedTerminated)
	}
	if last.lastError == "" {
		t.Fatal("terminated sandbox recorded no explanatory error")
	}
}

func TestTerminatedSandboxIsParkedAndNeverResumed(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedTerminated
	record.LastError = "worker never started"
	store := &fakeStore{pending: []domain.Sandbox{record}}
	// A paused environment would normally be resumed; a parked terminated
	// sandbox must not probe or wake its compute.
	provider := &recreatingProvider{newFakeProvider()}
	provider.setState("env-1", sandbox.StatePaused)
	reconciler := newReconciler(store, provider)
	reconciler.options.WorkerBinary = []byte("worker")

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.resumed) != 0 || len(provider.started) != 0 || len(provider.recreated) != 0 {
		t.Fatalf("terminated sandbox was revived: resumed=%v started=%v recreated=%v",
			provider.resumed, provider.started, provider.recreated)
	}
	last := store.lastObservation(t)
	if last.state != domain.SandboxObservedTerminated {
		t.Fatalf("observed state = %q, want it to stay %q", last.state, domain.SandboxObservedTerminated)
	}
	if last.lastError != "worker never started" {
		t.Fatalf("parked observation dropped the failure cause: %q", last.lastError)
	}
}

func TestTerminatedSandboxStillHonoursDeletion(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedTerminated
	record.DesiredState = domain.SandboxDesiredDeleted
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := newFakeProvider()
	provider.setState("env-1", sandbox.StateRunning)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.deleted) != 1 || provider.deleted[0] != "env-1" {
		t.Fatalf("deleted = %v, want a terminated sandbox to still be removed on delete", provider.deleted)
	}
}

func TestWorkerNeverCheckedInButWithinCeilingIsRepaired(t *testing.T) {
	startedAt := time.Now().Add(-31 * time.Second)
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedBootstrapping
	record.StartupStartedAt = &startedAt
	record.WorkerLastSeenAt = nil
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := &recreatingProvider{newFakeProvider()}
	provider.setState("env-1", sandbox.StateRunning)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.recreated) != 1 {
		t.Fatalf("Recreate called %d times, want 1: past the startup deadline but well inside the terminal ceiling", len(provider.recreated))
	}
	if len(provider.stopped) != 0 {
		t.Fatal("a repairable sandbox was stopped as if terminated")
	}
}

func TestHeartbeatGapRecreates(t *testing.T) {
	seen := time.Now().Add(-2 * time.Minute)
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedRunning
	record.WorkerLastSeenAt = &seen
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := &recreatingProvider{newFakeProvider()}
	provider.setState("env-1", sandbox.StateRunning)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.recreated) != 1 {
		t.Fatalf("Recreate called %d times, want 1", len(provider.recreated))
	}
}

func TestHeartbeatRepairLaunchReceivesFreshBootstrapTicket(t *testing.T) {
	seen := time.Now().Add(-2 * time.Minute)
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedRunning
	record.WorkerLastSeenAt = &seen
	store := &fakeStore{
		pending: []domain.Sandbox{record},
		tickets: []string{"consumed-ticket"},
	}
	provider := &bootstrappingProvider{fakeProvider: newFakeProvider()}
	provider.setState("env-1", sandbox.StateRunning)
	reconciler := newReconciler(store, provider)
	reconciler.options.WorkerBinary = []byte("worker")

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
	if len(provider.bootstraps) != 1 {
		t.Fatalf("BootstrapWorker called %d times, want 1", len(provider.bootstraps))
	}
	got := provider.bootstraps[0].Environment["AO_WORKER_BOOTSTRAP_TOKEN"]
	if got == "" || got == "consumed-ticket" {
		t.Fatalf("repair bootstrap ticket = %q, want a freshly issued ticket", got)
	}
	if got != store.tickets[len(store.tickets)-1] {
		t.Fatalf("repair launched with %q, issued ticket was %q", got, store.tickets[len(store.tickets)-1])
	}
}

func TestSlowProviderCallRenewsItsLease(t *testing.T) {
	store := &fakeStore{pending: []domain.Sandbox{runningSandbox()}}
	provider := &slowProvider{fakeProvider: newFakeProvider(), delay: 60 * time.Millisecond}
	reconciler := newReconciler(store, provider)
	reconciler.lease = 15 * time.Millisecond

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
	if store.renewals < 2 {
		t.Fatalf("lease renewed %d times during slow Create, want at least 2", store.renewals)
	}
	if len(provider.created) != 1 {
		t.Fatalf("Create called %d times, want 1", len(provider.created))
	}
}

func TestReconcileOnceCapsConcurrentProviderOperations(t *testing.T) {
	release := make(chan struct{})
	provider := &blockingCreateProvider{
		fakeProvider: newFakeProvider(),
		started:      make(chan string, 8),
		release:      release,
	}
	records := make([]domain.Sandbox, 8)
	for index := range records {
		records[index] = runningSandbox()
		records[index].SessionID = fmt.Sprintf("session-%d", index)
		records[index].OrgID = fmt.Sprintf("org-%d", index)
	}
	store := &fakeStore{pending: records}
	reconciler := newReconciler(store, provider)
	reconciler.options.MaxConcurrentOperations = 4
	reconciler.options.MaxConcurrentOperationsPerProvider = 4
	reconciler.options.MaxConcurrentOperationsPerOrganization = 4

	done := make(chan error, 1)
	go func() { done <- reconciler.ReconcileOnce(context.Background()) }()
	for index := 0; index < 4; index++ {
		select {
		case <-provider.started:
		case <-time.After(time.Second):
			t.Fatalf("provider operation %d did not start", index+1)
		}
	}
	select {
	case sessionID := <-provider.started:
		t.Fatalf("started %q before one of the first four provider calls completed", sessionID)
	case <-time.After(75 * time.Millisecond):
	}

	close(release)
	if err := <-done; err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
	if len(provider.created) != len(records) {
		t.Fatalf("Create called %d times, want %d", len(provider.created), len(records))
	}
}

func TestReconcileOnceCapsConcurrentOperationsPerOrganization(t *testing.T) {
	release := make(chan struct{})
	provider := &blockingCreateProvider{
		fakeProvider: newFakeProvider(),
		started:      make(chan string, 4),
		release:      release,
	}
	records := make([]domain.Sandbox, 4)
	for index := range records {
		records[index] = runningSandbox()
		records[index].SessionID = fmt.Sprintf("session-%d", index)
	}
	store := &fakeStore{pending: records}
	reconciler := newReconciler(store, provider)
	reconciler.options.MaxConcurrentOperations = 4
	reconciler.options.MaxConcurrentOperationsPerProvider = 4
	reconciler.options.MaxConcurrentOperationsPerOrganization = 2

	done := make(chan error, 1)
	go func() { done <- reconciler.ReconcileOnce(context.Background()) }()
	for index := 0; index < 2; index++ {
		select {
		case <-provider.started:
		case <-time.After(time.Second):
			t.Fatalf("provider operation %d did not start", index+1)
		}
	}
	select {
	case sessionID := <-provider.started:
		t.Fatalf("started %q before an organization slot opened", sessionID)
	case <-time.After(75 * time.Millisecond):
	}

	close(release)
	if err := <-done; err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
}

func TestLeaseLossCancelsSlowProviderCall(t *testing.T) {
	store := &fakeStore{
		pending:  []domain.Sandbox{runningSandbox()},
		renewErr: errors.New("lease was claimed by another replica"),
	}
	provider := &slowProvider{fakeProvider: newFakeProvider(), delay: time.Second}
	reconciler := newReconciler(store, provider)
	reconciler.lease = 15 * time.Millisecond

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
	if len(provider.created) != 0 {
		t.Fatalf("Create completed after lease loss; calls = %d", len(provider.created))
	}
}

func TestFreshHeartbeatStaysRunning(t *testing.T) {
	seen := time.Now()
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedRunning
	record.WorkerLastSeenAt = &seen
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := &recreatingProvider{newFakeProvider()}
	provider.setState("env-1", sandbox.StateRunning)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.recreated) != 0 {
		t.Fatal("a healthy sandbox was recreated")
	}
	if got := store.lastObservation(t); got.state != domain.SandboxObservedRunning {
		t.Errorf("observed state = %q, want running", got.state)
	}
}

func TestUnknownProviderStateNeverBecomesRunning(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedProvisioning
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := newFakeProvider()
	provider.setState("env-1", "some-future-nodeops-state")
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if got := store.lastObservation(t); got.state != domain.SandboxObservedProvisioning {
		t.Errorf("observed state = %q, want provisioning for an unrecognized provider state", got.state)
	}
}

func TestStuckProviderProvisioningFailsWithoutReplacingTheSandbox(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedProvisioning
	startedAt := time.Now().Add(-time.Minute)
	record.StartupStartedAt = &startedAt
	// A provider flap refreshes UpdatedAt. The deadline must still use the
	// original wake rather than granting another full startup window.
	record.UpdatedAt = time.Now()
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := &recreatingProvider{newFakeProvider()}
	provider.setState("env-1", sandbox.StateProvisioning)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
	if len(provider.recreated) != 0 {
		t.Fatalf("Recreate called %d times, want 0 so a stuck provider transition preserves the sandbox", len(provider.recreated))
	}
	got := store.lastObservation(t)
	if got.state != domain.SandboxObservedFailed {
		t.Fatalf("observed state = %q, want failed so the retry backs off", got.state)
	}
	if !strings.Contains(got.lastError, "AO kept the existing VM and will retry") {
		t.Fatalf("failure = %q, want provider provisioning timeout", got.lastError)
	}
}

func TestDesiredPausedStopsSandbox(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.DesiredState = domain.SandboxDesiredPaused
	record.ObservedState = domain.SandboxObservedRunning
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := newFakeProvider()
	provider.setState("env-1", sandbox.StateRunning)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.stopped) != 1 {
		t.Fatalf("Stop called %d times, want 1", len(provider.stopped))
	}
	if got := store.lastObservation(t); got.state != domain.SandboxObservedStopped {
		t.Errorf("observed state = %q, want stopped", got.state)
	}
}

func TestDesiredDeletedWaitsForProviderAbsenceBeforeTermination(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.DesiredState = domain.SandboxDesiredDeleted
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := newFakeProvider()
	provider.setState("env-1", sandbox.StateRunning)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.deleted) != 1 {
		t.Fatalf("Delete called %d times, want 1", len(provider.deleted))
	}
	if len(store.completed) != 0 {
		t.Fatalf("deletion completed immediately after provider acceptance: %v", store.completed)
	}
	if got := store.lastObservation(t); got.state != domain.SandboxObservedDeleting {
		t.Fatalf("observed state = %q, want deleting", got.state)
	}

	// A later reconcile observes that the provider no longer has the sandbox.
	record.ObservedState = domain.SandboxObservedDeleting
	store.pending = []domain.Sandbox{record}
	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("second ReconcileOnce() error = %v", err)
	}
	if len(store.completed) != 1 || store.completed[0] != "session-1" {
		t.Errorf("completed sessions = %v, want [session-1]", store.completed)
	}
}

func TestDesiredDeletedWithoutEnvironmentTerminatesSession(t *testing.T) {
	record := runningSandbox()
	record.DesiredState = domain.SandboxDesiredDeleted
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := newFakeProvider()
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.deleted) != 0 {
		t.Error("Delete was called for a sandbox that never had an environment")
	}
	if len(store.completed) != 1 {
		t.Errorf("completed sessions = %v, want the session terminated", store.completed)
	}
}

func TestDesiredDeletedFindsAndRemovesOrphanedProviderEnvironment(t *testing.T) {
	record := runningSandbox()
	record.DesiredState = domain.SandboxDesiredDeleted
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := newFakeProvider()
	orphan := sandbox.Environment{ID: "env-orphan", State: sandbox.StateRunning}
	provider.findResult = &orphan
	provider.setState(orphan.ID, orphan.State)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
	if len(provider.deleted) != 1 || provider.deleted[0] != orphan.ID {
		t.Fatalf("deleted provider environments = %v, want orphan %q", provider.deleted, orphan.ID)
	}
	if len(store.completed) != 0 {
		t.Fatal("orphan deletion was treated as complete before provider absence was observed")
	}
	if got := store.lastObservation(t); got.providerID != string(orphan.ID) ||
		got.state != domain.SandboxObservedDeleting {
		t.Fatalf("orphan observation = %+v, want durable deleting state", got)
	}
}

func TestStoppedSandboxStartsWhenProviderCannotRecreate(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedStopped
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := newFakeProvider()
	provider.setState("env-1", sandbox.StateStopped)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.started) != 1 {
		t.Fatalf("Start called %d times, want 1", len(provider.started))
	}
}

func TestStoppedDockerWorkerIsRecreatedWithFreshBootstrapTicket(t *testing.T) {
	record := runningSandbox()
	record.Provider = sandbox.ProviderDocker
	record.ProviderEnvironmentID = "container-1"
	record.ObservedState = domain.SandboxObservedStopped
	record.UpdatedAt = time.Now().Add(-time.Minute)
	seenAt := time.Now().Add(-time.Minute)
	record.WorkerLastSeenAt = &seenAt
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := &recreatingProvider{newFakeProvider()}
	provider.setState("container-1", sandbox.StateStopped)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
	if len(provider.recreated) != 1 {
		t.Fatalf("Recreate called %d times, want 1", len(provider.recreated))
	}
	if len(provider.started) != 0 || len(provider.resumed) != 0 {
		t.Fatalf(
			"spent-ticket container was restored: started=%v resumed=%v",
			provider.started, provider.resumed,
		)
	}
	if len(store.tickets) != 1 {
		t.Fatalf("issued %d tickets, want one fresh ticket", len(store.tickets))
	}
}

func TestIntentionallyPausedDockerWorkerRecreatesImmediatelyOnWake(t *testing.T) {
	record := runningSandbox()
	record.Provider = sandbox.ProviderDocker
	record.ProviderEnvironmentID = "container-1"
	record.ObservedState = domain.SandboxObservedStopped
	record.UpdatedAt = time.Now()
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := &recreatingProvider{newFakeProvider()}
	provider.setState("container-1", sandbox.StateStopped)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
	if len(provider.recreated) != 1 {
		t.Fatalf("Recreate called %d times, want one immediate replacement after intentional pause", len(provider.recreated))
	}
	if got := store.lastObservation(t); got.state == domain.SandboxObservedFailed {
		t.Fatalf("intentional pause was treated as a boot failure: %+v", got)
	}
}

func TestDockerWorkerThatNeverBecomesReadyBacksOffInsteadOfLoopingForever(t *testing.T) {
	record := runningSandbox()
	record.Provider = sandbox.ProviderDocker
	record.ProviderEnvironmentID = "container-1"
	record.ObservedState = domain.SandboxObservedStopped
	record.LastError = "load coding-agent credential: /worker/credential returned 404"
	seenAt := time.Now()
	record.WorkerLastSeenAt = &seenAt
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := &recreatingProvider{newFakeProvider()}
	provider.setState("container-1", sandbox.StateStopped)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
	if len(provider.recreated) != 0 {
		t.Fatalf("Recreate called %d times, want 0 — a never-ready worker must back off, not loop", len(provider.recreated))
	}
	got := store.lastObservation(t)
	if got.state != domain.SandboxObservedFailed {
		t.Fatalf("observed state = %q, want failed so the exponential backoff applies", got.state)
	}
	if len(store.disconnected) != 1 || store.disconnected[0] != record.SessionID {
		t.Fatalf(
			"disconnected sessions = %v, want [%s] so the UI stops claiming a connection that no longer exists",
			store.disconnected, record.SessionID,
		)
	}
}

func TestPausedSandboxResumesInsteadOfBeingReplaced(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedRunning
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := &recreatingProvider{newFakeProvider()}
	provider.setState("env-1", sandbox.StatePaused)
	reconciler := newReconciler(store, provider)

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}

	if len(provider.resumed) != 1 {
		t.Fatalf("Resume called %d times, want 1", len(provider.resumed))
	}
	if len(provider.recreated) != 0 {
		t.Error("a paused sandbox was replaced instead of resumed, discarding its workspace")
	}
	if got := store.lastObservation(t); got.state != domain.SandboxObservedRestoring {
		t.Errorf("observed state = %q, want restoring so a resumed worker is refreshed", got.state)
	}
}

func TestRestoredNodeOpsSandboxRefreshesWorkerInPlace(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedRestoring
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := &bootstrappingProvider{fakeProvider: newFakeProvider()}
	provider.setState("env-1", sandbox.StateRunning)
	reconciler := newReconciler(store, provider)
	reconciler.options.WorkerBinary = []byte("ao-worker")

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
	if len(provider.bootstraps) != 1 {
		t.Fatalf("BootstrapWorker called %d times, want 1 after an in-place restore", len(provider.bootstraps))
	}
	if len(provider.recreated) != 0 || len(provider.created) != 0 {
		t.Fatalf("restored sandbox was replaced: recreated=%v created=%v", provider.recreated, provider.created)
	}
	if len(store.tickets) != 1 {
		t.Fatalf("issued %d bootstrap tickets, want 1", len(store.tickets))
	}
	if got := store.lastObservation(t); got.state != domain.SandboxObservedBootstrapping {
		t.Errorf("observed state = %q, want bootstrapping after worker refresh", got.state)
	}
}

func TestBootstrappingSandboxDoesNotRepeatRestoreRefresh(t *testing.T) {
	record := runningSandbox()
	record.ProviderEnvironmentID = "env-1"
	record.ObservedState = domain.SandboxObservedBootstrapping
	store := &fakeStore{pending: []domain.Sandbox{record}}
	provider := &bootstrappingProvider{fakeProvider: newFakeProvider()}
	provider.setState("env-1", sandbox.StateRunning)
	reconciler := newReconciler(store, provider)
	reconciler.options.WorkerBinary = []byte("ao-worker")

	if err := reconciler.ReconcileOnce(context.Background()); err != nil {
		t.Fatalf("ReconcileOnce() error = %v", err)
	}
	if len(provider.bootstraps) != 0 {
		t.Fatalf("BootstrapWorker called %d times, want no duplicate restore refresh", len(provider.bootstraps))
	}
}

func TestWorkerSpecReadsShapeFromTheStoredProfile(t *testing.T) {
	record := runningSandbox()
	record.ResourceProfile = json.RawMessage(
		`{"nodeOps":{"defaultShape":"s-4vcpu-8gb","defaultRootFs":"devbox:1","ingress":"none"}}`,
	)
	store := &fakeStore{}
	reconciler := newReconciler(store, newFakeProvider())

	spec, err := reconciler.workerSpec(context.Background(), record)
	if err != nil {
		t.Fatalf("workerSpec() error = %v", err)
	}
	if spec.Shape != "s-4vcpu-8gb" || spec.RootFS != "devbox:1" {
		t.Errorf("spec shape/rootfs = %q/%q, want the values stored on the row", spec.Shape, spec.RootFS)
	}
	gotScopes := make(map[string]bool)
	for _, scope := range store.ticketScopes[0] {
		gotScopes[scope] = true
	}
	for _, required := range []string{
		"worker:connect",
		"worker:event",
		"worker:turn:claim",
		"worker:turn:poll",
		"worker:turn:complete",
		"worker:credential:read",
		"worker:git",
		"worker:orchestrate",
		"worker:transport",
	} {
		if !gotScopes[required] {
			t.Errorf("worker bootstrap ticket lacks %q", required)
		}
	}
}

func TestCreateAtCapacityRetriesInsteadOfFailing(t *testing.T) {
	store := &fakeStore{pending: []domain.Sandbox{runningSandbox()}}
	provider := newFakeProvider()
	provider.createErr = fmt.Errorf("%w: concurrent quota reached", sandbox.ErrAtCapacity)
	reconciler := newReconciler(store, provider)

	_ = reconciler.ReconcileOnce(context.Background())

	got := store.lastObservation(t)
	if got.state == domain.SandboxObservedFailed {
		t.Fatal("a capacity rejection failed the session; it must stay provisioning and retry")
	}
	if got.state != domain.SandboxObservedProvisioning {
		t.Errorf("observed state = %q, want provisioning (queued for capacity)", got.state)
	}
}
