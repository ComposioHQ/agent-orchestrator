package runtime_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime/runtimetest"
)

func testPolicy() runtime.ReaperPolicy {
	return runtime.ReaperPolicy{
		IdleTimeout:         30 * time.Minute,
		AbandonedTimeout:    4 * time.Hour,
		ProvisioningTimeout: 10 * time.Minute,
		OrphanGrace:         15 * time.Minute,
		UnlabeledGrace:      time.Hour,
		CapabilityRetention: 24 * time.Hour,
	}
}

func newReaper(t *testing.T, h *harness, policy runtime.ReaperPolicy) *runtime.Reaper {
	t.Helper()
	reaper, err := runtime.NewReaper(h.manager, h.authority, policy)
	if err != nil {
		t.Fatal(err)
	}
	return reaper
}

func mustRun(t *testing.T, reaper *runtime.Reaper) runtime.ReapReport {
	t.Helper()
	report, err := reaper.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Errors) > 0 {
		t.Fatalf("pass reported failures: %v", report.Errors)
	}
	return report
}

func TestReaperStopsAnIdlePlacementAndRevokesItsCapability(t *testing.T) {
	h := newHarness(t)
	reaper := newReaper(t, h, testPolicy())
	placement, err := h.manager.Ensure(context.Background(), workerRef())
	if err != nil {
		t.Fatal(err)
	}

	if report := mustRun(t, reaper); len(report.Stopped) != 0 {
		t.Fatalf("a fresh placement was stopped: %#v", report)
	}
	h.now = h.now.Add(31 * time.Minute)
	report := mustRun(t, reaper)
	if len(report.Stopped) != 1 || report.Stopped[0] != placement.Record.ID {
		t.Fatalf("stopped = %v", report.Stopped)
	}
	// Idle stopping keeps the disk so the session can resume, but the
	// credential must not survive the pause.
	if h.provider.Len() != 1 || h.store.Len() != 1 {
		t.Fatalf("sandboxes = %d rows = %d", h.provider.Len(), h.store.Len())
	}
	if _, err := h.authority.Verify(context.Background(), placement.Capability.Token, capability.OpSandboxHeartbeat); !errors.Is(err, capability.ErrRevoked) {
		t.Fatalf("capability after idle stop = %v, want revoked", err)
	}
}

func TestReaperHeartbeatKeepsAPlacementAlive(t *testing.T) {
	h := newHarness(t)
	reaper := newReaper(t, h, testPolicy())
	if _, err := h.manager.Ensure(context.Background(), workerRef()); err != nil {
		t.Fatal(err)
	}
	h.now = h.now.Add(25 * time.Minute)
	if _, err := h.manager.Heartbeat(context.Background(), workerRef(), h.now); err != nil {
		t.Fatal(err)
	}
	h.now = h.now.Add(25 * time.Minute)
	if report := mustRun(t, reaper); len(report.Stopped) != 0 {
		t.Fatalf("a checked-in placement was stopped: %#v", report)
	}
}

func TestReaperDeletesAnAbandonedPlacement(t *testing.T) {
	h := newHarness(t)
	reaper := newReaper(t, h, testPolicy())
	placement, err := h.manager.Ensure(context.Background(), workerRef())
	if err != nil {
		t.Fatal(err)
	}
	h.now = h.now.Add(5 * time.Hour)

	report := mustRun(t, reaper)
	if len(report.Deleted) != 1 || report.Deleted[0] != placement.Record.ID {
		t.Fatalf("deleted = %v", report.Deleted)
	}
	if h.provider.Len() != 0 || h.store.Len() != 0 {
		t.Fatalf("sandboxes = %d rows = %d, want a full cascade", h.provider.Len(), h.store.Len())
	}
}

