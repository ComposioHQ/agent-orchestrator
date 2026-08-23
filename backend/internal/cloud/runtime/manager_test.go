package runtime_test

import (
	"context"
	"errors"
	"strings"
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
	inner  runtime.Capabilities
	events *[]string
	fail   error
}

func (c *recordingCapabilities) Issue(ctx context.Context, scope capability.Scope, ttl time.Duration) (capability.Grant, error) {
	*c.events = append(*c.events, "capability.issue")
	return c.inner.Issue(ctx, scope, ttl)
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
	env    map[string]string
	files  map[string]string
	fail   error
}

func (s *recordingSecrets) SandboxSecrets(context.Context, runtime.Ref) (runtime.Secrets, error) {
	*s.events = append(*s.events, "secrets.mint")
	return runtime.Secrets{Env: s.env, Files: s.files}, nil
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
		Store:        h.store,
		Provider:     h.provider,
		Capabilities: h.capabilities,
		Secrets:      h.secrets,
		Routes:       h.routes,
		Deployment:   "staging",
		PublicURL:    "https://cloud.example/",
		Snapshots:    map[runtime.Role]string{runtime.RoleCoordinator: "ao-coordinator", runtime.RoleWorker: "ao-worker"},
		Quotas:       runtime.DefaultQuotas(),
		Clock:        func() time.Time { return h.now },
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

func TestEnsureCreatesOneSandboxAndIsIdempotent(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	first, err := h.manager.Ensure(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	if !first.Created || first.Record.ProviderID == "" || first.Capability.Token == "" {
		t.Fatalf("first placement = %#v", first)
	}
	second, err := h.manager.Ensure(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	if second.Created {
		t.Fatal("second Ensure reported a create")
	}
	if second.Record.ID != first.Record.ID || second.Record.ProviderID != first.Record.ProviderID {
		t.Fatalf("second placement drifted: %#v", second.Record)
	}
	// A running sandbox has no way to receive a new credential out of band, so
	// an attach must not mint one.
	if second.Capability.Token != "" {
		t.Fatal("attach minted a capability the running sandbox cannot receive")
	}
	if h.provider.Len() != 1 || h.store.Len() != 1 {
		t.Fatalf("sandboxes = %d rows = %d, want one of each", h.provider.Len(), h.store.Len())
	}
}

func TestEnsureLabelsSandboxForDiscoveryAndCleanup(t *testing.T) {
	h := newHarness(t)
	placement, err := h.manager.Ensure(context.Background(), workerRef())
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

func TestEnsureInjectsCapabilityThroughTheEnvironmentOnly(t *testing.T) {
	h := newHarness(t, func(options *runtime.Options) {
		options.Secrets = &recordingSecrets{
			events: options.Secrets.(*recordingSecrets).events,
			env:    map[string]string{"GITHUB_TOKEN": "ghs_averyLongSecretValue"},
			files:  map[string]string{"/home/agent/.ssh/id_ed25519": "-----BEGIN OPENSSH PRIVATE KEY-----"},
		}
	})
	placement, err := h.manager.Ensure(context.Background(), workerRef())
	if err != nil {
		t.Fatal(err)
	}
	request := h.provider.LastCreate
	if request.Env[runtime.EnvCapability] != placement.Capability.Token {
		t.Fatal("capability not injected into the sandbox environment")
	}
	if request.Env[runtime.EnvControlPlaneURL] != "https://cloud.example" {
		t.Fatalf("control-plane URL = %q", request.Env[runtime.EnvControlPlaneURL])
	}
	if request.Env["GITHUB_TOKEN"] == "" || request.SecretFiles["/home/agent/.ssh/id_ed25519"] == "" {
		t.Fatal("secret source values not delivered")
	}
	for _, argument := range append([]string{request.Command}, request.Args...) {
		if argument != "" {
			t.Fatalf("sandbox entrypoint must stay empty unless explicitly set: %q", argument)
		}
	}
}

func TestEnsureScopesWorkerAndCoordinatorCapabilitiesDifferently(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	worker, err := h.manager.Ensure(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	coordinator, err := h.manager.Ensure(ctx, coordinatorRef())
	if err != nil {
		t.Fatal(err)
	}
	if worker.Record.ProviderID == coordinator.Record.ProviderID {
		t.Fatal("coordinator and worker must not share a sandbox")
	}
	if h.provider.LastCreate.Snapshot != "ao-coordinator" {
		t.Fatalf("coordinator snapshot = %q", h.provider.LastCreate.Snapshot)
	}

	// A worker may act on its own session but may not fan out or read the
	// workspace; a coordinator is the mirror image.
	if _, err := h.authority.Verify(ctx, worker.Capability.Token, capability.OpSessionWrite); err != nil {
		t.Fatalf("worker session write: %v", err)
	}
	for _, denied := range []capability.Operation{capability.OpWorkerProvision, capability.OpWorkspaceRead} {
		if _, err := h.authority.Verify(ctx, worker.Capability.Token, denied); !errors.Is(err, capability.ErrNotPermitted) {
			t.Fatalf("worker %s = %v, want ErrNotPermitted", denied, err)
		}
	}
	if _, err := h.authority.Verify(ctx, coordinator.Capability.Token, capability.OpWorkerProvision); err != nil {
		t.Fatalf("coordinator provisioning: %v", err)
	}
	for _, denied := range []capability.Operation{capability.OpSessionRead, capability.OpSessionWrite} {
		if _, err := h.authority.Verify(ctx, coordinator.Capability.Token, denied); !errors.Is(err, capability.ErrNotPermitted) {
			t.Fatalf("coordinator %s = %v, want ErrNotPermitted", denied, err)
		}
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
	if _, err := h.manager.Ensure(ctx, workerRef()); err != nil {
		t.Fatal(err)
	}

	second := workerRef()
	second.SessionID = "sess-2"
	_, secondErr := h.manager.Ensure(ctx, second)
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
	if _, err := h.manager.Ensure(ctx, otherWorkspace); err != nil {
		t.Fatal(err)
	}
	third := workerRef()
	third.WorkspaceID = "ws-3"
	third.SessionID = "sess-4"
	_, thirdErr := h.manager.Ensure(ctx, third)
	userErr := mustQuotaError(t, thirdErr)
	if userErr.Scope != runtime.ScopeUser || userErr.Limit != 2 || userErr.Subject != "user-1" {
		t.Fatalf("user quota error = %#v", userErr)
	}
}

func TestEnsureQuotaIgnoresPlacementsBeingDeleted(t *testing.T) {
	h := newHarness(t, func(options *runtime.Options) {
		options.Quotas = runtime.Quotas{MaxWorkersPerWorkspace: 1}
	})
	ctx := context.Background()
	if _, err := h.manager.Ensure(ctx, workerRef()); err != nil {
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
	if _, err := h.manager.Ensure(ctx, replacement); err != nil {
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

	if _, err := h.manager.Ensure(ctx, workerRef()); !errors.Is(err, runtime.ErrProviderUnavailable) {
		t.Fatalf("err = %v, want runtime.ErrProviderUnavailable", err)
	}
	record, err := h.store.Get(ctx, workerRef())
	if err != nil {
		t.Fatalf("the placement row must survive a failed create so nothing leaks: %v", err)
	}
	if record.State != runtime.StateFailed || record.Error == "" {
		t.Fatalf("record = %#v", record)
	}

	placement, err := h.manager.Ensure(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	if placement.Record.ID != record.ID {
		t.Fatal("resume must reuse the placement row so labels stay stable")
	}
	if placement.Record.State != runtime.StateRunning || placement.Capability.Token == "" {
		t.Fatalf("resumed placement = %#v", placement.Record)
	}
}

func TestEnsureReprovisionsWhenTheSandboxVanished(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	first, err := h.manager.Ensure(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	h.provider.Remove(first.Record.ProviderID)

	second, err := h.manager.Ensure(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	if second.Record.ID != first.Record.ID {
		t.Fatal("re-provisioning must reuse the placement row")
	}
	if second.Record.ProviderID == first.Record.ProviderID {
		t.Fatal("a replacement sandbox must be a new provider sandbox")
	}
	if second.Capability.Token == "" {
		t.Fatal("a replacement sandbox needs a freshly issued capability")
	}
	attribution, ok := runtime.Attribute(h.provider.LastCreate.Labels)
	if !ok || attribution.RuntimeID != first.Record.ID {
		t.Fatalf("replacement labels = %#v", h.provider.LastCreate.Labels)
	}
}

func TestEnsureBootsAStoppedSandboxAndRotatesItsCapability(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	first, err := h.manager.Ensure(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	h.provider.SetState(first.Record.ProviderID, runtime.ProviderStopped)

	second, err := h.manager.Ensure(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	if second.Record.State != runtime.StateRunning {
		t.Fatalf("state = %s, want running", second.Record.State)
	}
	if second.Capability.Token == "" || second.Capability.Token == first.Capability.Token {
		t.Fatal("booting must mint a fresh capability")
	}
	if _, err := h.authority.Verify(ctx, first.Capability.Token, capability.OpSandboxHeartbeat); !errors.Is(err, capability.ErrRevoked) {
		t.Fatalf("previous capability = %v, want revoked", err)
	}
}

func TestEnsureRefusesAPlacementBeingDeleted(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := h.manager.Ensure(ctx, workerRef()); err != nil {
		t.Fatal(err)
	}
	record, err := h.store.Get(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	record.State = runtime.StateDeleting
	h.store.Put(record)
	if _, err := h.manager.Ensure(ctx, workerRef()); !errors.Is(err, runtime.ErrDeleting) {
		t.Fatalf("err = %v, want runtime.ErrDeleting", err)
	}
}

func TestStopRevokesTheCapabilityAndKeepsTheRow(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	placement, err := h.manager.Ensure(ctx, workerRef())
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
	if _, err := h.authority.Verify(ctx, placement.Capability.Token, capability.OpSandboxHeartbeat); !errors.Is(err, capability.ErrRevoked) {
		t.Fatalf("capability after stop = %v, want revoked", err)
	}
}

func TestDeleteCascadesInCredentialFirstOrder(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	placement, err := h.manager.Ensure(ctx, workerRef())
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
	if _, err := h.authority.Verify(ctx, placement.Capability.Token, capability.OpSandboxHeartbeat); !errors.Is(err, capability.ErrRevoked) {
		t.Fatalf("capability after delete = %v, want revoked", err)
	}
}

func TestDeleteIsIdempotentAndPurgesDetachedCredentials(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := h.manager.Ensure(ctx, workerRef()); err != nil {
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
	if _, err := h.manager.Ensure(ctx, workerRef()); err != nil {
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
		if _, err := h.manager.Ensure(ctx, ref); err != nil {
			t.Fatal(err)
		}
	}
	other := workerRef()
	other.WorkspaceID = "ws-2"
	other.SessionID = "sess-9"
	if _, err := h.manager.Ensure(ctx, other); err != nil {
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

func TestSecretSourceCannotOverrideControlPlaneEnvironment(t *testing.T) {
	h := newHarness(t, func(options *runtime.Options) {
		options.Secrets = &recordingSecrets{
			events: options.Secrets.(*recordingSecrets).events,
			env:    map[string]string{runtime.EnvCapability: "aocap_v1.attacker.controlled"},
		}
	})
	if _, err := h.manager.Ensure(context.Background(), workerRef()); !errors.Is(err, runtime.ErrInvalid) {
		t.Fatalf("err = %v, want runtime.ErrInvalid", err)
	}
	if h.provider.Len() != 0 {
		t.Fatal("a sandbox was created with an attacker-supplied capability")
	}
}

func TestHeartbeatAndReportedStateAreRecorded(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := h.manager.Ensure(ctx, workerRef()); err != nil {
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

func TestResumingAnIdleStoppedSessionSticks(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if _, err := h.manager.Ensure(ctx, workerRef()); err != nil {
		t.Fatal(err)
	}
	// The reaper stopped it for idleness, which records a desired stop.
	if _, err := h.manager.Stop(ctx, workerRef()); err != nil {
		t.Fatal(err)
	}
	placement, err := h.manager.Ensure(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	// Booting is the intent to run: leaving the desired state at stopped would
	// have the next reconciliation pass immediately stop the resumed session.
	if placement.Record.DesiredState != runtime.StateRunning {
		t.Fatalf("desired state = %s, want running", placement.Record.DesiredState)
	}
}

func TestARetriedCreateDoesNotLeakASecondSandbox(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	// Model a create whose response was lost: the sandbox exists at the
	// provider, but the manager saw a failure and left the row without a
	// provider id. The retry must land on the same sandbox.
	record, created, err := h.store.Ensure(ctx, workerRef(), h.now)
	if err != nil || !created {
		t.Fatalf("staging the row failed: %v", err)
	}
	first, err := h.provider.Create(ctx, runtime.CreateRequest{
		Ref:            workerRef(),
		Labels:         runtime.Labels("staging", workerRef(), record.ID),
		Snapshot:       "ao-worker",
		IdempotencyKey: record.ID,
	})
	if err != nil {
		t.Fatal(err)
	}

	placement, err := h.manager.Ensure(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	if placement.Record.ProviderID != first.ID {
		t.Fatalf("retry created %s, want the original %s", placement.Record.ProviderID, first.ID)
	}
	if h.provider.Len() != 1 {
		t.Fatalf("sandboxes = %d, want the retry to collapse onto one", h.provider.Len())
	}
}
