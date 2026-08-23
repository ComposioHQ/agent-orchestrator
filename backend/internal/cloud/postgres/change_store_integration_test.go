package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
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

	admin := newChangeTestStore(t, ctx, migrationURL, "ao-cdc-migration-owner")
	createChangeTriggerFixtures(t, ctx, admin.pool)
	grantChangeTestRuntimeAccess(t, ctx, admin.pool, runtimeRole)
	writer := openChangeRuntimeStore(t, ctx, runtimeURL, "ao-cdc-writer")
	hubOneStore := openChangeRuntimeStore(t, ctx, runtimeURL, "ao-cdc-hub-one")
	hubTwoStore := openChangeRuntimeStore(t, ctx, runtimeURL, "ao-cdc-hub-two")
	requireProductionChangeTriggers(t, ctx, writer.pool)
	aliceCtx := tenant.WithIdentity(ctx, alice)
	bobCtx := tenant.WithIdentity(ctx, bob)

	t.Run("product triggers capture direct SQL and rollback atomically", func(t *testing.T) {
		if !productChangeTablesPresent(t, ctx, writer.pool) {
			t.Skip("product-store migrations are not present on this branch")
		}
		baseline, err := writer.LatestSeq(aliceCtx)
		if err != nil {
			t.Fatal(err)
		}
		tx := beginChangeTestTx(t, aliceCtx, writer, alice)
		now := time.Now().UTC()
		statements := []string{
			`INSERT INTO ao_projects (org_id, id, owner_user_id, path, registered_at)
			 VALUES ($1, 'product-project', $2, '/tmp/product-project', $3)`,
			`INSERT INTO ao_sessions (
				org_id, id, project_id, owner_user_id, num, activity_last_at, created_at, updated_at
			 ) VALUES ($1, 'product-session', 'product-project', $2, 1, $3, $3, $3)`,
			`INSERT INTO ao_pull_requests (org_id, owner_user_id, url, session_id, updated_at)
			 VALUES ($1, $2, 'https://example.test/pr/1', 'product-session', $3)`,
			`INSERT INTO ao_pull_request_checks (
				org_id, owner_user_id, pr_url, name, commit_hash, status, created_at
			 ) VALUES ($1, $2, 'https://example.test/pr/1', 'test', 'abc', 'passed', $3)`,
			`INSERT INTO ao_pull_request_review_threads (
				org_id, owner_user_id, pr_url, thread_id, resolved, updated_at
			 ) VALUES ($1, $2, 'https://example.test/pr/1', 'thread-1', false, $3)`,
			`INSERT INTO ao_pull_request_reviews (
				org_id, owner_user_id, pr_url, review_id, state, submitted_at
			 ) VALUES ($1, $2, 'https://example.test/pr/1', 'review-1', 'approved', $3)`,
			`INSERT INTO ao_notifications (
				org_id, owner_user_id, id, session_id, project_id, type, title, created_at
			 ) VALUES ($1, $2, 'notification-1', 'product-session', 'product-project',
			           'needs_input', 'Needs input', $3)`,
		}
		for _, statement := range statements {
			if _, err := tx.Exec(aliceCtx, statement, alice.OrgID, alice.UserID, now); err != nil {
				_ = tx.Rollback(aliceCtx)
				t.Fatal(err)
			}
		}
		if err := tx.Commit(aliceCtx); err != nil {
			t.Fatal(err)
		}
		events, err := writer.EventsAfter(aliceCtx, baseline, 20)
		if err != nil {
			t.Fatal(err)
		}
		wantTypes := map[ports.ChangeEventType]bool{
			ports.ChangeEventSessionCreated:      false,
			ports.ChangeEventPRCreated:           false,
			ports.ChangeEventPRCheckRecorded:     false,
			ports.ChangeEventPRReviewThreadAdded: false,
			ports.ChangeEventReviewRunCreated:    false,
			ports.ChangeEventNotificationCreated: false,
		}
		for _, event := range events {
			if _, ok := wantTypes[event.Type]; ok {
				wantTypes[event.Type] = true
			}
		}
		for eventType, found := range wantTypes {
			if !found {
				t.Fatalf("direct SQL did not emit %s: %#v", eventType, events)
			}
		}
		head, err := writer.LatestSeq(aliceCtx)
		if err != nil {
			t.Fatal(err)
		}
		mutated := beginChangeTestTx(t, aliceCtx, writer, alice)
		if _, err := mutated.Exec(aliceCtx,
			`UPDATE ao_pull_requests SET pr_state = 'merged', updated_at = now()
			 WHERE org_id = $1 AND owner_user_id = $2 AND url = 'https://example.test/pr/1'`,
			alice.OrgID, alice.UserID,
		); err != nil {
			t.Fatal(err)
		}
		if _, err := mutated.Exec(aliceCtx,
			`UPDATE ao_pull_request_reviews SET state = 'changes_requested'
			 WHERE org_id = $1 AND owner_user_id = $2
			   AND pr_url = 'https://example.test/pr/1' AND review_id = 'review-1'`,
			alice.OrgID, alice.UserID,
		); err != nil {
			t.Fatal(err)
		}
		if err := mutated.Commit(aliceCtx); err != nil {
			t.Fatal(err)
		}
		mutations, err := writer.EventsAfter(aliceCtx, head, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(mutations) != 2 || mutations[0].Type != ports.ChangeEventPRUpdated || mutations[1].Type != ports.ChangeEventReviewRunUpdated {
			t.Fatalf("raw update events = %#v", mutations)
		}
		head = mutations[len(mutations)-1].Seq
		rolledBack := beginChangeTestTx(t, aliceCtx, writer, alice)
		if _, err := rolledBack.Exec(aliceCtx,
			`UPDATE ao_sessions SET activity_state = 'active', updated_at = now()
			 WHERE org_id = $1 AND owner_user_id = $2 AND id = 'product-session'`,
			alice.OrgID, alice.UserID,
		); err != nil {
			t.Fatal(err)
		}
		if err := rolledBack.Rollback(aliceCtx); err != nil {
			t.Fatal(err)
		}
		if afterRollback, err := writer.LatestSeq(aliceCtx); err != nil || afterRollback != head {
			t.Fatalf("head after product rollback = %d, %v; want %d", afterRollback, err, head)
		}
	})

	t.Run("rollback and concurrent commits preserve cursor order", func(t *testing.T) {
		baseline, err := writer.LatestSeq(aliceCtx)
		if err != nil {
			t.Fatal(err)
		}
		first := beginChangeTestTx(t, aliceCtx, writer, alice)
		if err := insertChangeTestFact(aliceCtx, first, alice, "rolled-back"); err != nil {
			t.Fatal(err)
		}
		second := beginChangeTestTx(t, aliceCtx, writer, alice)
		secondCommitted := make(chan error, 1)
		go func() {
			if err := insertChangeTestFact(aliceCtx, second, alice, "after-rollback"); err != nil {
				secondCommitted <- err
				return
			}
			secondCommitted <- second.Commit(aliceCtx)
		}()
		select {
		case err := <-secondCommitted:
			t.Fatalf("later writer committed before earlier rollback: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
		if err := first.Rollback(aliceCtx); err != nil {
			t.Fatal(err)
		}
		if err := <-secondCommitted; err != nil {
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
		if err := insertChangeTestFact(aliceCtx, third, alice, "commit-first"); err != nil {
			t.Fatal(err)
		}
		fourth := beginChangeTestTx(t, aliceCtx, writer, alice)
		fourthCommitted := make(chan error, 1)
		go func() {
			if err := insertChangeTestFact(aliceCtx, fourth, alice, "commit-second"); err != nil {
				fourthCommitted <- err
				return
			}
			fourthCommitted <- fourth.Commit(aliceCtx)
		}()
		select {
		case err := <-fourthCommitted:
			t.Fatalf("later writer committed before prior commit: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
		if err := third.Commit(aliceCtx); err != nil {
			t.Fatal(err)
		}
		if err := <-fourthCommitted; err != nil {
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
		if _, err := writer.LatestSeq(context.Background()); !errors.Is(err, tenant.ErrNoTenant) {
			t.Fatalf("tenantless latest sequence error = %v, want ErrNoTenant", err)
		}
		if _, err := writer.EventsAfter(context.Background(), 0, 1); !errors.Is(err, tenant.ErrNoTenant) {
			t.Fatalf("tenantless replay error = %v, want ErrNoTenant", err)
		}
		if _, err := writer.LoadChangeCursor(context.Background(), "notification-worker"); !errors.Is(err, tenant.ErrNoTenant) {
			t.Fatalf("tenantless cursor error = %v, want ErrNoTenant", err)
		}
		if err := recordChangeTestFact(aliceCtx, writer, alice, "alice-cursor"); err != nil {
			t.Fatal(err)
		}
		if err := recordChangeTestFact(bobCtx, writer, bob, "bob-cursor"); err != nil {
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

		forged := alice
		forged.OrgID = bob.OrgID
		forgedCtx := tenant.WithIdentity(ctx, forged)
		forgedEvents, err := writer.EventsAfter(forgedCtx, 0, maxChangeEventBatch)
		if err != nil {
			t.Fatal(err)
		}
		if len(forgedEvents) != 0 {
			t.Fatalf("cross-tenant principal observed events: %#v", forgedEvents)
		}
		if err := writer.AdvanceChangeCursor(forgedCtx, "notification-worker", bobHead); err == nil {
			t.Fatal("cross-tenant principal advanced Bob's cursor")
		}
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
		if err := recordChangeTestFact(aliceCtx, writer, alice, "missed-notify"); err != nil {
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
		if err := recordChangeTestFact(aliceCtx, writer, alice, "after-reconnect"); err != nil {
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
		if err := recordChangeTestNotification(aliceCtx, writer, alice, record); err != nil {
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
		if err := resolveChangeTestNotification(aliceCtx, writer, alice, record.ID); err != nil {
			t.Fatal(err)
		}
		select {
		case event := <-notifications:
			if event.Kind != core.NotificationResolved || event.Record.ID != record.ID || event.Record.ResolvedAt.IsZero() {
				t.Fatalf("resolved notification event = %#v", event)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("timed out waiting for durable notification resolution")
		}
	})
}

func productChangeTablesPresent(t *testing.T, ctx context.Context, pool *pgxpool.Pool) bool {
	t.Helper()
	var present bool
	if err := pool.QueryRow(ctx, `
		SELECT to_regclass('public.ao_sessions') IS NOT NULL
		   AND to_regclass('public.ao_projects') IS NOT NULL
		   AND to_regclass('public.ao_pull_requests') IS NOT NULL
		   AND to_regclass('public.ao_pull_request_checks') IS NOT NULL
		   AND to_regclass('public.ao_pull_request_reviews') IS NOT NULL
		   AND to_regclass('public.ao_pull_request_review_threads') IS NOT NULL
		   AND to_regclass('public.ao_notifications') IS NOT NULL
	`).Scan(&present); err != nil {
		t.Fatal(err)
	}
	return present
}

func requireProductionChangeTriggers(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	wants := []struct {
		table    string
		triggers []string
	}{
		{"ao_sessions", []string{"ao_sessions_change_created", "ao_sessions_change_updated"}},
		{"ao_pull_requests", []string{"ao_pull_requests_change_created", "ao_pull_requests_change_updated", "ao_pull_requests_change_session"}},
		{"ao_pull_request_checks", []string{"ao_pull_request_checks_change_inserted", "ao_pull_request_checks_change_updated"}},
		{"ao_pull_request_review_threads", []string{"ao_pull_request_review_threads_change_added", "ao_pull_request_review_threads_change_resolved"}},
		{"ao_pull_request_reviews", []string{"ao_pull_request_reviews_change_created", "ao_pull_request_reviews_change_updated"}},
		{"ao_notifications", []string{"ao_notifications_change_created", "ao_notifications_change_resolved"}},
	}
	for _, want := range wants {
		for _, trigger := range want.triggers {
			var exists bool
			if err := pool.QueryRow(ctx, `
				SELECT EXISTS (
					SELECT 1
					FROM pg_trigger trigger
					JOIN pg_class relation ON relation.oid = trigger.tgrelid
					WHERE relation.relname = $1
					  AND trigger.tgname = $2
					  AND NOT trigger.tgisinternal
				)`, want.table, trigger).Scan(&exists); err != nil {
				t.Fatal(err)
			}
			if !exists {
				t.Fatalf("covered product table %s is missing trigger %s", want.table, trigger)
			}
		}
	}
	for _, table := range []string{
		"ao_projects", "ao_workspace_repos", "ao_session_worktrees",
		"ao_conversations", "ao_conversation_provider_events",
		"ao_pull_request_comments", "ao_app_settings", "ao_agent_inventory_cache",
	} {
		var count int
		if err := pool.QueryRow(ctx, `
			SELECT count(*)
			FROM pg_trigger trigger
			JOIN pg_class relation ON relation.oid = trigger.tgrelid
			WHERE relation.relname = $1
			  AND trigger.tgname LIKE 'ao\_%\_change\_%' ESCAPE '\'
			  AND NOT trigger.tgisinternal`, table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("non-contract table %s has %d change triggers", table, count)
		}
	}
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

func createChangeTriggerFixtures(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		DROP TABLE IF EXISTS ao_change_event_test_notifications;
		DROP TABLE IF EXISTS ao_change_event_test_facts;
		CREATE TABLE ao_change_event_test_facts (
			org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
			id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			name TEXT NOT NULL,
			PRIMARY KEY (org_id, id)
		);
		ALTER TABLE ao_change_event_test_facts ENABLE ROW LEVEL SECURITY;
		ALTER TABLE ao_change_event_test_facts FORCE ROW LEVEL SECURITY;
		CREATE POLICY ao_change_event_test_facts_tenant ON ao_change_event_test_facts
			USING (org_id = ao_current_org_id() AND ao_is_org_member(org_id, ao_current_user_id()))
			WITH CHECK (org_id = ao_current_org_id() AND ao_is_org_member(org_id, ao_current_user_id()));
		CREATE TRIGGER ao_change_event_test_facts_capture
			AFTER INSERT OR UPDATE ON ao_change_event_test_facts
			FOR EACH ROW EXECUTE FUNCTION ao_capture_change_event(
				'session_updated', 'project_id', 'session_id', 'identity'
			);

		CREATE TABLE ao_change_event_test_notifications (
			org_id UUID NOT NULL REFERENCES ao_organizations(id) ON DELETE CASCADE,
			id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			pr_url TEXT NOT NULL DEFAULT '',
			type TEXT NOT NULL,
			title TEXT NOT NULL,
			body TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL,
			resolved_at TIMESTAMPTZ,
			PRIMARY KEY (org_id, id)
		);
		ALTER TABLE ao_change_event_test_notifications ENABLE ROW LEVEL SECURITY;
		ALTER TABLE ao_change_event_test_notifications FORCE ROW LEVEL SECURITY;
		CREATE POLICY ao_change_event_test_notifications_tenant ON ao_change_event_test_notifications
			USING (org_id = ao_current_org_id() AND ao_is_org_member(org_id, ao_current_user_id()))
			WITH CHECK (org_id = ao_current_org_id() AND ao_is_org_member(org_id, ao_current_user_id()));
		CREATE TRIGGER ao_change_event_test_notifications_created
			AFTER INSERT ON ao_change_event_test_notifications
			FOR EACH ROW EXECUTE FUNCTION ao_capture_change_event(
				'notification_created', 'project_id', 'session_id', 'notification'
			);
		CREATE TRIGGER ao_change_event_test_notifications_resolved
			AFTER UPDATE OF resolved_at ON ao_change_event_test_notifications
			FOR EACH ROW
			WHEN (OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL)
			EXECUTE FUNCTION ao_capture_change_event(
				'notification_resolved', 'project_id', 'session_id', 'notification'
			);
	`)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `
			DROP TABLE IF EXISTS ao_change_event_test_notifications;
			DROP TABLE IF EXISTS ao_change_event_test_facts;
		`)
	})

	expected := []struct {
		table   string
		trigger string
	}{
		{"ao_change_event_test_facts", "ao_change_event_test_facts_capture"},
		{"ao_change_event_test_notifications", "ao_change_event_test_notifications_created"},
		{"ao_change_event_test_notifications", "ao_change_event_test_notifications_resolved"},
	}
	for _, want := range expected {
		var exists bool
		if err := pool.QueryRow(ctx,
			`SELECT EXISTS (
			     SELECT 1
			     FROM pg_trigger trigger
			     JOIN pg_class relation ON relation.oid = trigger.tgrelid
			     WHERE relation.relname = $1
			       AND trigger.tgname = $2
			       AND NOT trigger.tgisinternal
			 )`,
			want.table, want.trigger,
		).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Fatalf("covered table %s is missing trigger %s", want.table, want.trigger)
		}
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

func openChangeRuntimeStore(t *testing.T, ctx context.Context, databaseURL, applicationName string) *Store {
	t.Helper()
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("application_name", applicationName)
	parsed.RawQuery = query.Encode()
	store, err := Open(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	return store
}

func grantChangeTestRuntimeAccess(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	runtimeRole string,
) {
	t.Helper()
	role := pgx.Identifier{runtimeRole}.Sanitize()
	statements := []string{
		"GRANT SELECT, INSERT, UPDATE ON ao_change_heads TO " + role,
		"GRANT SELECT, INSERT ON ao_change_log TO " + role,
		"GRANT SELECT, INSERT, UPDATE ON ao_change_cursors TO " + role,
		"GRANT SELECT, INSERT, UPDATE ON ao_change_event_test_facts TO " + role,
		"GRANT SELECT, INSERT, UPDATE ON ao_change_event_test_notifications TO " + role,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	// The centralized runtimeTables update belongs to the integration owner.
	// Grant the already-migrated source tables only inside this isolated test
	// database so direct mutations still execute as the restricted runtime role.
	productTables := []string{
		"ao_projects", "ao_workspace_repos", "ao_sessions",
		"ao_conversations", "ao_conversation_provider_events",
		"ao_pull_requests", "ao_pull_request_checks", "ao_pull_request_comments",
		"ao_pull_request_reviews", "ao_pull_request_review_threads", "ao_notifications",
	}
	for _, table := range productTables {
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT to_regclass('public.' || $1) IS NOT NULL`, table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			continue
		}
		statement := "GRANT SELECT, INSERT, UPDATE, DELETE ON " + pgx.Identifier{table}.Sanitize() + " TO " + role
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
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

func recordChangeTestFact(ctx context.Context, store *Store, identity tenant.Identity, name string) error {
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
	if err := insertChangeTestFact(ctx, tx, identity, name); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func insertChangeTestFact(ctx context.Context, tx pgx.Tx, identity tenant.Identity, name string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO ao_change_event_test_facts (
		     org_id, id, project_id, session_id, name
		 ) VALUES ($1, $2, 'project', 'session', $3)`,
		identity.OrgID,
		fmt.Sprintf("fact-%d", time.Now().UnixNano()),
		name,
	)
	return err
}

func recordChangeTestNotification(
	ctx context.Context,
	store *Store,
	identity tenant.Identity,
	record core.NotificationRecord,
) error {
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
	_, err = tx.Exec(ctx,
		`INSERT INTO ao_change_event_test_notifications (
		     org_id, id, session_id, project_id, pr_url, type,
		     title, body, status, created_at, resolved_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)`,
		identity.OrgID, record.ID, record.SessionID, record.ProjectID,
		record.PRURL, record.Type, record.Title, record.Body, record.Status, record.CreatedAt,
	)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func resolveChangeTestNotification(
	ctx context.Context,
	store *Store,
	identity tenant.Identity,
	id string,
) error {
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
	if _, err := tx.Exec(ctx,
		`UPDATE ao_change_event_test_notifications
		 SET resolved_at = now()
		 WHERE org_id = $1 AND id = $2`, identity.OrgID, id,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
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