func TestReaperReclaimsAPlacementStuckInProvisioning(t *testing.T) {
	h := newHarness(t)
	reaper := newReaper(t, h, testPolicy())
	// A row whose provider call never happened: the quota it holds is
	// otherwise held forever.
	h.store.Put(runtime.Record{
		ID: "rt-stuck", OrgID: "org-1", WorkspaceID: "ws-1", SessionID: "sess-stuck", UserID: "user-1",
		Role: runtime.RoleWorker, State: runtime.StateProvisioning, CreatedAt: h.now, UpdatedAt: h.now,
	})

	if report := mustRun(t, reaper); len(report.Deleted) != 0 {
		t.Fatalf("an in-flight create was reaped inside its window: %#v", report)
	}
	h.now = h.now.Add(11 * time.Minute)
	report := mustRun(t, reaper)
	if len(report.Deleted) != 1 || report.Deleted[0] != "rt-stuck" {
		t.Fatalf("deleted = %v", report.Deleted)
	}
	if h.store.Len() != 0 {
		t.Fatal("the stalled row was not reclaimed")
	}
}

func TestReaperResumesAnInterruptedDelete(t *testing.T) {
	h := newHarness(t)
	reaper := newReaper(t, h, testPolicy())
	ctx := context.Background()
	if _, err := h.manager.Ensure(ctx, workerRef()); err != nil {
		t.Fatal(err)
	}
	h.provider.FailDelete = errors.New("provider unreachable")
	if err := h.manager.Delete(ctx, workerRef()); err == nil {
		t.Fatal("expected the provider failure to surface")
	}

	report := mustRun(t, reaper)
	if len(report.Deleted) != 1 {
		t.Fatalf("deleted = %v", report.Deleted)
	}
	if h.provider.Len() != 0 || h.store.Len() != 0 {
		t.Fatalf("sandboxes = %d rows = %d, want the delete driven to completion", h.provider.Len(), h.store.Len())
	}
}

func TestReaperRepairsRecordedStateFromProviderTruth(t *testing.T) {
	h := newHarness(t)
	reaper := newReaper(t, h, testPolicy())
	placement, err := h.manager.Ensure(context.Background(), workerRef())
	if err != nil {
		t.Fatal(err)
	}
	// The sandbox stopped out of band (a provider-side auto-stop, a crash).
	h.provider.SetState(placement.Record.ProviderID, runtime.ProviderStopped)

	report := mustRun(t, reaper)
	if len(report.Repaired) != 1 || report.Repaired[0] != placement.Record.ID {
		t.Fatalf("repaired = %v", report.Repaired)
	}
	record, err := h.store.Get(context.Background(), workerRef())
	if err != nil {
		t.Fatal(err)
	}
	if record.State != runtime.StateStopped {
		t.Fatalf("state = %s, want the provider's view", record.State)
	}
}

