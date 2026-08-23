package runtime_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime/runtimetest"
)

// harness wires a manager over the in-memory store, the provider fake, and a
// real capability authority, with a clock the test advances by assignment.
type harness struct {
	manager      *runtime.Manager
	store        *runtimetest.MemoryStore
	provider     *runtimetest.FakeProvider
	authority    *capability.Authority
	grants       *capability.MemoryStore
	secrets      *recordingSecrets
	routes       *recordingRoutes
	capabilities *recordingCapabilities
	events       *[]string
	now          time.Time
}

type recordingCapabilities struct {
	inner  *capability.Authority
	events *[]string
	fail   error
}

func (c *recordingCapabilities) IssueSandbox(ctx context.Context, scope capability.Scope) ([]byte, error) {
	*c.events = append(*c.events, "capability.issue")
	grant, err := c.inner.Issue(ctx, scope, time.Hour)
	if err != nil {
		return nil, err
	}
	return []byte(grant.Token), nil
}

func (c *recordingCapabilities) RevokeScope(ctx context.Context, selector capability.Selector) (int, error) {
	*c.events = append(*c.events, "capability.revoke")
	if c.fail != nil {
		err := c.fail
		c.fail = nil
		return 0, err
	}
	return c.inner.RevokeScope(ctx, selector)
}

type recordingSecrets struct {
	events *[]string
	files  []runtime.FileSecret
	fail   error
}

func (s *recordingSecrets) SandboxSecrets(context.Context, runtime.Ref) (runtime.Secrets, error) {
	*s.events = append(*s.events, "secrets.mint")
	return runtime.Secrets{Files: s.files}, nil
}

func (s *recordingSecrets) PurgeSandboxSecrets(context.Context, runtime.Ref) error {
	*s.events = append(*s.events, "secrets.purge")
	if s.fail != nil {
		err := s.fail
		s.fail = nil
		return err
	}
	return nil
}

type recordingRoutes struct {
	events *[]string
	fail   error
}

func (r *recordingRoutes) PublishRoute(context.Context, runtime.Ref, runtime.Sandbox) error {
	*r.events = append(*r.events, "routes.publish")
	return nil
}

func (r *recordingRoutes) ReleaseRoutes(context.Context, runtime.Ref) error {
	*r.events = append(*r.events, "routes.release")
	if r.fail != nil {
		err := r.fail
		r.fail = nil
		return err
	}
	return nil
}

func newHarness(t *testing.T, mutate ...func(*runtime.Options)) *harness {
	t.Helper()
	h := &harness{now: time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)}
	events := make([]string, 0, 16)
	h.events = &events
	h.store = runtimetest.NewMemoryStore()
	h.provider = runtimetest.NewFakeProvider()
	h.provider.Now = func() time.Time { return h.now }
	h.grants = capability.NewMemoryStore()
	authority, err := capability.New(h.grants, time.Hour, capability.WithClock(func() time.Time { return h.now }))
	if err != nil {
		t.Fatal(err)
	}
	h.authority = authority
	h.capabilities = &recordingCapabilities{inner: authority, events: h.events}
	h.secrets = &recordingSecrets{events: h.events}
	h.routes = &recordingRoutes{events: h.events}
	options := runtime.Options{
		Store:              h.store,
		Provider:           h.provider,
		Capabilities:       h.capabilities,
		Secrets:            h.secrets,
		Routes:             h.routes,
		Deployment:         "staging",
		PublicURL:          "https://cloud.example/",
		Snapshots:          map[runtime.Role]string{runtime.RoleCoordinator: "ao-coordinator", runtime.RoleWorker: "ao-worker"},
		AutoStopInterval:   30 * time.Minute,
		AutoDeleteInterval: 24 * time.Hour,
		Quotas:             runtime.DefaultQuotas(),
		Clock:              func() time.Time { return h.now },
	}
	for _, apply := range mutate {
		apply(&options)
	}
	manager, err := runtime.NewManager(options)
	if err != nil {
		t.Fatal(err)
	}
	h.manager = manager
	return h
}

func workerRef() runtime.Ref {
	return runtime.Ref{OrgID: "org-1", WorkspaceID: "ws-1", SessionID: "sess-1", UserID: "user-1", Role: runtime.RoleWorker}
}

func coordinatorRef() runtime.Ref {
	return runtime.Ref{OrgID: "org-1", WorkspaceID: "ws-1", SessionID: "coord-1", UserID: "user-1", Role: runtime.RoleCoordinator}
}

