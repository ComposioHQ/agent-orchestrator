package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type sandboxFixture struct {
	store     *Store
	principal domain.Principal
	orgID     string
	projectID string
	sessionID string
	unique    string
}

// environmentID builds a provider environment id unique to this fixture.
// ao_sandboxes enforces one sandbox per (provider, provider_environment_id),
// so reusing a literal across tests would collide.
func (f sandboxFixture) environmentID(suffix string) string {
	return "sbx-" + f.unique + "-" + suffix
}

// newSandboxFixture creates an isolated organization, project, and session with
// its sandbox row in `requested`. Identities are suffixed per run so the suite
// is repeatable against a database that is not dropped between runs.
func newSandboxFixture(t *testing.T, label string) sandboxFixture {
	t.Helper()
	unique := strings.ToLower(uuid.NewString()[:8])
	email := label + "-" + unique + "@example.com"
	slug := label + "-" + unique
	databaseURL := os.Getenv("AO_CLOUD_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("AO_CLOUD_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	if err := Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	store, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)

	now := time.Now()
	principal, orgID := registerTestUser(t, store, email, slug, now)
	project, err := store.CreateProject(ctx, principal, orgID, slug+"-project-key", domain.CreateProject{
		DisplayName:   "Sandbox fixture",
		RepositoryURL: "https://github.com/example/repo.git",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	session, err := store.CreateSession(ctx, principal, orgID, slug+"-session-key", 100, domain.CreateSession{
		ProjectID:   project.ID,
		Kind:        "worker",
		Harness:     "claude-code",
		DisplayName: "Sandbox fixture session",
		Provider:    "nodeops",
		ResourceProfile: json.RawMessage(
			`{"provider":"nodeops","nodeOps":{"defaultShape":"s-4vcpu-8gb","defaultRootFs":"devbox:1"}}`,
		),
		BootstrapContext: json.RawMessage(`{"provider":"nodeops"}`),
		Release:          "test-release",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if err := store.withService(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE ao_sandboxes
			SET reconcile_after = now() + interval '1 day'
			WHERE session_id = $1`,
			session.ID,
		)
		return err
	}); err != nil {
		t.Fatalf("park fixture sandbox: %v", err)
	}
	// Park only this fixture at cleanup. Updating every other sandbox made
	// lifecycle tests in concurrently running packages steal each other's work.
	t.Cleanup(func() {
		_ = store.withService(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(
				context.Background(),
				`UPDATE ao_sandboxes
				SET reconcile_after = now() + interval '1 day',
					reconcile_lease_owner = '',
					reconcile_lease_until = NULL
				WHERE org_id = $1`,
				orgID,
			)
			return err
		})
	})

	return sandboxFixture{
		store:     store,
		principal: principal,
		orgID:     orgID,
		projectID: project.ID,
		sessionID: session.ID,
		unique:    unique,
	}
}

// makeDue clears any scheduled backoff so the next claim sees the row. A
// heartbeat pushes the next reconcile 30 seconds out, which a test should not
// wait for.
func (f sandboxFixture) makeDue(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	if err := f.store.withService(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(
			ctx,
			`UPDATE ao_sandboxes SET reconcile_after = now() WHERE session_id = $1`,
			f.sessionID,
		)
		return err
	}); err != nil {
		t.Fatalf("make sandbox due: %v", err)
	}
}

func (f sandboxFixture) claimOwn(t *testing.T, owner string) domain.Sandbox {
	t.Helper()
	ctx := context.Background()
	var record domain.Sandbox
	err := f.store.withService(ctx, func(tx pgx.Tx) error {
		var err error
		record, err = scanSandbox(tx.QueryRow(
			ctx,
			`UPDATE ao_sandboxes sandbox
			SET reconcile_lease_owner = $2,
				reconcile_lease_until = now() + interval '30 seconds'
			WHERE session_id = $1
				AND (reconcile_lease_until IS NULL OR reconcile_lease_until < now())
			RETURNING `+sandboxColumns,
			f.sessionID,
			owner,
		))
		return err
	})
	if err != nil {
		t.Fatalf("claim fixture sandbox: %v", err)
	}
	return record
}

func TestClaimSandboxesLeasesExclusively(t *testing.T) {
	fixture := newSandboxFixture(t, "claim")
	ctx := context.Background()
	fixture.makeDue(t)

	claimed, err := fixture.store.ClaimSandboxes(ctx, "owner-a", 100, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var record domain.Sandbox
	for _, candidate := range claimed {
		if candidate.SessionID == fixture.sessionID {
			record = candidate
			continue
		}
		if err := fixture.store.ReleaseSandboxClaim(
			ctx,
			"owner-a",
			candidate.OrgID,
			candidate.SessionID,
			time.Now(),
		); err != nil {
			t.Fatal(err)
		}
	}
	if record.SessionID == "" {
		t.Fatal("fixture sandbox was not claimed")
	}
	if record.OrgID != fixture.orgID || record.Provider != "nodeops" {
		t.Fatalf("claimed sandbox = %+v, want the fixture row", record)
	}
	if record.ObservedState != domain.SandboxObservedRequested {
		t.Errorf("observed state = %q, want requested", record.ObservedState)
	}

	// A second reconciler must not see a row that is still leased.
	second, err := fixture.store.ClaimSandboxes(ctx, "owner-b", 100, 30*time.Second)
	if err != nil {
		t.Fatalf("ClaimSandboxes() error = %v", err)
	}
	for _, other := range second {
		if other.SessionID == fixture.sessionID {
			t.Fatal("a leased sandbox was claimed twice; two reconcilers would both provision it")
		}
	}
}

func TestConcurrentClaimsNeverOverlap(t *testing.T) {
	fixture := newSandboxFixture(t, "concurrent")
	ctx := context.Background()
	fixture.makeDue(t)

	var mu sync.Mutex
	seen := map[string]int{}
	type ownedClaim struct {
		owner  string
		record domain.Sandbox
	}
	var unrelated []ownedClaim
	var wait sync.WaitGroup
	for i := 0; i < 8; i++ {
		wait.Add(1)
		go func(owner string) {
			defer wait.Done()
			claimed, err := fixture.store.ClaimSandboxes(ctx, owner, 20, 30*time.Second)
			if err != nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			for _, record := range claimed {
				seen[record.SessionID]++
				if record.SessionID != fixture.sessionID {
					unrelated = append(unrelated, ownedClaim{owner: owner, record: record})
				}
			}
		}("owner-" + string(rune('a'+i)))
	}
	wait.Wait()
	for _, claim := range unrelated {
		if err := fixture.store.ReleaseSandboxClaim(
			ctx,
			claim.owner,
			claim.record.OrgID,
			claim.record.SessionID,
			time.Now(),
		); err != nil {
			t.Fatal(err)
		}
	}

	for sessionID, count := range seen {
		if count > 1 {
			t.Fatalf("sandbox %s was claimed %d times concurrently, want at most 1", sessionID, count)
		}
	}
}

func TestUpdateSandboxObservationRequiresTheLease(t *testing.T) {
	fixture := newSandboxFixture(t, "lease")
	ctx := context.Background()
	fixture.claimOwn(t, "owner-a")

	err := fixture.store.UpdateSandboxObservation(
		ctx, "owner-b", fixture.orgID, fixture.sessionID,
		fixture.environmentID("1"), domain.SandboxObservedProvisioning, "", time.Now(),
	)
	if !errors.Is(err, ErrSandboxLeaseLost) {
		t.Fatalf("UpdateSandboxObservation() by a non-owner error = %v, want ErrSandboxLeaseLost", err)
	}

	if err := fixture.store.UpdateSandboxObservation(
		ctx, "owner-a", fixture.orgID, fixture.sessionID,
		fixture.environmentID("1"), domain.SandboxObservedProvisioning, "", time.Now(),
	); err != nil {
		t.Fatalf("UpdateSandboxObservation() by the owner error = %v", err)
	}

	record := fixture.claimOwn(t, "owner-c")
	if record.ProviderEnvironmentID != fixture.environmentID("1") ||
		record.ObservedState != domain.SandboxObservedProvisioning {
		t.Fatalf("record after observation = %+v, want sbx-1 in provisioning", record)
	}
}

func TestStartupDeadlinePersistsAcrossProviderTransitionFlaps(t *testing.T) {
	fixture := newSandboxFixture(t, "startup-deadline")
	ctx := context.Background()

	fixture.claimOwn(t, "owner-a")
	if err := fixture.store.UpdateSandboxObservation(
		ctx, "owner-a", fixture.orgID, fixture.sessionID,
		fixture.environmentID("1"), domain.SandboxObservedProvisioning, "", time.Now(),
	); err != nil {
		t.Fatal(err)
	}
	record := fixture.claimOwn(t, "owner-b")
	if record.StartupStartedAt == nil {
		t.Fatal("provisioning observation did not start the startup deadline")
	}
	startedAt := *record.StartupStartedAt

	if err := fixture.store.UpdateSandboxObservation(
		ctx, "owner-b", fixture.orgID, fixture.sessionID,
		fixture.environmentID("1"), domain.SandboxObservedRestoring, "", time.Now(),
	); err != nil {
		t.Fatal(err)
	}
	record = fixture.claimOwn(t, "owner-c")
	if record.StartupStartedAt == nil || !record.StartupStartedAt.Equal(startedAt) {
		t.Fatalf("startup deadline = %v, want original %v across provider flap", record.StartupStartedAt, startedAt)
	}
}

func TestExpiredLeaseCannotWriteAndLiveLeaseRenews(t *testing.T) {
	fixture := newSandboxFixture(t, "fence")
	ctx := context.Background()
	fixture.claimOwn(t, "owner-a")
	if err := fixture.store.withService(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE ao_sandboxes
			SET reconcile_lease_until = now() - interval '1 second'
			WHERE session_id = $1`,
			fixture.sessionID,
		)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.UpdateSandboxObservation(
		ctx,
		"owner-a",
		fixture.orgID,
		fixture.sessionID,
		fixture.environmentID("stale"),
		domain.SandboxObservedProvisioning,
		"",
		time.Now(),
	); !errors.Is(err, ErrSandboxLeaseLost) {
		t.Fatalf("expired owner update error = %v, want ErrSandboxLeaseLost", err)
	}

	fixture.claimOwn(t, "owner-b")
	if err := fixture.store.RenewSandboxClaim(
		ctx,
		"owner-b",
		fixture.orgID,
		fixture.sessionID,
		time.Minute,
	); err != nil {
		t.Fatalf("RenewSandboxClaim() error = %v", err)
	}
	second, err := fixture.store.ClaimSandboxes(ctx, "owner-c", 100, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range second {
		if record.SessionID == fixture.sessionID {
			t.Fatal("another owner claimed a sandbox whose lease was renewed")
		}
		_ = fixture.store.ReleaseSandboxClaim(
			ctx,
			"owner-c",
			record.OrgID,
			record.SessionID,
			time.Now(),
		)
	}
}

func TestObservationClearsTheHeartbeatWhenComputeIsReplaced(t *testing.T) {
	fixture := newSandboxFixture(t, "replace")
	ctx := context.Background()

	fixture.claimOwn(t, "owner-a")
	if err := fixture.store.UpdateSandboxObservation(
		ctx, "owner-a", fixture.orgID, fixture.sessionID,
		fixture.environmentID("1"), domain.SandboxObservedRunning, "", time.Now(),
	); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.MarkWorkerSeen(
		ctx, fixture.orgID, fixture.sessionID, "worker-1", "0.1.0", 1, nil,
	); err != nil {
		t.Fatalf("MarkWorkerSeen() error = %v", err)
	}

	fixture.claimOwn(t, "owner-a")
	if err := fixture.store.UpdateSandboxObservation(
		ctx, "owner-a", fixture.orgID, fixture.sessionID,
		fixture.environmentID("2"), domain.SandboxObservedBootstrapping, "", time.Now(),
	); err != nil {
		t.Fatal(err)
	}

	record := fixture.claimOwn(t, "owner-a")
	if record.WorkerLastSeenAt != nil {
		t.Fatal("the old heartbeat survived a compute replacement; the startup deadline would never fire")
	}
}

func TestObservationClearsTheHeartbeatWhenRefreshingRestoredWorker(t *testing.T) {
	fixture := newSandboxFixture(t, "restore")
	ctx := context.Background()

	fixture.claimOwn(t, "owner-a")
	if err := fixture.store.UpdateSandboxObservation(
		ctx, "owner-a", fixture.orgID, fixture.sessionID,
		fixture.environmentID("1"), domain.SandboxObservedRunning, "", time.Now(),
	); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.MarkWorkerSeen(
		ctx, fixture.orgID, fixture.sessionID, "worker-before-restore", "0.1.0", 1, nil,
	); err != nil {
		t.Fatalf("MarkWorkerSeen() error = %v", err)
	}

	fixture.claimOwn(t, "owner-a")
	if err := fixture.store.UpdateSandboxObservation(
		ctx, "owner-a", fixture.orgID, fixture.sessionID,
		fixture.environmentID("1"), domain.SandboxObservedRestoring, "", time.Now(),
	); err != nil {
		t.Fatal(err)
	}

	record := fixture.claimOwn(t, "owner-a")
	if record.WorkerLastSeenAt != nil {
		t.Fatal("the previous worker heartbeat survived restore; a stale worker could be treated as current")
	}
	if record.ObservedState != domain.SandboxObservedRestoring {
		t.Fatalf("observed state = %q, want restoring", record.ObservedState)
	}

	if err := fixture.store.MarkWorkerSeen(
		ctx, fixture.orgID, fixture.sessionID, "worker-after-restore", "0.2.0", 1, nil,
	); err != nil {
		t.Fatalf("MarkWorkerSeen() after restore error = %v", err)
	}
	record = fixture.claimOwn(t, "owner-a")
	if record.ObservedState != domain.SandboxObservedRunning {
		t.Fatalf("observed state after fresh heartbeat = %q, want running", record.ObservedState)
	}
}

func TestAccessTicketRedeemsExactlyOnce(t *testing.T) {
	fixture := newSandboxFixture(t, "ticket")
	ctx := context.Background()

	token, err := fixture.store.IssueAccessTicket(
		ctx, fixture.orgID, fixture.sessionID, "worker_bootstrap",
		[]string{"worker:connect", "worker:event"}, 10*time.Minute,
	)
	if err != nil {
		t.Fatalf("IssueAccessTicket() error = %v", err)
	}

	ticket, err := fixture.store.RedeemWorkerBootstrapTicket(ctx, token)
	if err != nil {
		t.Fatalf("RedeemWorkerBootstrapTicket() error = %v", err)
	}
	if ticket.OrgID != fixture.orgID || ticket.SessionID != fixture.sessionID {
		t.Errorf("ticket identity = %+v, want the fixture session", ticket)
	}
	if ticket.WorkerEpoch <= 0 {
		t.Error("no worker epoch was assigned on redemption")
	}
	if len(ticket.Scopes) != 2 {
		t.Errorf("scopes = %v, want the two issued scopes", ticket.Scopes)
	}

	if _, err := fixture.store.RedeemWorkerBootstrapTicket(ctx, token); !errors.Is(err, ErrInvalidTicket) {
		t.Fatalf("second redemption error = %v, want ErrInvalidTicket", err)
	}
}

func TestExpiredAndUnknownTicketsAreRejected(t *testing.T) {
	fixture := newSandboxFixture(t, "expired")
	ctx := context.Background()

	token, err := fixture.store.IssueAccessTicket(
		ctx, fixture.orgID, fixture.sessionID, "worker_bootstrap", []string{"worker:connect"}, time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	// The schema requires expires_at > created_at, so age the whole row rather
	// than pulling the expiry back behind its creation.
	if err := fixture.store.withService(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE ao_access_tickets
			SET created_at = now() - interval '10 minutes',
				expires_at = now() - interval '1 minute'
			WHERE session_id = $1`,
			fixture.sessionID,
		)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.store.RedeemWorkerBootstrapTicket(ctx, token); !errors.Is(err, ErrInvalidTicket) {
		t.Fatalf("expired ticket error = %v, want ErrInvalidTicket", err)
	}
	if _, err := fixture.store.RedeemWorkerBootstrapTicket(ctx, "not-a-real-ticket"); !errors.Is(err, ErrInvalidTicket) {
		t.Fatalf("unknown ticket error = %v, want ErrInvalidTicket", err)
	}
}

func TestWorkerHeartbeatPromotesTheSandboxToRunning(t *testing.T) {
	fixture := newSandboxFixture(t, "heartbeat")
	ctx := context.Background()

	fixture.claimOwn(t, "owner-a")
	if err := fixture.store.UpdateSandboxObservation(
		ctx, "owner-a", fixture.orgID, fixture.sessionID,
		fixture.environmentID("1"), domain.SandboxObservedBootstrapping, "", time.Now(),
	); err != nil {
		t.Fatal(err)
	}

	if err := fixture.store.RegisterWorkerBootstrap(
		ctx, fixture.orgID, fixture.sessionID, "worker-1", "0.1.0", 1, []string{"worker.heartbeat"},
	); err != nil {
		t.Fatalf("RegisterWorkerBootstrap() error = %v", err)
	}
	current, err := fixture.store.WorkerConnectionCurrent(ctx, fixture.orgID, fixture.sessionID, "worker-1", 1)
	if err != nil || !current {
		t.Fatalf("WorkerConnectionCurrent() = %v, %v; want true", current, err)
	}
	if err := fixture.store.MarkWorkerSeen(
		ctx, fixture.orgID, fixture.sessionID, "worker-1", "0.1.0", 1, []string{"worker.heartbeat"},
	); err != nil {
		t.Fatalf("MarkWorkerSeen() error = %v", err)
	}

	var observedState string
	var seenAt *time.Time
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(
			ctx,
			`SELECT observed_state, worker_last_seen_at
			FROM ao_sandboxes WHERE session_id = $1`,
			fixture.sessionID,
		).Scan(&observedState, &seenAt)
	}); err != nil {
		t.Fatal(err)
	}
	if observedState != domain.SandboxObservedRunning || seenAt == nil {
		t.Fatalf("sandbox after heartbeat = %q / %v, want running with a heartbeat", observedState, seenAt)
	}
}

func TestANewEpochRetiresTheOldWorker(t *testing.T) {
	fixture := newSandboxFixture(t, "epoch")
	ctx := context.Background()

	if err := fixture.store.RegisterWorkerBootstrap(
		ctx, fixture.orgID, fixture.sessionID, "worker-1", "0.1.0", 1, nil,
	); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.RegisterWorkerBootstrap(
		ctx, fixture.orgID, fixture.sessionID, "worker-2", "0.1.0", 2, nil,
	); err != nil {
		t.Fatalf("registering a replacement worker failed: %v", err)
	}

	stale, err := fixture.store.WorkerConnectionCurrent(ctx, fixture.orgID, fixture.sessionID, "worker-1", 1)
	if err != nil {
		t.Fatal(err)
	}
	if stale {
		t.Fatal("a replaced worker still reports as current; its token would keep working")
	}
	current, err := fixture.store.WorkerConnectionCurrent(ctx, fixture.orgID, fixture.sessionID, "worker-2", 2)
	if err != nil || !current {
		t.Fatalf("the replacement worker is not current: %v, %v", current, err)
	}
	if err := fixture.store.MarkWorkerSeen(
		ctx, fixture.orgID, fixture.sessionID, "worker-1", "0.1.0", 1, nil,
	); !errors.Is(err, ErrStaleWorker) {
		t.Fatalf("stale heartbeat error = %v, want ErrStaleWorker", err)
	}
}

func TestIssuingReplacementTicketRotatesEpochAndInvalidatesPreviousTicket(t *testing.T) {
	fixture := newSandboxFixture(t, "ticket-rotation")
	ctx := context.Background()

	firstToken, err := fixture.store.IssueAccessTicket(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		"worker_bootstrap",
		[]string{"worker:connect"},
		time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	first, err := fixture.store.RedeemWorkerBootstrapTicket(ctx, firstToken)
	if err != nil {
		t.Fatal(err)
	}
	firstWorker := "worker-first"
	if err := fixture.store.RegisterWorkerBootstrap(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		firstWorker,
		"0.1.0",
		first.WorkerEpoch,
		nil,
	); err != nil {
		t.Fatal(err)
	}

	staleToken, err := fixture.store.IssueAccessTicket(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		"worker_bootstrap",
		[]string{"worker:connect"},
		time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	freshToken, err := fixture.store.IssueAccessTicket(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		"worker_bootstrap",
		[]string{"worker:connect"},
		time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.store.RedeemWorkerBootstrapTicket(ctx, staleToken); !errors.Is(err, ErrInvalidTicket) {
		t.Fatalf("superseded ticket error = %v, want ErrInvalidTicket", err)
	}
	current, err := fixture.store.WorkerConnectionCurrent(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		firstWorker,
		first.WorkerEpoch,
	)
	if err != nil {
		t.Fatal(err)
	}
	if current {
		t.Fatal("issuing a replacement launch ticket did not fence the old worker")
	}
	fresh, err := fixture.store.RedeemWorkerBootstrapTicket(ctx, freshToken)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.WorkerEpoch <= first.WorkerEpoch {
		t.Fatalf("replacement epoch = %d, first epoch = %d", fresh.WorkerEpoch, first.WorkerEpoch)
	}
}

func TestWorkerLaunchSpecCarriesTheRepository(t *testing.T) {
	fixture := newSandboxFixture(t, "launch")

	launch, err := fixture.store.WorkerLaunchSpec(context.Background(), fixture.orgID, fixture.sessionID)
	if err != nil {
		t.Fatalf("WorkerLaunchSpec() error = %v", err)
	}
	if launch.RepositoryURL != "https://github.com/example/repo.git" ||
		launch.DefaultBranch != "main" ||
		launch.Harness != "claude-code" {
		t.Fatalf("launch spec = %+v, want the project's repository and the session harness", launch)
	}
}

func TestConcurrentSessionCreationCannotOversubscribeQuota(t *testing.T) {
	fixture := newSandboxFixture(t, "quota-race")
	ctx := context.Background()
	const callers = 8
	errs := make(chan error, callers)
	for i := 0; i < callers; i++ {
		go func(index int) {
			_, err := fixture.store.CreateSession(
				ctx,
				fixture.principal,
				fixture.orgID,
				"quota-race-"+string(rune('a'+index)),
				2, // The fixture already consumes one slot.
				domain.CreateSession{
					ProjectID:   fixture.projectID,
					Kind:        "worker",
					Harness:     "claude-code",
					DisplayName: "Concurrent quota allocation",
					Provider:    "nodeops",
				},
			)
			errs <- err
		}(i)
	}

	succeeded := 0
	exceeded := 0
	for i := 0; i < callers; i++ {
		switch err := <-errs; {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrSandboxQuotaExceeded):
			exceeded++
		default:
			t.Fatalf("concurrent CreateSession() error = %v", err)
		}
	}
	if succeeded != 1 || exceeded != callers-1 {
		t.Fatalf("quota race results = %d succeeded, %d exceeded; want 1/%d", succeeded, exceeded, callers-1)
	}
	count, err := fixture.store.CountActiveSandboxes(ctx, fixture.principal, fixture.orgID)
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("active sandboxes = %d, want exactly quota 2", count)
	}
}

func TestQuotaIsReleasedOnlyAfterDurableSessionTermination(t *testing.T) {
	fixture := newSandboxFixture(t, "quota")
	ctx := context.Background()
	if _, err := fixture.store.AppendSessionEvent(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		"sandbox.provisioning",
		json.RawMessage(`{"provider":"nodeops"}`),
	); err != nil {
		t.Fatal(err)
	}

	count, err := fixture.store.CountActiveSandboxes(ctx, fixture.principal, fixture.orgID)
	if err != nil {
		t.Fatalf("CountActiveSandboxes() error = %v", err)
	}
	if count != 1 {
		t.Fatalf("active sandboxes = %d, want 1", count)
	}

	if err := fixture.store.SetSandboxDesiredState(
		ctx, fixture.principal, fixture.orgID, fixture.sessionID, domain.SandboxDesiredDeleted,
	); err != nil {
		t.Fatalf("SetSandboxDesiredState() error = %v", err)
	}
	// Delete intent still holds quota until provider absence is confirmed.
	count, err = fixture.store.CountActiveSandboxes(ctx, fixture.principal, fixture.orgID)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("active sandboxes after delete intent = %d, want 1", count)
	}

	fixture.claimOwn(t, "delete-owner")
	if err := fixture.store.CompleteSandboxDeletion(
		ctx,
		"delete-owner",
		fixture.orgID,
		fixture.sessionID,
	); err != nil {
		t.Fatalf("CompleteSandboxDeletion() error = %v", err)
	}
	count, err = fixture.store.CountActiveSandboxes(ctx, fixture.principal, fixture.orgID)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("active sandboxes after confirmed deletion = %d, want 0", count)
	}

	var observed string
	var terminated bool
	var events int
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(
			ctx,
			`SELECT sandbox.observed_state, session.is_terminated,
				(SELECT count(*) FROM ao_events event WHERE event.session_id = session.id)
			FROM ao_sessions session
			JOIN ao_sandboxes sandbox ON sandbox.session_id = session.id
			WHERE session.id = $1`,
			fixture.sessionID,
		).Scan(&observed, &terminated, &events)
	}); err != nil {
		t.Fatal(err)
	}
	if observed != domain.SandboxObservedDeleted || !terminated || events != 1 {
		t.Fatalf("retained history = observed %q, terminated %v, events %d", observed, terminated, events)
	}
}

func TestOrgContextStillEnforcesTenantIsolation(t *testing.T) {
	first := newSandboxFixture(t, "iso-first")
	second := newSandboxFixture(t, "iso-second")
	ctx := context.Background()

	// The org context carries no membership check, so it must still be unable
	// to reach another tenant's rows through row-level security.
	if _, err := first.store.WorkerLaunchSpec(ctx, first.orgID, second.sessionID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant launch spec error = %v, want ErrNotFound", err)
	}
	if _, err := first.store.IssueAccessTicket(
		ctx, first.orgID, second.sessionID, "worker_bootstrap", []string{"worker:connect"}, time.Minute,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant ticket error = %v, want ErrNotFound", err)
	}
}

func TestAppendSessionEventIsVisibleOnTheSessionStream(t *testing.T) {
	fixture := newSandboxFixture(t, "events")
	ctx := context.Background()

	for _, input := range []struct {
		eventType string
		payload   json.RawMessage
	}{
		{"sandbox.provisioning", json.RawMessage(`{"provider":"nodeops"}`)},
		{"worker.connected", nil},
		{"agent.activity", json.RawMessage(`{"state":"active"}`)},
		{"workspace.changed", json.RawMessage(`{"path":"README.md"}`)},
		{"pull_request.created", json.RawMessage(`{"number":1}`)},
		{"pull_request.claimed", json.RawMessage(`{"number":1}`)},
		{"review.submitted", json.RawMessage(`{"pullRequestNumber":1}`)},
	} {
		if _, err := fixture.store.AppendSessionEvent(
			ctx, fixture.orgID, fixture.sessionID, input.eventType, input.payload,
		); err != nil {
			t.Fatalf("AppendSessionEvent(%q) error = %v", input.eventType, err)
		}
	}

	var types []string
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			`SELECT type FROM ao_events WHERE session_id = $1 ORDER BY sequence`,
			fixture.sessionID,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var eventType string
			if err := rows.Scan(&eventType); err != nil {
				return err
			}
			types = append(types, eventType)
		}
		return rows.Err()
	}); err != nil {
		t.Fatal(err)
	}
	wantTypes := []string{
		"sandbox.provisioning",
		"worker.connected",
		"agent.activity",
		"workspace.changed",
		"pull_request.created",
		"pull_request.claimed",
		"review.submitted",
	}
	if len(types) != len(wantTypes) {
		t.Fatalf("stored event count = %d, want %d (%v)", len(types), len(wantTypes), types)
	}
	for index, want := range wantTypes {
		if types[index] != want {
			t.Fatalf("stored event[%d] = %q, want %q", index, types[index], want)
		}
	}

	visible, hasMore, err := fixture.store.ListClientEvents(
		ctx, fixture.principal, fixture.orgID, fixture.sessionID, 0, 100,
	)
	if err != nil || hasMore {
		t.Fatalf("ListClientEvents() events=%v hasMore=%v error=%v", visible, hasMore, err)
	}
	if len(visible) != len(wantTypes) {
		t.Fatalf("client-visible event count = %d, want %d (%v)", len(visible), len(wantTypes), visible)
	}
	for index, want := range wantTypes {
		if visible[index].Type != want {
			t.Fatalf("client-visible event[%d] = %q, want %q", index, visible[index].Type, want)
		}
	}
}

// grantTestLease hands a fresh lease directly to owner, bypassing
// ClaimSandboxes's reconcile_after gate — RecordSandboxFailure schedules the
// next retry well into the future, and this test asserts on successive
// calls without actually waiting out that backoff.
func grantTestLease(t *testing.T, fixture sandboxFixture, owner string) {
	t.Helper()
	if err := fixture.store.withService(context.Background(), func(tx pgx.Tx) error {
		_, err := tx.Exec(
			context.Background(),
			`UPDATE ao_sandboxes
			SET reconcile_lease_owner = $2, reconcile_lease_until = now() + interval '1 minute'
			WHERE session_id = $1`,
			fixture.sessionID, owner,
		)
		return err
	}); err != nil {
		t.Fatalf("grant test lease: %v", err)
	}
}

func sandboxFailureState(t *testing.T, fixture sandboxFixture) (consecutiveFailures int, reconcileAfter time.Time) {
	t.Helper()
	if err := fixture.store.withOrg(context.Background(), fixture.orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(
			context.Background(),
			`SELECT consecutive_failures, reconcile_after FROM ao_sandboxes WHERE session_id = $1`,
			fixture.sessionID,
		).Scan(&consecutiveFailures, &reconcileAfter)
	}); err != nil {
		t.Fatalf("read sandbox failure state: %v", err)
	}
	return consecutiveFailures, reconcileAfter
}

func TestRecordSandboxFailureBacksOffExponentiallyAndCapsAtFiveMinutes(t *testing.T) {
	t.Parallel()
	fixture := newSandboxFixture(t, "sbx-failure-backoff")
	ctx := context.Background()
	owner := "reconciler-" + fixture.unique

	wantBackoffSeconds := []float64{15, 30, 60, 120, 240, 300, 300}
	for attempt, wantSeconds := range wantBackoffSeconds {
		grantTestLease(t, fixture, owner)
		before := time.Now()
		if err := fixture.store.RecordSandboxFailure(
			ctx, owner, fixture.orgID, fixture.sessionID, "env-x", "provider unavailable",
		); err != nil {
			t.Fatalf("attempt %d: record sandbox failure: %v", attempt+1, err)
		}
		consecutiveFailures, reconcileAfter := sandboxFailureState(t, fixture)
		if consecutiveFailures != attempt+1 {
			t.Fatalf("attempt %d: consecutive_failures = %d, want %d", attempt+1, consecutiveFailures, attempt+1)
		}
		gotSeconds := reconcileAfter.Sub(before).Seconds()
		if gotSeconds < wantSeconds-2 || gotSeconds > wantSeconds+2 {
			t.Fatalf("attempt %d: backoff = %.1fs, want ~%.0fs", attempt+1, gotSeconds, wantSeconds)
		}
	}

	// A successful observation resets the counter so a later, unrelated
	// failure starts the backoff over rather than inheriting the 5-minute cap.
	grantTestLease(t, fixture, owner)
	if err := fixture.store.UpdateSandboxObservation(
		ctx, owner, fixture.orgID, fixture.sessionID, "env-x", "running", "", time.Now().Add(time.Minute),
	); err != nil {
		t.Fatalf("update sandbox observation: %v", err)
	}
	consecutiveFailures, _ := sandboxFailureState(t, fixture)
	if consecutiveFailures != 0 {
		t.Fatalf("consecutive_failures after recovery = %d, want 0", consecutiveFailures)
	}
}
