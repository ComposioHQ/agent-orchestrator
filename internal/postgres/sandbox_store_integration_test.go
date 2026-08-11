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

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type sandboxFixture struct {
	store     *Store
	pool      *pgxpool.Pool
	principal domain.Principal
	orgID     string
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
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

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
	session, err := store.CreateSession(ctx, principal, orgID, slug+"-session-key", domain.CreateSession{
		ProjectID:   project.ID,
		Kind:        "worker",
		Harness:     "claude-code",
		DisplayName: "Sandbox fixture session",
		Provider:    "nodeops",
		ResourceProfile: json.RawMessage(
			`{"provider":"nodeops","nodeOps":{"defaultShape":"s-4vcpu-8gb","defaultRootFs":"devbox:1"}}`,
		),
		BootstrapContext: json.RawMessage(`{"provider":"nodeops"}`),
		AutoStopMinutes:  30,
		Release:          "test-release",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	// Park every other sandbox so this fixture's row is the only one due for
	// reconciliation. The test database is disposable and shared across runs.
	if _, err := pool.Exec(
		ctx,
		`UPDATE ao_sandboxes
		SET reconcile_after = now() + interval '1 day'
		WHERE session_id <> $1`,
		session.ID,
	); err != nil {
		t.Fatalf("quiesce other sandboxes: %v", err)
	}

	return sandboxFixture{
		store:     store,
		pool:      pool,
		principal: principal,
		orgID:     orgID,
		sessionID: session.ID,
		unique:    unique,
	}
}

// makeDue clears any scheduled backoff so the next claim sees the row. A
// heartbeat pushes the next reconcile 30 seconds out, which a test should not
// wait for.
func (f sandboxFixture) makeDue(t *testing.T) {
	t.Helper()
	if _, err := f.pool.Exec(
		context.Background(),
		`UPDATE ao_sandboxes SET reconcile_after = now() WHERE session_id = $1`,
		f.sessionID,
	); err != nil {
		t.Fatalf("make sandbox due: %v", err)
	}
}

func (f sandboxFixture) claimOwn(t *testing.T, owner string) domain.Sandbox {
	t.Helper()
	claimed, err := f.store.ClaimSandboxes(context.Background(), owner, 20, 30*time.Second)
	if err != nil {
		t.Fatalf("ClaimSandboxes() error = %v", err)
	}
	for _, record := range claimed {
		if record.SessionID == f.sessionID {
			return record
		}
	}
	t.Fatalf("the fixture sandbox was not claimed; got %d other rows", len(claimed))
	return domain.Sandbox{}
}

func TestClaimSandboxesLeasesExclusively(t *testing.T) {
	fixture := newSandboxFixture(t, "claim")
	ctx := context.Background()

	record := fixture.claimOwn(t, "owner-a")
	if record.OrgID != fixture.orgID || record.Provider != "nodeops" {
		t.Fatalf("claimed sandbox = %+v, want the fixture row", record)
	}
	if record.ObservedState != domain.SandboxObservedRequested {
		t.Errorf("observed state = %q, want requested", record.ObservedState)
	}

	// A second reconciler must not see a row that is still leased.
	second, err := fixture.store.ClaimSandboxes(ctx, "owner-b", 20, 30*time.Second)
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

	var mu sync.Mutex
	seen := map[string]int{}
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
			}
		}("owner-" + string(rune('a'+i)))
	}
	wait.Wait()

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

	fixture.makeDue(t)
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
	if _, err := fixture.pool.Exec(
		ctx,
		`UPDATE ao_access_tickets
		SET created_at = now() - interval '10 minutes',
			expires_at = now() - interval '1 minute'
		WHERE session_id = $1`,
		fixture.sessionID,
	); err != nil {
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
	if err := fixture.pool.QueryRow(
		ctx,
		`SELECT observed_state, worker_last_seen_at FROM ao_sandboxes WHERE session_id = $1`,
		fixture.sessionID,
	).Scan(&observedState, &seenAt); err != nil {
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

func TestCountActiveSandboxesAndSessionDeletion(t *testing.T) {
	fixture := newSandboxFixture(t, "quota")
	ctx := context.Background()

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
	// A sandbox marked for deletion no longer counts against the quota, but its
	// row survives until the provider teardown actually completes.
	count, err = fixture.store.CountActiveSandboxes(ctx, fixture.principal, fixture.orgID)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("active sandboxes after delete intent = %d, want 0", count)
	}

	if err := fixture.store.DeleteSandboxSession(ctx, fixture.orgID, fixture.sessionID); err != nil {
		t.Fatalf("DeleteSandboxSession() error = %v", err)
	}
	var remaining int
	if err := fixture.pool.QueryRow(
		ctx, `SELECT count(*) FROM ao_sandboxes WHERE session_id = $1`, fixture.sessionID,
	).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("sandbox rows after session deletion = %d, want 0", remaining)
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

	if _, err := fixture.store.AppendSessionEvent(
		ctx, fixture.orgID, fixture.sessionID, "sandbox.provisioning",
		json.RawMessage(`{"provider":"nodeops"}`),
	); err != nil {
		t.Fatalf("AppendSessionEvent() error = %v", err)
	}
	if _, err := fixture.store.AppendSessionEvent(
		ctx, fixture.orgID, fixture.sessionID, "worker.connected", nil,
	); err != nil {
		t.Fatalf("AppendSessionEvent() with an empty payload error = %v", err)
	}

	var types []string
	rows, err := fixture.pool.Query(
		ctx,
		`SELECT type FROM ao_events WHERE session_id = $1 ORDER BY sequence`,
		fixture.sessionID,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var eventType string
		if err := rows.Scan(&eventType); err != nil {
			t.Fatal(err)
		}
		types = append(types, eventType)
	}
	if len(types) != 2 || types[0] != "sandbox.provisioning" || types[1] != "worker.connected" {
		t.Fatalf("session events = %v, want the two lifecycle events in order", types)
	}
}