func TestReaperConvergesASandboxBackToTheDesiredStoppedState(t *testing.T) {
	h := newHarness(t)
	reaper := newReaper(t, h, testPolicy())
	ctx := context.Background()
	placement, err := h.manager.Ensure(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.manager.Stop(ctx, workerRef()); err != nil {
		t.Fatal(err)
	}
	// Something started it again behind the control plane's back.
	h.provider.SetState(placement.Record.ProviderID, runtime.ProviderRunning)

	report := mustRun(t, reaper)
	if len(report.Converged) != 1 || report.Converged[0] != placement.Record.ID {
		t.Fatalf("converged = %v (repaired %v)", report.Converged, report.Repaired)
	}
	sandbox, err := h.provider.Get(ctx, placement.Record.ProviderID)
	if err != nil {
		t.Fatal(err)
	}
	if sandbox.State != runtime.ProviderStopped {
		t.Fatalf("provider state = %s, want the intent pushed back out", sandbox.State)
	}
}

func TestReaperMarksALostSandboxFailedThenDeletesItWhenAbandoned(t *testing.T) {
	h := newHarness(t)
	reaper := newReaper(t, h, testPolicy())
	placement, err := h.manager.Ensure(context.Background(), workerRef())
	if err != nil {
		t.Fatal(err)
	}
	h.provider.Remove(placement.Record.ProviderID)

	report := mustRun(t, reaper)
	if len(report.Lost) != 1 || len(report.Deleted) != 0 {
		t.Fatalf("report = %#v", report)
	}
	record, err := h.store.Get(context.Background(), workerRef())
	if err != nil {
		t.Fatal(err)
	}
	if record.State != runtime.StateFailed || record.Error == "" {
		t.Fatalf("record = %#v", record)
	}
	h.now = h.now.Add(5 * time.Hour)
	if report := mustRun(t, reaper); len(report.Deleted) != 1 {
		t.Fatalf("deleted = %v", report.Deleted)
	}
}

func TestReaperDeletesALabelledOrphanOnlyAfterItsGracePeriod(t *testing.T) {
	h := newHarness(t)
	reaper := newReaper(t, h, testPolicy())
	// A create whose response was lost: the sandbox exists and is labelled,
	// but no row points at it.
	ref := workerRef()
	orphan := h.provider.Seed(runtime.Sandbox{
		Labels:    runtime.Labels("staging", ref, "rt-vanished"),
		CreatedAt: h.now,
	})

	report := mustRun(t, reaper)
	if len(report.Orphans) != 0 {
		t.Fatalf("an orphan was deleted inside its grace period: %v", report.Orphans)
	}
	h.now = h.now.Add(16 * time.Minute)
	report = mustRun(t, reaper)
	if len(report.Orphans) != 1 || report.Orphans[0] != orphan.ID {
		t.Fatalf("orphans = %v", report.Orphans)
	}
	if h.provider.Len() != 0 {
		t.Fatal("the orphaned sandbox survived")
	}
}

// staleListStore models the read race the orphan sweep has to survive: the
// placement scan ran before a create response was written, so every listed row
// looks like it owns no sandbox, while a fresh read by id shows the truth.
type staleListStore struct {
	*runtimetest.MemoryStore
}

func (s staleListStore) List(ctx context.Context, filter runtime.Filter) ([]runtime.Record, error) {
	records, err := s.MemoryStore.List(ctx, filter)
	for i := range records {
		records[i].ProviderID = ""
	}
	return records, err
}

func TestReaperLeavesASandboxAClaimingRowStillPointsAt(t *testing.T) {
	h := newHarness(t, func(options *runtime.Options) {
		options.Store = staleListStore{options.Store.(*runtimetest.MemoryStore)}
	})
	reaper := newReaper(t, h, testPolicy())
	ctx := context.Background()
	if _, err := h.manager.Ensure(ctx, workerRef()); err != nil {
		t.Fatal(err)
	}
	h.now = h.now.Add(time.Hour)

	report := mustRun(t, reaper)
	if len(report.Orphans) != 0 {
		t.Fatalf("orphans = %v, want none: the row still claims the sandbox", report.Orphans)
	}
	if h.provider.Len() != 1 {
		t.Fatal("a sandbox whose row still claims it was deleted as an orphan")
	}
}

func TestReaperIgnoresAnotherDeploymentsSandboxes(t *testing.T) {
	h := newHarness(t)
	reaper := newReaper(t, h, testPolicy())
	ref := workerRef()
	h.provider.Seed(runtime.Sandbox{
		Labels:    runtime.Labels("production", ref, "rt-elsewhere"),
		CreatedAt: h.now.Add(-24 * time.Hour),
	})

	report := mustRun(t, reaper)
	if len(report.Orphans) != 0 || len(report.Leaks) != 0 {
		t.Fatalf("report = %#v, want another control plane's sandbox untouched", report)
	}
	if h.provider.Len() != 1 {
		t.Fatal("production's sandbox was deleted by staging")
	}
}

func TestReaperReportsUnlabelledLeaksAndDeletesThemOnlyWhenAuthorized(t *testing.T) {
	h := newHarness(t)
	leak := h.provider.Seed(runtime.Sandbox{
		Labels:    map[string]string{"someone": "else"},
		CreatedAt: h.now.Add(-24 * time.Hour),
	})

	// Off by default: an unattributable sandbox is reported, never deleted,
	// because the same rule would delete a stranger's sandbox in a shared
	// provider account.
	observer := newReaper(t, h, testPolicy())
	report := mustRun(t, observer)
	if len(report.Unattributed) != 1 || report.Unattributed[0] != leak.ID || len(report.Leaks) != 0 {
		t.Fatalf("report = %#v", report)
	}
	if h.provider.Len() != 1 {
		t.Fatal("an unattributable sandbox was deleted without authorization")
	}

	policy := testPolicy()
	policy.ReapUnlabeled = true
	cleaner := newReaper(t, h, policy)
	report = mustRun(t, cleaner)
	if len(report.Leaks) != 1 || report.Leaks[0] != leak.ID {
		t.Fatalf("leaks = %v", report.Leaks)
	}
	if h.provider.Len() != 0 {
		t.Fatal("the leak survived")
	}
}

func TestReaperWillNotDeleteASandboxOfUnknownAge(t *testing.T) {
	h := newHarness(t)
	policy := testPolicy()
	policy.ReapUnlabeled = true
	reaper := newReaper(t, h, policy)
	// A provider that cannot report a creation time must not have its
	// sandboxes deleted on a guess.
	h.provider.Seed(runtime.Sandbox{Labels: map[string]string{}, CreatedAt: time.Time{}})

	report := mustRun(t, reaper)
	if len(report.Leaks) != 0 || len(report.Unattributed) != 1 {
		t.Fatalf("report = %#v", report)
	}
}

func TestReaperKeepsGoingWhenOnePlacementFails(t *testing.T) {
	h := newHarness(t)
	reaper := newReaper(t, h, testPolicy())
	ctx := context.Background()
	first, err := h.manager.Ensure(ctx, workerRef())
	if err != nil {
		t.Fatal(err)
	}
	second := workerRef()
	second.SessionID = "sess-2"
	if _, err := h.manager.Ensure(ctx, second); err != nil {
		t.Fatal(err)
	}
	h.now = h.now.Add(5 * time.Hour)
	h.provider.FailDelete = errors.New("provider unreachable")

	report, err := reaper.Run(ctx)
	if err != nil {
		t.Fatalf("a per-placement failure must not fail the pass: %v", err)
	}
	if len(report.Errors) != 1 {
		t.Fatalf("errors = %v, want exactly the wedged placement", report.Errors)
	}
	if len(report.Deleted) != 1 {
		t.Fatalf("deleted = %v, want the healthy placement collected anyway", report.Deleted)
	}
	// The wedged placement kept its durable delete intent for the next pass.
	wedged, err := h.store.GetByID(ctx, first.Record.ID)
	if err == nil && wedged.State != runtime.StateDeleting {
		t.Fatalf("wedged placement state = %s", wedged.State)
	}
}

func TestReaperPurgesSpentCapabilities(t *testing.T) {
	h := newHarness(t)
	reaper := newReaper(t, h, testPolicy())
	ctx := context.Background()
	if _, err := h.manager.Ensure(ctx, workerRef()); err != nil {
		t.Fatal(err)
	}
	if err := h.manager.Delete(ctx, workerRef()); err != nil {
		t.Fatal(err)
	}
	if h.grants.Len() != 1 {
		t.Fatalf("grants = %d, want the revoked row retained", h.grants.Len())
	}
	h.now = h.now.Add(25 * time.Hour)

	report := mustRun(t, reaper)
	if report.PurgedCapabilities != 1 || h.grants.Len() != 0 {
		t.Fatalf("purged = %d retained = %d", report.PurgedCapabilities, h.grants.Len())
	}
}

func TestReaperPolicyValidation(t *testing.T) {
	for name, policy := range map[string]runtime.ReaperPolicy{
		"negative timeout":         {IdleTimeout: -time.Minute},
		"abandoned before idle":    {IdleTimeout: time.Hour, AbandonedTimeout: time.Minute},
		"unlabelled without grace": {ReapUnlabeled: true},
	} {
		if err := policy.Validate(); !errors.Is(err, runtime.ErrInvalid) {
			t.Fatalf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
	if err := runtime.DefaultReaperPolicy().Validate(); err != nil {
		t.Fatal(err)
	}
}
