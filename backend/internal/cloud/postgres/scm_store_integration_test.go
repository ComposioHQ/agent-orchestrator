package postgres

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm"
)

type scmWebhookPGHarness struct {
	store  *Store
	admin  *pgxpool.Pool
	prefix string
}

func newSCMWebhookPGHarness(t *testing.T) *scmWebhookPGHarness {
	t.Helper()
	runtimeURL := os.Getenv("AO_CLOUD_TEST_DATABASE_URL")
	migrationURL := os.Getenv("AO_CLOUD_TEST_MIGRATION_DATABASE_URL")
	runtimeRole := os.Getenv("AO_CLOUD_TEST_RUNTIME_DATABASE_ROLE")
	if runtimeURL == "" || migrationURL == "" || runtimeRole == "" {
		t.Skip("set AO_CLOUD_TEST_DATABASE_URL, AO_CLOUD_TEST_MIGRATION_DATABASE_URL, and AO_CLOUD_TEST_RUNTIME_DATABASE_ROLE")
	}
	ctx := context.Background()
	if err := EnsureRuntimeRole(ctx, migrationURL, runtimeRole, "integration-runtime-password"); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, migrationURL, runtimeRole); err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.New(ctx, migrationURL)
	if err != nil {
		t.Fatal(err)
	}
	role := pgx.Identifier{runtimeRole}.Sanitize()
	_, err = admin.Exec(ctx, `GRANT EXECUTE ON FUNCTION
		ao_scm_ingest_and_claim_webhook(TEXT, TEXT, TEXT, BYTEA, TEXT, TEXT),
		ao_scm_claim_due_webhooks(TEXT, INTEGER),
		ao_scm_finish_webhook(TEXT, TEXT, UUID, TEXT, TEXT),
		ao_scm_prune_webhooks(INTERVAL) TO `+role)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	store, err := Open(ctx, runtimeURL)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	harness := &scmWebhookPGHarness{
		store: store, admin: admin,
		prefix: "scm-lifecycle-" + uuid.NewString(),
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(),
			`DELETE FROM ao_scm_webhook_deliveries WHERE delivery_id LIKE $1`, harness.prefix+"%")
		store.Close()
		admin.Close()
	})
	return harness
}

func (h *scmWebhookPGHarness) deliveryID(suffix string) string {
	return h.prefix + "-" + suffix
}

func (h *scmWebhookPGHarness) receipt(id string) domain.SCMWebhookReceipt {
	return domain.SCMWebhookReceipt{
		Provider: domain.SCMProviderGitHub, DeliveryID: id, Event: "pull_request",
		Body:           []byte(`{"installation":{"id":55},"repository":{"full_name":"acme/widgets"},"pull_request":{"number":7}}`),
		Classification: domain.SCMWebhookClassificationObservation,
	}
}