func testLaunch() runtime.LaunchSpec {
	return runtime.LaunchSpec{Command: "/bin/sh", Args: []string{"-l"}}
}

func TestEnsureCreatesOneSandboxAndIsIdempotent(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	first, err := h.manager.Ensure(ctx, workerRef(), testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	if !first.Created || first.Record.ProviderID == "" {
		t.Fatalf("first placement = %#v", first)
	}
	second, err := h.manager.Ensure(ctx, workerRef(), testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	if second.Created {
		t.Fatal("second Ensure reported a create")
	}
	if second.Record.ID != first.Record.ID || second.Record.ProviderID != first.Record.ProviderID {
		t.Fatalf("second placement drifted: %#v", second.Record)
	}
	if h.provider.Len() != 1 || h.store.Len() != 1 {
		t.Fatalf("sandboxes = %d rows = %d, want one of each", h.provider.Len(), h.store.Len())
	}
}

func TestEnsureLabelsSandboxForDiscoveryAndCleanup(t *testing.T) {
	h := newHarness(t)
	placement, err := h.manager.Ensure(context.Background(), workerRef(), testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	labels := h.provider.LastCreate.Labels
	attribution, ok := runtime.Attribute(labels)
	if !ok {
		t.Fatalf("labels are not attributable: %#v", labels)
	}
	if attribution.Deployment != "staging" || attribution.OrgID != "org-1" ||
		attribution.WorkspaceID != "ws-1" || attribution.SessionID != "sess-1" ||
		attribution.Role != runtime.RoleWorker || attribution.RuntimeID != placement.Record.ID {
		t.Fatalf("attribution = %#v", attribution)
	}
}

func TestEnsureInjectsSecretsThroughOwnerOnlyFiles(t *testing.T) {
	h := newHarness(t, func(options *runtime.Options) {
		options.Secrets = &recordingSecrets{
			events: options.Secrets.(*recordingSecrets).events,
			files: []runtime.FileSecret{{
				Path: "/home/agent/.ssh/id_ed25519", Content: []byte("synthetic-owner-only-key-material"), Mode: 0o600,
			}},
		}
	})
	_, err := h.manager.Ensure(context.Background(), workerRef(), testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	request := h.provider.LastCreate
	if request.Capability.Path != runtime.CapabilityFilePath || request.Capability.Mode != 0o600 ||
		request.ControlPlaneURL != "https://cloud.example" {
		t.Fatalf("capability file contract = %#v %q", request.Capability, request.ControlPlaneURL)
	}
	if len(request.SecretFiles) != 1 || request.SecretFiles[0].Path != "/home/agent/.ssh/id_ed25519" {
		t.Fatalf("secret files = %#v", request.SecretFiles)
	}
	if request.Command != testLaunch().Command || len(request.Args) == 0 {
		t.Fatalf("semantic launch = %q %#v", request.Command, request.Args)
	}
}

func TestEnsureIsolatesWorkerAndCoordinatorSandboxes(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	worker, err := h.manager.Ensure(ctx, workerRef(), testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	coordinator, err := h.manager.Ensure(ctx, coordinatorRef(), testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	if worker.Record.ProviderID == coordinator.Record.ProviderID {
		t.Fatal("coordinator and worker must not share a sandbox")
	}
	if h.provider.LastCreate.Snapshot != "ao-coordinator" {
		t.Fatalf("coordinator snapshot = %q", h.provider.LastCreate.Snapshot)
	}

}

func TestEnsureEnforcesQuotasWithAClearErrorContract(t *testing.T) {
	h := newHarness(t, func(options *runtime.Options) {
		options.Quotas = runtime.Quotas{
			MaxSandboxesPerOrg:          3,
			MaxSandboxesPerUser:         2,
			MaxWorkersPerWorkspace:      1,
			MaxCoordinatorsPerWorkspace: 1,
		}
	})
	ctx := context.Background()
	if _, err := h.manager.Ensure(ctx, workerRef(), testLaunch()); err != nil {
		t.Fatal(err)
	}

	second := workerRef()
	second.SessionID = "sess-2"
	_, secondErr := h.manager.Ensure(ctx, second, testLaunch())
	err := mustQuotaError(t, secondErr)
	if err.Scope != runtime.ScopeWorkspace || err.Resource != "workers" || err.Limit != 1 || err.InUse != 1 || err.Subject != "ws-1" {
		t.Fatalf("workspace quota error = %#v", err)
	}
	if !strings.Contains(err.Error(), "workspace workers limit 1 reached for ws-1") {
		t.Fatalf("quota message = %q", err.Error())
	}

	// A second workspace clears the per-workspace limit but hits the per-user
	// limit, proving the checks are independent.
	otherWorkspace := workerRef()
	otherWorkspace.WorkspaceID = "ws-2"
	otherWorkspace.SessionID = "sess-3"
	if _, err := h.manager.Ensure(ctx, otherWorkspace, testLaunch()); err != nil {
		t.Fatal(err)
	}
	third := workerRef()
	third.WorkspaceID = "ws-3"
	third.SessionID = "sess-4"
	_, thirdErr := h.manager.Ensure(ctx, third, testLaunch())
	userErr := mustQuotaError(t, thirdErr)
	if userErr.Scope != runtime.ScopeUser || userErr.Limit != 2 || userErr.Subject != "user-1" {
		t.Fatalf("user quota error = %#v", userErr)
	}
}

func TestEnsureReservesQuotaAtomicallyAcrossConcurrentCreates(t *testing.T) {
	h := newHarness(t, func(options *runtime.Options) {
		options.Quotas = runtime.Quotas{MaxWorkersPerWorkspace: 1}
	})
	ctx := context.Background()
	start := make(chan struct{})
	errs := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)

	for index := range 2 {
		ref := workerRef()
		ref.SessionID = fmt.Sprintf("concurrent-%d", index)
		go func() {
			ready.Done()
			<-start
			_, err := h.manager.Ensure(ctx, ref, testLaunch())
			errs <- err
		}()
	}
	ready.Wait()
	close(start)

	var successes, quotaFailures int
	for range 2 {
		err := <-errs
		switch {
		case err == nil:
			successes++
		case errors.Is(err, runtime.ErrQuotaExceeded):
			quotaFailures++
		default:
			t.Fatalf("concurrent Ensure error = %v", err)
		}
	}
	if successes != 1 || quotaFailures != 1 {
		t.Fatalf("successes = %d quota failures = %d, want 1 each", successes, quotaFailures)
	}
	if h.store.Len() != 1 || h.provider.Len() != 1 {
		t.Fatalf("rows = %d sandboxes = %d, want one of each", h.store.Len(), h.provider.Len())
	}
}

func TestEnsureQuotaIgnoresPlacementsBeingDeleted(t *testing.T) {
	h := newHarness(t, func(options *runtime.Options) {
		options.Quotas = runtime.Quotas{MaxWorkersPerWorkspace: 1}
	})
	ctx := context.Background()
	if _, err := h.manager.Ensure(ctx, workerRef(), testLaunch()); err != nil {
		t.Fatal(err)
	}
	record, err := h.store.Get(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	record.State = runtime.StateDeleting
	h.store.Put(record)

	replacement := workerRef()
	replacement.SessionID = "sess-2"
	if _, err := h.manager.Ensure(ctx, replacement, testLaunch()); err != nil {
		t.Fatalf("a session being torn down must not block its replacement: %v", err)
	}
}

func mustQuotaError(t *testing.T, err error) *runtime.QuotaError {
	t.Helper()
	if !errors.Is(err, runtime.ErrQuotaExceeded) {
		t.Fatalf("err = %v, want a quota error", err)
	}
	var quota *runtime.QuotaError
	if !errors.As(err, &quota) {
		t.Fatalf("err = %v, want *runtime.QuotaError", err)
	}
	return quota
}

func TestEnsureResumesAPlacementWhoseCreateNeverCompleted(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	h.provider.FailCreate = errors.New("provider timeout")

	if _, err := h.manager.Ensure(ctx, workerRef(), testLaunch()); !errors.Is(err, runtime.ErrProviderUnavailable) {
		t.Fatalf("err = %v, want runtime.ErrProviderUnavailable", err)
	}
	record, err := h.store.Get(ctx, workerRef())
	if err != nil {
		t.Fatalf("the placement row must survive a failed create so nothing leaks: %v", err)
	}
	if record.State != runtime.StateFailed || record.Error == "" {
		t.Fatalf("record = %#v", record)
	}

	placement, err := h.manager.Ensure(ctx, workerRef(), testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	if placement.Record.ID != record.ID {
		t.Fatal("resume must reuse the placement row so labels stay stable")
	}
	if placement.Record.State != runtime.StateRunning {
		t.Fatalf("resumed placement = %#v", placement.Record)
	}
}

func TestEnsureRetainsProviderHandleAndRetriesBootstrapAfterCreateFailure(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	h.provider.FailAfterCreate = errors.New("toolbox bootstrap failed")

	failed, err := h.manager.Ensure(ctx, workerRef(), testLaunch())
	if !errors.Is(err, runtime.ErrProviderUnavailable) {
		t.Fatalf("err = %v, want ErrProviderUnavailable", err)
	}
	if failed.Sandbox.ID == "" {
		t.Fatal("provider did not return the allocated sandbox handle")
	}
	record, err := h.store.Get(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	if record.ProviderID != failed.Sandbox.ID || record.State != runtime.StateFailed {
		t.Fatalf("failed placement = %#v, sandbox = %#v", record, failed.Sandbox)
	}
	if h.provider.Len() != 1 {
		t.Fatal("bootstrap failure deleted retained compute")
	}

	recovered, err := h.manager.Ensure(ctx, workerRef(), testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Record.ProviderID != record.ProviderID || recovered.Record.State != runtime.StateRunning {
		t.Fatalf("recovered placement = %#v", recovered.Record)
	}
	if h.provider.LastStart.BootstrapKey == "" {
		t.Fatal("failed running sandbox was accepted without fresh bootstrap")
	}
}

func TestEnsurePassesNonSecretEnvironmentAndCompleteStableLabels(t *testing.T) {
	h := newHarness(t)
	launch := testLaunch()
	launch.Env = map[string]string{"AO_AGENT_MODE": "cloud"}
	if _, err := h.manager.Ensure(context.Background(), workerRef(), launch); err != nil {
		t.Fatal(err)
	}
	if h.provider.LastCreate.Env["AO_AGENT_MODE"] != "cloud" {
		t.Fatalf("create env = %#v", h.provider.LastCreate.Env)
	}
	labels := h.provider.LastCreate.Labels
	for _, key := range []string{
		runtime.LabelEnvironment, runtime.LabelOrg, runtime.LabelWorkspace,
		runtime.LabelSession, runtime.LabelRole, runtime.LabelRuntimeID,
	} {
		if labels[key] == "" {
			t.Fatalf("missing stable provider label %s: %#v", key, labels)
		}
	}
}

func TestEnsureAdoptsSandboxWhoseCreateResponseWasLost(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	ref := workerRef()
	record, created, err := h.store.Ensure(ctx, ref, runtime.DefaultQuotas(), h.now)
	if err != nil || !created {
		t.Fatalf("ensure row = %#v, %v", record, err)
	}
	orphan := h.provider.Seed(runtime.Sandbox{
		State:     runtime.ProviderRunning,
		Labels:    runtime.Labels("staging", ref, record.ID),
		CreatedAt: h.now,
	})

	placement, err := h.manager.Ensure(ctx, ref, testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	if placement.Record.ProviderID != orphan.ID {
		t.Fatalf("placement = %#v", placement)
	}
	for _, call := range h.provider.Calls {
		if call == "create" {
			t.Fatal("lost create response caused duplicate provider creation")
		}
	}
}

func TestEnsureReprovisionsWhenTheSandboxVanished(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	first, err := h.manager.Ensure(ctx, workerRef(), testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	h.provider.Remove(first.Record.ProviderID)

	second, err := h.manager.Ensure(ctx, workerRef(), testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	if second.Record.ID != first.Record.ID {
		t.Fatal("re-provisioning must reuse the placement row")
	}
	if second.Record.ProviderID == first.Record.ProviderID {
		t.Fatal("a replacement sandbox must be a new provider sandbox")
	}
	attribution, ok := runtime.Attribute(h.provider.LastCreate.Labels)
	if !ok || attribution.RuntimeID != first.Record.ID {
		t.Fatalf("replacement labels = %#v", h.provider.LastCreate.Labels)
	}
}

func TestEnsureBootsAStoppedSandboxWithFreshCapabilityMetadata(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	first, err := h.manager.Ensure(ctx, workerRef(), testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	h.provider.SetState(first.Record.ProviderID, runtime.ProviderStopped)
	firstCapability := append([]byte(nil), h.provider.LastCreateCapability...)

	second, err := h.manager.Ensure(ctx, workerRef(), testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	if second.Record.State != runtime.StateRunning {
		t.Fatalf("state = %s, want running", second.Record.State)
	}
	if h.provider.LastStart.Command != testLaunch().Command || h.provider.LastStart.BootstrapKey == "" {
		t.Fatalf("restart request = %#v", h.provider.LastStart)
	}
	if h.provider.LastStart.Capability.Path != runtime.CapabilityFilePath ||
		h.provider.LastStart.ControlPlaneURL != "https://cloud.example" {
		t.Fatalf("restart capability contract = %#v", h.provider.LastStart)
	}
	if len(firstCapability) == 0 || len(h.provider.LastStartCapability) == 0 ||
		bytes.Equal(firstCapability, h.provider.LastStartCapability) {
		t.Fatal("resume reused the preceding sandbox capability")
	}
}

func TestEnsureRefusesAPlacementBeingDeleted(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := h.manager.Ensure(ctx, workerRef(), testLaunch()); err != nil {
		t.Fatal(err)
	}
	record, err := h.store.Get(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	record.State = runtime.StateDeleting
	h.store.Put(record)
	if _, err := h.manager.Ensure(ctx, workerRef(), testLaunch()); !errors.Is(err, runtime.ErrDeleting) {
		t.Fatalf("err = %v, want runtime.ErrDeleting", err)
	}
}

func TestStopRevokesTheCapabilityAndKeepsTheRow(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	_, err := h.manager.Ensure(ctx, workerRef(), testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	record, err := h.manager.Stop(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	if record.State != runtime.StateStopped || record.DesiredState != runtime.StateStopped {
		t.Fatalf("record = %#v", record)
	}
	if h.provider.Len() != 1 {
		t.Fatal("stopping must not destroy the sandbox")
	}
}

func TestDeleteCascadesInCredentialFirstOrder(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	_, err := h.manager.Ensure(ctx, workerRef(), testLaunch())
	if err != nil {
		t.Fatal(err)
	}
	*h.events = nil
	h.provider.Calls = nil

	if err := h.manager.Delete(ctx, workerRef()); err != nil {
		t.Fatal(err)
	}
	want := []string{"capability.revoke", "secrets.purge", "routes.release"}
	if len(*h.events) != len(want) {
		t.Fatalf("cascade events = %v, want %v", *h.events, want)
	}
	for i, event := range want {
		if (*h.events)[i] != event {
			t.Fatalf("cascade events = %v, want %v", *h.events, want)
		}
	}
	if len(h.provider.Calls) != 1 || !strings.HasPrefix(h.provider.Calls[0], "delete:") {
		t.Fatalf("provider calls = %v, want a single delete after the credential teardown", h.provider.Calls)
	}
	if h.provider.Len() != 0 || h.store.Len() != 0 {
		t.Fatalf("sandboxes = %d rows = %d, want none", h.provider.Len(), h.store.Len())
	}
}

func TestDeleteIsIdempotentAndPurgesDetachedCredentials(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := h.manager.Ensure(ctx, workerRef(), testLaunch()); err != nil {
		t.Fatal(err)
	}
	if err := h.manager.Delete(ctx, workerRef()); err != nil {
		t.Fatal(err)
	}
	*h.events = nil
	if err := h.manager.Delete(ctx, workerRef()); err != nil {
		t.Fatalf("second delete = %v, want nil", err)
	}
	// Even with no row left, the cascade still revokes and releases: a partial
	// earlier attempt may have removed the row while a grant survived.
	if len(*h.events) == 0 || (*h.events)[0] != "capability.revoke" {
		t.Fatalf("detached purge events = %v", *h.events)
	}
}

func TestDeleteLeavesAResumableIntentWhenTheProviderFails(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := h.manager.Ensure(ctx, workerRef(), testLaunch()); err != nil {
		t.Fatal(err)
	}
	h.provider.FailDelete = errors.New("provider unreachable")

	if err := h.manager.Delete(ctx, workerRef()); !errors.Is(err, runtime.ErrProviderUnavailable) {
		t.Fatalf("err = %v, want runtime.ErrProviderUnavailable", err)
	}
	record, err := h.store.Get(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	if record.State != runtime.StateDeleting {
		t.Fatalf("state = %s, want the delete intent to survive", record.State)
	}
	if err := h.manager.Delete(ctx, workerRef()); err != nil {
		t.Fatalf("retry = %v, want convergence", err)
	}
	if h.provider.Len() != 0 || h.store.Len() != 0 {
		t.Fatalf("sandboxes = %d rows = %d, want none", h.provider.Len(), h.store.Len())
	}
}

func TestDeleteWorkspaceCascadesEverySessionAndSurvivesOneFailure(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	for _, ref := range []runtime.Ref{workerRef(), coordinatorRef()} {
		if _, err := h.manager.Ensure(ctx, ref, testLaunch()); err != nil {
			t.Fatal(err)
		}
	}
	other := workerRef()
	other.WorkspaceID = "ws-2"
	other.SessionID = "sess-9"
	if _, err := h.manager.Ensure(ctx, other, testLaunch()); err != nil {
		t.Fatal(err)
	}

	h.provider.FailDelete = errors.New("provider unreachable")
	err := h.manager.DeleteWorkspace(ctx, "org-1", "ws-1")
	if err == nil {
		t.Fatal("workspace delete swallowed a provider failure")
	}
	// The failure must not have stranded the sibling placement.
	if h.store.Len() != 2 {
		t.Fatalf("rows = %d, want the failed placement plus the untouched workspace", h.store.Len())
	}
	if err := h.manager.DeleteWorkspace(ctx, "org-1", "ws-1"); err != nil {
		t.Fatalf("retry = %v", err)
	}
	if _, err := h.store.Get(ctx, other); err != nil {
		t.Fatalf("another workspace was collateral damage: %v", err)
	}
	if h.store.Len() != 1 {
		t.Fatalf("rows = %d, want only the other workspace", h.store.Len())
	}
}

func TestSecretSourceCannotOverrideCapabilityFile(t *testing.T) {
	h := newHarness(t, func(options *runtime.Options) {
		options.Secrets = &recordingSecrets{
			events: options.Secrets.(*recordingSecrets).events,
			files:  []runtime.FileSecret{{Path: runtime.CapabilityFilePath, Content: []byte("attacker-controlled-capability"), Mode: 0o600}},
		}
	})
	if _, err := h.manager.Ensure(context.Background(), workerRef(), testLaunch()); !errors.Is(err, runtime.ErrInvalid) {
		t.Fatalf("err = %v, want runtime.ErrInvalid", err)
	}
	if h.provider.Len() != 0 {
		t.Fatal("a sandbox was created with an attacker-supplied capability")
	}
}

func TestHeartbeatAndReportedStateAreRecorded(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := h.manager.Ensure(ctx, workerRef(), testLaunch()); err != nil {
		t.Fatal(err)
	}
	h.now = h.now.Add(5 * time.Minute)
	record, err := h.manager.Heartbeat(ctx, workerRef(), h.now)
	if err != nil {
		t.Fatal(err)
	}
	if !record.LastHeartbeatAt.Equal(h.now) {
		t.Fatalf("heartbeat = %s", record.LastHeartbeatAt)
	}
	reported, err := h.manager.ReportState(ctx, workerRef(), runtime.StateFailed, "agent crashed")
	if err != nil {
		t.Fatal(err)
	}
	if reported.State != runtime.StateFailed || reported.Error != "agent crashed" {
		t.Fatalf("reported = %#v", reported)
	}
	// A sandbox must not be able to report itself into or out of a teardown.
	if _, err := h.manager.ReportState(ctx, workerRef(), runtime.StateDeleting, ""); !errors.Is(err, runtime.ErrInvalid) {
		t.Fatalf("err = %v, want runtime.ErrInvalid", err)
	}
}

func TestNewManagerRejectsIncompleteWiring(t *testing.T) {
	base := func() runtime.Options {
		return runtime.Options{
			Store:        runtimetest.NewMemoryStore(),
			Provider:     runtimetest.NewFakeProvider(),
			Capabilities: &recordingCapabilities{},
			Deployment:   "staging",
			PublicURL:    "https://cloud.example",
			Snapshots:    map[runtime.Role]string{runtime.RoleCoordinator: "c", runtime.RoleWorker: "w"},
		}
	}
	for name, mutate := range map[string]func(*runtime.Options){
		"no store":        func(o *runtime.Options) { o.Store = nil },
		"no provider":     func(o *runtime.Options) { o.Provider = nil },
		"no capabilities": func(o *runtime.Options) { o.Capabilities = nil },
		"no deployment":   func(o *runtime.Options) { o.Deployment = " " },
		"no public url":   func(o *runtime.Options) { o.PublicURL = "" },
		"no worker image": func(o *runtime.Options) { o.Snapshots = map[runtime.Role]string{runtime.RoleCoordinator: "c"} },
		"negative quota":  func(o *runtime.Options) { o.Quotas = runtime.Quotas{MaxSandboxesPerOrg: -1} },
	} {
		options := base()
		mutate(&options)
		if _, err := runtime.NewManager(options); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
}
