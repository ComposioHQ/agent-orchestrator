package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	core "github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

func TestChangeDeliveryAgainstPostgres(t *testing.T) {
	runtimeURL := os.Getenv("AO_CLOUD_TEST_DATABASE_URL")
	migrationURL := os.Getenv("AO_CLOUD_TEST_MIGRATION_DATABASE_URL")
	runtimeRole := os.Getenv("AO_CLOUD_TEST_RUNTIME_DATABASE_ROLE")
	if runtimeURL == "" || migrationURL == "" || runtimeRole == "" {
		t.Skip("set AO_CLOUD_TEST_DATABASE_URL, AO_CLOUD_TEST_MIGRATION_DATABASE_URL, and AO_CLOUD_TEST_RUNTIME_DATABASE_ROLE")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := EnsureRuntimeRole(ctx, migrationURL, runtimeRole, "integration-runtime-password"); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, migrationURL, runtimeRole); err != nil {
		t.Fatal(err)
	}
	runtimeStore, err := Open(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	defer runtimeStore.Close()
	alice := createChangeTestTenant(t, ctx, runtimeStore, "alice")
	bob := createChangeTestTenant(t, ctx, runtimeStore, "bob")

	// The migration owner is used for this adapter test until the integration
	// branch's canonical runtime table registry grants the new 00060 tables.
	// FORCE RLS still applies, so all reads and writes exercise tenant policies.
	writer := newChangeTestStore(t, ctx, migrationURL, "ao-cdc-writer")
	hubOneStore := newChangeTestStore(t, ctx, migrationURL, "ao-cdc-hub-one")
	hubTwoStore := newChangeTestStore(t, ctx, migrationURL, "ao-cdc-hub-two")
	aliceCtx := tenant.WithIdentity(ctx, alice)
	bobCtx := tenant.WithIdentity(ctx, bob)

	t.Run("rollback and concurrent commits preserve cursor order", func(t *testing.T) {
		baseline, err := writer.LatestSeq(aliceCtx)
		if err != nil {
			t.Fatal(err)
		}
		first := beginChangeTestTx(t, aliceCtx, writer, alice)
		if err := NewChangeEventRecorder(first, alice.OrgID).RecordChange(aliceCtx, testPending("rolled-back")); err != nil {
			t.Fatal(err)
		}
		second := beginChangeTestTx(t, aliceCtx, writer, alice)
		secondRecorded := make(chan error, 1)
		go func() {
			secondRecorded <- NewChangeEventRecorder(second, alice.OrgID).RecordChange(aliceCtx, testPending("after-rollback"))
		}()
		select {
		case err := <-secondRecorded:
			t.Fatalf("second allocator did not wait for the org head lock: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
		if err := first.Rollback(aliceCtx); err != nil {
			t.Fatal(err)
		}
		if err := <-secondRecorded; err != nil {
			t.Fatal(err)
		}
		if err := second.Commit(aliceCtx); err != nil {
			t.Fatal(err)
		}
		events, err := writer.EventsAfter(aliceCtx, baseline, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(events) != 1 || events[0].Seq != baseline+1 || payloadName(t, events[0]) != "after-rollback" {
			t.Fatalf("events after rollback = %#v, want one event at %d", events, baseline+1)
		}

		third := beginChangeTestTx(t, aliceCtx, writer, alice)
		if err := NewChangeEventRecorder(third, alice.OrgID).RecordChange(aliceCtx, testPending("commit-first")); err != nil {
			t.Fatal(err)
		}
		fourth := beginChangeTestTx(t, aliceCtx, writer, alice)
		fourthRecorded := make(chan error, 1)
		go func() {
			fourthRecorded <- NewChangeEventRecorder(fourth, alice.OrgID).RecordChange(aliceCtx, testPending("commit-second"))
		}()
		select {
		case err := <-fourthRecorded:
			t.Fatalf("later commit allocated before prior commit: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
		if err := third.Commit(aliceCtx); err != nil {
			t.Fatal(err)
		}
		if err := <-fourthRecorded; err != nil {
			t.Fatal(err)
		}
		if err := fourth.Commit(aliceCtx); err != nil {
			t.Fatal(err)
		}
		events, err = writer.EventsAfter(aliceCtx, baseline+1, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(events) != 2 || events[0].Seq != baseline+2 || events[1].Seq != baseline+3 ||
			payloadName(t, events[0]) != "commit-first" || payloadName(t, events[1]) != "commit-second" {
			t.Fatalf("commit-ordered events = %#v", events)
		}
	})

	t.Run("tenant cursors are isolated and suppress duplicate advances", func(t *testing.T) {
		if err := recordChangeTestEvent(aliceCtx, writer, alice, testPending("alice-cursor")); err != nil {
			t.Fatal(err)
		}
		if err := recordChangeTestEvent(bobCtx, writer, bob, testPending("bob-cursor")); err != nil {
			t.Fatal(err)
		}
		aliceHead, err := writer.LatestSeq(aliceCtx)
		if err != nil {
			t.Fatal(err)
		}
		bobHead, err := writer.LatestSeq(bobCtx)
		if err != nil {
			t.Fatal(err)
		}
		if err := writer.AdvanceChangeCursor(aliceCtx, "notification-worker", aliceHead); err != nil {
			t.Fatal(err)
		}
		if err := writer.AdvanceChangeCursor(aliceCtx, "notification-worker", aliceHead-1); err != nil {
			t.Fatal(err)
		}
		if got, err := writer.LoadChangeCursor(aliceCtx, "notification-worker"); err != nil || got != aliceHead {
			t.Fatalf("Alice cursor = %d, %v; want %d", got, err, aliceHead)
		}
		if got, err := writer.LoadChangeCursor(bobCtx, "notification-worker"); err != nil || got != 0 {
			t.Fatalf("Bob observed Alice cursor = %d, %v", got, err)
		}
		if err := writer.AdvanceChangeCursor(bobCtx, "notification-worker", bobHead); err != nil {
			t.Fatal(err)
		}
		if got, err := writer.LoadChangeCursor(bobCtx, "notification-worker"); err != nil || got != bobHead {
			t.Fatalf("Bob cursor = %d, %v; want %d", got, err, bobHead)
		}
		aliceEvents, err := writer.EventsAfter(aliceCtx, 0, maxChangeEventBatch)
		if err != nil {
			t.Fatal(err)
		}
		requireNoOtherTenantEvent(t, aliceEvents, "bob-cursor")
		bobEvents, err := writer.EventsAfter(bobCtx, 0, maxChangeEventBatch)
		if err != nil {
			t.Fatal(err)
		}
		requireNoOtherTenantEvent(t, bobEvents, "alice-cursor")
	})

	t.Run("two instances catch up gaps and reconnect listener", func(t *testing.T) {
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		hubOne := NewEventHub(hubOneStore, EventHubConfig{
			PollInterval: 25 * time.Millisecond,
			ListenRetry:  750 * time.Millisecond,
			Logger:       logger,
		})
		hubTwo := NewEventHub(hubTwoStore, EventHubConfig{
			PollInterval: 25 * time.Millisecond,
			ListenRetry:  50 * time.Millisecond,
			Logger:       logger,
		})
		if err := hubOne.Start(ctx); err != nil {
			t.Fatal(err)
		}
		defer hubOne.Close()
		if err := hubTwo.Start(ctx); err != nil {
			t.Fatal(err)
		}
		defer hubTwo.Close()
		oneEvents := make(chan ports.ChangeEvent, 8)
		twoEvents := make(chan ports.ChangeEvent, 8)
		unsubscribeOne, err := hubOne.SubscribeChanges(aliceCtx, func(event ports.ChangeEvent) { oneEvents <- event })
		if err != nil {
			t.Fatal(err)
		}
		defer unsubscribeOne()
		unsubscribeTwo, err := hubTwo.SubscribeChanges(aliceCtx, func(event ports.ChangeEvent) { twoEvents <- event })
		if err != nil {
			t.Fatal(err)
		}
		defer unsubscribeTwo()
		waitForChangeListener(t, ctx, writer.pool, "ao-cdc-hub-one")
		waitForChangeListener(t, ctx, writer.pool, "ao-cdc-hub-two")

		if err := terminateChangeListeners(ctx, writer.pool, "ao-cdc-hub-one"); err != nil {
			t.Fatal(err)
		}
		if err := recordChangeTestEvent(aliceCtx, writer, alice, testPending("missed-notify")); err != nil {
			t.Fatal(err)
		}
		one := awaitNamedEvent(t, oneEvents, "missed-notify")
		two := awaitNamedEvent(t, twoEvents, "missed-notify")
		if one.Seq != two.Seq {
			t.Fatalf("instances received seq %d and %d", one.Seq, two.Seq)
		}
		hubOne.signal(alice.OrgID)
		select {
		case duplicate := <-oneEvents:
			t.Fatalf("hub redelivered cursor %d", duplicate.Seq)
		case <-time.After(100 * time.Millisecond):
		}
		waitForChangeListener(t, ctx, writer.pool, "ao-cdc-hub-one")
		if err := recordChangeTestEvent(aliceCtx, writer, alice, testPending("after-reconnect")); err != nil {
			t.Fatal(err)
		}
		awaitNamedEvent(t, oneEvents, "after-reconnect")
		awaitNamedEvent(t, twoEvents, "after-reconnect")

		notifications, unsubscribeNotifications, err := hubOne.SubscribeNotifications(aliceCtx, "project")
		if err != nil {
			t.Fatal(err)
		}
		defer unsubscribeNotifications()
		record := core.NotificationRecord{
			ID: "ntf_pg", SessionID: "session", ProjectID: "project",
			Type: core.NotificationNeedsInput, Title: "Needs input",
			Status: core.NotificationUnread, CreatedAt: time.Now().UTC(),
		}
		payload, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		if err := recordChangeTestEvent(aliceCtx, writer, alice, ports.PendingChangeEvent{
			ProjectID: "project", SessionID: "session",
			Type: ports.ChangeEventNotificationCreated, Payload: payload,
		}); err != nil {
			t.Fatal(err)
		}
		select {
		case event := <-notifications:
			if event.Kind != core.NotificationCreated || event.Record.ID != record.ID {
				t.Fatalf("notification event = %#v", event)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("timed out waiting for durable notification fan-out")
		}
	})
}

func createChangeTestTenant(t *testing.T, ctx context.Context, store *Store, name string) tenant.Identity {
	t.Helper()
	suffix := fmt.Sprintf("%s-%d", name, time.Now().UnixNano())
	principal, err := store.UpsertGoogleUser(ctx, domain.Principal{
		Provider: "google", ExternalID: suffix, Email: suffix + "@example.com", DisplayName: name,
	})
	if err != nil {
		t.Fatal(err)
	}
	memberships, err := store.ListMemberships(ctx, principal)
	if err != nil || len(memberships) != 1 {
		t.Fatalf("memberships = %#v, %v", memberships, err)
	}
	return tenant.Identity{
		OrgID: memberships[0].OrgID, OrgSlug: memberships[0].OrgSlug,
		UserID: principal.UserID, Role: memberships[0].Role,
	}
}

func newChangeTestStore(t *testing.T, ctx context.Context, databaseURL, applicationName string) *Store {
	t.Helper()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["application_name"] = applicationName
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return &Store{pool: pool}
}

func beginChangeTestTx(t *testing.T, ctx context.Context, store *Store, identity tenant.Identity) pgx.Tx {
	t.Helper()
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx,
		`SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`,
		identity.UserID, identity.OrgID,
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	return tx
}

func recordChangeTestEvent(ctx context.Context, store *Store, identity tenant.Identity, pending ports.PendingChangeEvent) error {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`,
		identity.UserID, identity.OrgID,
	); err != nil {
		return err
	}
	if err := NewChangeEventRecorder(tx, identity.OrgID).RecordChange(ctx, pending); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func testPending(name string) ports.PendingChangeEvent {
	payload, _ := json.Marshal(map[string]string{"name": name})
	return ports.PendingChangeEvent{
		ProjectID: "project", SessionID: "session",
		Type: ports.ChangeEventSessionUpdated, Payload: payload,
	}
}

func payloadName(t *testing.T, event ports.ChangeEvent) string {
	t.Helper()
	var payload struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Name
}

func awaitNamedEvent(t *testing.T, events <-chan ports.ChangeEvent, name string) ports.ChangeEvent {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case event := <-events:
			if payloadName(t, event) == name {
				return event
			}
		case <-deadline:
			t.Fatalf("timed out waiting for event %q", name)
		}
	}
}

func waitForChangeListener(t *testing.T, ctx context.Context, pool *pgxpool.Pool, applicationName string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM pg_stat_activity
			 WHERE application_name = $1 AND query = 'LISTEN ao_change_events'`,
			applicationName,
		).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("listener %q did not connect", applicationName)
}

func terminateChangeListeners(ctx context.Context, pool *pgxpool.Pool, applicationName string) error {
	rows, err := pool.Query(ctx,
		`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
		 WHERE application_name = $1 AND query = 'LISTEN ao_change_events'`,
		applicationName,
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	terminated := false
	for rows.Next() {
		var ok bool
		if err := rows.Scan(&ok); err != nil {
			return err
		}
		terminated = terminated || ok
	}
	if !terminated {
		return fmt.Errorf("listener %q was not terminated", applicationName)
	}
	return rows.Err()
}

func requireNoOtherTenantEvent(t *testing.T, events []ports.ChangeEvent, forbidden string) {
	t.Helper()
	for _, event := range events {
		if strings.Contains(string(event.Payload), forbidden) {
			t.Fatalf("tenant observed foreign event: %s", event.Payload)
		}
	}
}