func TestSCMWebhookLifecycleAgainstPostgres(t *testing.T) {
	h := newSCMWebhookPGHarness(t)
	ctx := context.Background()

	t.Run("clean runtime role is default deny", func(t *testing.T) {
		var count int
		err := h.store.pool.QueryRow(ctx, `SELECT count(*) FROM ao_scm_webhook_deliveries`).Scan(&count)
		if err == nil {
			t.Fatal("runtime role could read the webhook ledger directly")
		}
		if !strings.Contains(err.Error(), "permission denied") {
			t.Fatalf("direct read error = %v", err)
		}
	})

	t.Run("atomic concurrent ingest has no bodyless dedup row", func(t *testing.T) {
		id := h.deliveryID("atomic")
		receipt := h.receipt(id)
		const callers = 12
		claims := make(chan domain.SCMWebhookClaim, callers)
		errs := make(chan error, callers)
		var wg sync.WaitGroup
		for range callers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				claim, err := h.store.IngestAndClaimSCMWebhook(ctx, receipt)
				claims <- claim
				errs <- err
			}()
		}
		wg.Wait()
		close(claims)
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatal(err)
			}
		}
		first, claimed := 0, 0
		for claim := range claims {
			if claim.FirstReceipt {
				first++
			}
			if claim.Claimed {
				claimed++
			}
			if len(claim.Body) == 0 {
				t.Fatal("atomic ingest returned a bodyless delivery")
			}
		}
		if first != 1 || claimed != 1 {
			t.Fatalf("first receipts = %d, claimed = %d", first, claimed)
		}
		var rows, bodyBytes int
		if err := h.admin.QueryRow(ctx,
			`SELECT count(*), max(octet_length(body)) FROM ao_scm_webhook_deliveries WHERE delivery_id = $1`, id,
		).Scan(&rows, &bodyBytes); err != nil {
			t.Fatal(err)
		}
		if rows != 1 || bodyBytes == 0 {
			t.Fatalf("rows = %d, body bytes = %d", rows, bodyBytes)
		}

		invalid := h.receipt(h.deliveryID("invalid-atomic"))
		invalid.Classification = domain.SCMWebhookClassificationMalformed
		if _, err := h.store.IngestAndClaimSCMWebhook(ctx, invalid); err == nil {
			t.Fatal("inconsistent terminal receipt unexpectedly committed")
		}
		if err := h.admin.QueryRow(ctx,
			`SELECT count(*) FROM ao_scm_webhook_deliveries WHERE delivery_id = $1`, invalid.DeliveryID,
		).Scan(&rows); err != nil || rows != 0 {
			t.Fatalf("failed atomic ingest rows = %d, error = %v", rows, err)
		}
	})

	t.Run("malformed JSON is terminal and never due", func(t *testing.T) {
		secret := []byte("real-pg-webhook-secret")
		processor, err := scm.NewWebhookProcessor(secret, h.store, noopSCMObservationSink{})
		if err != nil {
			t.Fatal(err)
		}
		id := h.deliveryID("malformed")
		body := []byte(`{"broken"`)
		result, err := processor.Process(ctx, "pull_request", id, webhookSignature(secret, body), body)
		if err != nil || !result.Durable || !result.Terminal {
			t.Fatalf("result = %#v, error = %v", result, err)
		}
		claims, err := h.store.ClaimDueSCMWebhooks(ctx, 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, claim := range claims {
			if claim.DeliveryID == id {
				t.Fatal("malformed delivery entered retry claims")
			}
		}
		var state, lastError string
		var attempts int
		if err := h.admin.QueryRow(ctx,
			`SELECT processing_state, last_error, attempts FROM ao_scm_webhook_deliveries WHERE delivery_id = $1`, id,
		).Scan(&state, &lastError, &attempts); err != nil {
			t.Fatal(err)
		}
		if state != domain.SCMWebhookStateDeadLetter || lastError != "invalid_json" || attempts != 0 {
			t.Fatalf("state = %q, error = %q, attempts = %d", state, lastError, attempts)
		}
	})

	t.Run("active duplicate and expired lease recovery are exclusive", func(t *testing.T) {
		id := h.deliveryID("lease")
		initial, err := h.store.IngestAndClaimSCMWebhook(ctx, h.receipt(id))
		if err != nil {
			t.Fatal(err)
		}
		duplicate, err := h.store.IngestAndClaimSCMWebhook(ctx, h.receipt(id))
		if err != nil {
			t.Fatal(err)
		}
		if duplicate.Claimed || duplicate.LeaseID != initial.LeaseID || duplicate.Attempts != initial.Attempts {
			t.Fatalf("active duplicate = %#v, initial = %#v", duplicate, initial)
		}
		if _, err := h.admin.Exec(ctx,
			`UPDATE ao_scm_webhook_deliveries SET lease_expires_at = clock_timestamp() - interval '1 second', next_attempt_at = clock_timestamp() - interval '1 second' WHERE delivery_id = $1`, id,
		); err != nil {
			t.Fatal(err)
		}
		const claimers = 10
		counts := make(chan int, claimers)
		var wg sync.WaitGroup
		for range claimers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				claims, claimErr := h.store.ClaimDueSCMWebhooks(ctx, 1)
				if claimErr != nil {
					counts <- -1
					return
				}
				for _, claim := range claims {
					if claim.DeliveryID == id {
						counts <- 1
						return
					}
				}
				counts <- 0
			}()
		}
		wg.Wait()
		close(counts)
		claimed := 0
		for count := range counts {
			if count < 0 {
				t.Fatal("concurrent claim failed")
			}
			claimed += count
		}
		if claimed != 1 {
			t.Fatalf("exclusive claims = %d", claimed)
		}
		if finished, err := h.store.FinishSCMWebhook(ctx, id, initial.LeaseID, domain.SCMWebhookOutcomeComplete, ""); err != nil || finished {
			t.Fatalf("stale lease finished = %v, error = %v", finished, err)
		}
	})

	t.Run("completion does not regress and retry backoff is capped", func(t *testing.T) {
		id := h.deliveryID("backoff")
		claim, err := h.store.IngestAndClaimSCMWebhook(ctx, h.receipt(id))
		if err != nil {
			t.Fatal(err)
		}
		finished, err := h.store.FinishSCMWebhook(ctx, id, claim.LeaseID, domain.SCMWebhookOutcomeRetry, "processing_failed")
		if err != nil || !finished {
			t.Fatalf("retry finish = %v, error = %v", finished, err)
		}
		var delay float64
		if err := h.admin.QueryRow(ctx,
			`SELECT extract(epoch FROM (next_attempt_at - updated_at)) FROM ao_scm_webhook_deliveries WHERE delivery_id = $1`, id,
		).Scan(&delay); err != nil {
			t.Fatal(err)
		}
		if delay < .9 || delay > 1.1 {
			t.Fatalf("first retry delay = %f", delay)
		}
		if _, err := h.admin.Exec(ctx,
			`UPDATE ao_scm_webhook_deliveries SET attempts = 14, processing_state = 'processing', lease_id = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes', next_attempt_at = clock_timestamp() + interval '5 minutes' WHERE delivery_id = $1`, id,
		); err != nil {
			t.Fatal(err)
		}
		if err := h.admin.QueryRow(ctx, `SELECT lease_id::text FROM ao_scm_webhook_deliveries WHERE delivery_id = $1`, id).Scan(&claim.LeaseID); err != nil {
			t.Fatal(err)
		}
		if finished, err = h.store.FinishSCMWebhook(ctx, id, claim.LeaseID, domain.SCMWebhookOutcomeRetry, "processing_failed"); err != nil || !finished {
			t.Fatalf("capped retry finish = %v, error = %v", finished, err)
		}
		if err := h.admin.QueryRow(ctx,
			`SELECT extract(epoch FROM (next_attempt_at - updated_at)) FROM ao_scm_webhook_deliveries WHERE delivery_id = $1`, id,
		).Scan(&delay); err != nil {
			t.Fatal(err)
		}
		if delay < 3599 || delay > 3601 {
			t.Fatalf("capped retry delay = %f", delay)
		}

		completeID := h.deliveryID("complete")
		complete, err := h.store.IngestAndClaimSCMWebhook(ctx, h.receipt(completeID))
		if err != nil {
			t.Fatal(err)
		}
		if ok, err := h.store.FinishSCMWebhook(ctx, completeID, complete.LeaseID, domain.SCMWebhookOutcomeComplete, ""); err != nil || !ok {
			t.Fatalf("complete = %v, error = %v", ok, err)
		}
		if ok, err := h.store.FinishSCMWebhook(ctx, completeID, complete.LeaseID, domain.SCMWebhookOutcomeComplete, ""); err != nil || !ok {
			t.Fatalf("idempotent complete = %v, error = %v", ok, err)
		}
		if ok, err := h.store.FinishSCMWebhook(ctx, completeID, complete.LeaseID, domain.SCMWebhookOutcomeRetry, "processing_failed"); err != nil || ok {
			t.Fatalf("regressing retry = %v, error = %v", ok, err)
		}
	})

	t.Run("sink success before finish replays one downstream write", func(t *testing.T) {
		connection, err := h.admin.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Release()
		if _, err := connection.Exec(ctx, `CREATE TEMP TABLE scm_observation_dedup (delivery_id TEXT PRIMARY KEY, repository TEXT NOT NULL)`); err != nil {
			t.Fatal(err)
		}
		sink := &pgIdempotentObservationSink{conn: connection}
		crashing := &finishCrashStore{WebhookStore: h.store, failNext: true}
		secret := []byte("sink-crash-secret")
		processor, err := scm.NewWebhookProcessor(secret, crashing, sink)
		if err != nil {
			t.Fatal(err)
		}
		id := h.deliveryID("sink-crash")
		body := h.receipt(id).Body
		result, err := processor.Process(ctx, "pull_request", id, webhookSignature(secret, body), body)
		if err == nil || !result.Durable {
			t.Fatalf("result = %#v, error = %v", result, err)
		}
		if _, err := h.admin.Exec(ctx,
			`UPDATE ao_scm_webhook_deliveries SET lease_expires_at = clock_timestamp() - interval '1 second', next_attempt_at = clock_timestamp() - interval '1 second' WHERE delivery_id = $1`, id,
		); err != nil {
			t.Fatal(err)
		}
		processed, err := processor.RetryPending(ctx, 100)
		if err != nil || processed == 0 {
			t.Fatalf("processed = %d, error = %v", processed, err)
		}
		var writes int
		if err := connection.QueryRow(ctx, `SELECT count(*) FROM scm_observation_dedup WHERE delivery_id = $1`, id).Scan(&writes); err != nil {
			t.Fatal(err)
		}
		if writes != 1 {
			t.Fatalf("downstream writes = %d", writes)
		}
	})

	t.Run("prune retains every unfinished delivery", func(t *testing.T) {
		processingID := h.deliveryID("prune-processing")
		completeID := h.deliveryID("prune-complete")
		deadID := h.deliveryID("prune-dead")
		if _, err := h.store.IngestAndClaimSCMWebhook(ctx, h.receipt(processingID)); err != nil {
			t.Fatal(err)
		}
		complete, err := h.store.IngestAndClaimSCMWebhook(ctx, h.receipt(completeID))
		if err != nil {
			t.Fatal(err)
		}
		if ok, err := h.store.FinishSCMWebhook(ctx, completeID, complete.LeaseID, domain.SCMWebhookOutcomeComplete, ""); err != nil || !ok {
			t.Fatalf("complete = %v, error = %v", ok, err)
		}
		dead := h.receipt(deadID)
		dead.Classification = domain.SCMWebhookClassificationMalformed
		dead.TerminalError = "invalid_json"
		if _, err := h.store.IngestAndClaimSCMWebhook(ctx, dead); err != nil {
			t.Fatal(err)
		}
		if _, err := h.admin.Exec(ctx,
			`UPDATE ao_scm_webhook_deliveries SET updated_at = clock_timestamp() - interval '2 hours' WHERE delivery_id = ANY($1)`,
			[]string{processingID, completeID, deadID},
		); err != nil {
			t.Fatal(err)
		}
		removed, err := h.store.PruneSCMWebhooks(ctx, time.Hour)
		if err != nil || removed < 2 {
			t.Fatalf("removed = %d, error = %v", removed, err)
		}
		var state string
		if err := h.admin.QueryRow(ctx,
			`SELECT processing_state FROM ao_scm_webhook_deliveries WHERE delivery_id = $1`, processingID,
		).Scan(&state); err != nil || state != domain.SCMWebhookStateProcessing {
			t.Fatalf("unfinished state = %q, error = %v", state, err)
		}
	})
}

func webhookSignature(secret, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

type pgIdempotentObservationSink struct {
	conn *pgxpool.Conn
}

type noopSCMObservationSink struct{}

func (noopSCMObservationSink) ObserveSCMSignal(context.Context, string, scm.ObservationSignal) error {
	return nil
}

func (s *pgIdempotentObservationSink) ObserveSCMSignal(ctx context.Context, deliveryID string, signal scm.ObservationSignal) error {
	_, err := s.conn.Exec(ctx,
		`INSERT INTO scm_observation_dedup (delivery_id, repository) VALUES ($1, $2) ON CONFLICT (delivery_id) DO NOTHING`,
		deliveryID, signal.Repository,
	)
	return err
}

type finishCrashStore struct {
	scm.WebhookStore
	mu       sync.Mutex
	failNext bool
}

func (s *finishCrashStore) FinishSCMWebhook(ctx context.Context, deliveryID, leaseID, outcome, errorCode string) (bool, error) {
	s.mu.Lock()
	if s.failNext {
		s.failNext = false
		s.mu.Unlock()
		return false, errors.New("simulated crash before finish")
	}
	s.mu.Unlock()
	return s.WebhookStore.FinishSCMWebhook(ctx, deliveryID, leaseID, outcome, errorCode)
}
