package scm

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

var testWebhookSecret = []byte("test-github-webhook-secret")

func signed(body []byte) string {
	mac := hmac.New(sha256.New, testWebhookSecret)
	_, _ = mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

type memoryDelivery struct {
	receipt domain.SCMWebhookReceipt
	claim   domain.SCMWebhookClaim
	expired bool
}

type memoryWebhookStore struct {
	mu             sync.Mutex
	deliveries     map[string]*memoryDelivery
	ingestErr      error
	failNextFinish bool
	nextLease      int
}

func newMemoryWebhookStore() *memoryWebhookStore {
	return &memoryWebhookStore{deliveries: make(map[string]*memoryDelivery)}
}

func (s *memoryWebhookStore) IngestAndClaimSCMWebhook(_ context.Context, receipt domain.SCMWebhookReceipt) (domain.SCMWebhookClaim, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ingestErr != nil {
		return domain.SCMWebhookClaim{}, s.ingestErr
	}
	if existing, ok := s.deliveries[receipt.DeliveryID]; ok {
		claim := existing.claim
		claim.FirstReceipt = false
		claim.Claimed = false
		if existing.expired && claim.State == domain.SCMWebhookStateProcessing && claim.Attempts < 16 {
			s.nextLease++
			claim.LeaseID = fmt.Sprintf("lease-%d", s.nextLease)
			claim.Attempts++
			claim.Claimed = true
			existing.expired = false
			existing.claim = claim
		}
		return claim, nil
	}
	s.nextLease++
	claim := domain.SCMWebhookClaim{
		Provider:       receipt.Provider,
		DeliveryID:     receipt.DeliveryID,
		Event:          receipt.Event,
		Body:           append([]byte(nil), receipt.Body...),
		Classification: receipt.Classification,
		FirstReceipt:   true,
		ReceivedAt:     time.Now().UTC(),
	}
	if receipt.TerminalError != "" {
		claim.State = domain.SCMWebhookStateDeadLetter
	} else {
		claim.State = domain.SCMWebhookStateProcessing
		claim.LeaseID = fmt.Sprintf("lease-%d", s.nextLease)
		claim.Attempts = 1
		claim.Claimed = true
	}
	s.deliveries[receipt.DeliveryID] = &memoryDelivery{receipt: receipt, claim: claim}
	return claim, nil
}

func (s *memoryWebhookStore) ClaimDueSCMWebhooks(_ context.Context, limit int) ([]domain.SCMWebhookClaim, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	claims := make([]domain.SCMWebhookClaim, 0, limit)
	for _, delivery := range s.deliveries {
		if len(claims) >= limit {
			break
		}
		due := delivery.claim.State == domain.SCMWebhookStateRetry ||
			(delivery.claim.State == domain.SCMWebhookStateProcessing && delivery.expired)
		if !due || delivery.claim.Attempts >= 16 {
			continue
		}
		s.nextLease++
		delivery.claim.State = domain.SCMWebhookStateProcessing
		delivery.claim.LeaseID = fmt.Sprintf("lease-%d", s.nextLease)
		delivery.claim.Attempts++
		delivery.claim.FirstReceipt = false
		delivery.claim.Claimed = true
		delivery.expired = false
		claims = append(claims, delivery.claim)
	}
	return claims, nil
}

func (s *memoryWebhookStore) FinishSCMWebhook(_ context.Context, deliveryID, leaseID, outcome, _ string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failNextFinish {
		s.failNextFinish = false
		return false, errors.New("database unavailable after sink commit")
	}
	delivery := s.deliveries[deliveryID]
	if delivery == nil {
		return false, nil
	}
	if outcome == domain.SCMWebhookOutcomeComplete && delivery.claim.State == domain.SCMWebhookStateComplete {
		return true, nil
	}
	if delivery.claim.State != domain.SCMWebhookStateProcessing || delivery.claim.LeaseID != leaseID {
		return false, nil
	}
	switch outcome {
	case domain.SCMWebhookOutcomeComplete:
		delivery.claim.State = domain.SCMWebhookStateComplete
	case domain.SCMWebhookOutcomeRetry:
		delivery.claim.State = domain.SCMWebhookStateRetry
	default:
		return false, errors.New("invalid outcome")
	}
	delivery.claim.LeaseID = ""
	return true, nil
}

func (s *memoryWebhookStore) expire(deliveryID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deliveries[deliveryID].expired = true
}

type idempotentSink struct {
	mu         sync.Mutex
	deliveries map[string]ObservationSignal
	writeCalls int
	fail       bool
}

func (s *idempotentSink) ObserveSCMSignal(_ context.Context, deliveryID string, signal ObservationSignal) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return errors.New("observer unavailable")
	}
	if s.deliveries == nil {
		s.deliveries = make(map[string]ObservationSignal)
	}
	if _, exists := s.deliveries[deliveryID]; !exists {
		s.deliveries[deliveryID] = signal
		s.writeCalls++
	}
	return nil
}

func newTestProcessor(t *testing.T, store WebhookStore, sink ObservationSink) *WebhookProcessor {
	t.Helper()
	processor, err := NewWebhookProcessor(testWebhookSecret, store, sink)
	if err != nil {
		t.Fatal(err)
	}
	return processor
}

func observationBody() []byte {
	return []byte(`{"action":"synchronize","installation":{"id":55},"repository":{"full_name":"Acme/Widgets"},"pull_request":{"number":7,"html_url":"https://github.com/acme/widgets/pull/7","head":{"sha":"abc123"}}}`)
}

func TestWebhookRejectsInvalidInputBeforeDurability(t *testing.T) {
	store := newMemoryWebhookStore()
	processor := newTestProcessor(t, store, nil)
	body := observationBody()
	if _, err := processor.Process(context.Background(), "pull_request", "bad-signature", "sha256=deadbeef", body); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("signature error = %v", err)
	}
	oversize := make([]byte, MaxWebhookBodyBytes+1)
	if _, err := processor.Process(context.Background(), "pull_request", "oversize", signed(oversize), oversize); !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("oversize error = %v", err)
	}
	if len(store.deliveries) != 0 {
		t.Fatalf("rejected deliveries reached store: %#v", store.deliveries)
	}
}

func TestWebhookPreDurableFailureIsRetryable(t *testing.T) {
	store := newMemoryWebhookStore()
	store.ingestErr = errors.New("database unavailable")
	processor := newTestProcessor(t, store, nil)
	body := observationBody()
	result, err := processor.Process(context.Background(), "pull_request", "unavailable", signed(body), body)
	if !errors.Is(err, ErrWebhookReceiptUnavailable) || result.Durable {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
	if len(store.deliveries) != 0 {
		t.Fatal("failed atomic ingest left a delivery")
	}
}

func TestWebhookMalformedJSONIsDurablyTerminal(t *testing.T) {
	store := newMemoryWebhookStore()
	processor := newTestProcessor(t, store, nil)
	body := []byte(`{"unterminated"`)
	result, err := processor.Process(context.Background(), "pull_request", "malformed", signed(body), body)
	if err != nil || !result.Durable || !result.Terminal {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
	processed, err := processor.RetryPending(context.Background(), 10)
	if err != nil || processed != 0 {
		t.Fatalf("terminal retry processed = %d, error = %v", processed, err)
	}
	redelivery, err := processor.Process(context.Background(), "pull_request", "malformed", signed(body), body)
	if err != nil || !redelivery.Duplicate || !redelivery.Terminal {
		t.Fatalf("redelivery = %#v, error = %v", redelivery, err)
	}
}

func TestWebhookActiveDuplicatePreservesLeaseAndBody(t *testing.T) {
	store := newMemoryWebhookStore()
	receipt := domain.SCMWebhookReceipt{
		Provider: domain.SCMProviderGitHub, DeliveryID: "concurrent", Event: "pull_request",
		Body: observationBody(), Classification: domain.SCMWebhookClassificationObservation,
	}
	first, err := store.IngestAndClaimSCMWebhook(context.Background(), receipt)
	if err != nil {
		t.Fatal(err)
	}
	changed := receipt
	changed.Body = []byte(`{"different":true}`)
	duplicate, err := store.IngestAndClaimSCMWebhook(context.Background(), changed)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Claimed || duplicate.Claimed || duplicate.LeaseID != first.LeaseID || string(duplicate.Body) != string(first.Body) {
		t.Fatalf("first = %#v, duplicate = %#v", first, duplicate)
	}
}

func TestWebhookSinkCommitBeforeFinishIsIdempotentOnRecovery(t *testing.T) {
	store := newMemoryWebhookStore()
	store.failNextFinish = true
	sink := &idempotentSink{}
	processor := newTestProcessor(t, store, sink)
	body := observationBody()
	result, err := processor.Process(context.Background(), "pull_request", "crash-window", signed(body), body)
	if err == nil || !result.Durable || sink.writeCalls != 1 {
		t.Fatalf("result = %#v, error = %v, writes = %d", result, err, sink.writeCalls)
	}
	store.expire("crash-window")
	processed, err := processor.RetryPending(context.Background(), 10)
	if err != nil || processed != 1 {
		t.Fatalf("processed = %d, error = %v", processed, err)
	}
	if sink.writeCalls != 1 || len(sink.deliveries) != 1 {
		t.Fatalf("idempotent sink writes = %d deliveries = %#v", sink.writeCalls, sink.deliveries)
	}
	if store.deliveries["crash-window"].claim.State != domain.SCMWebhookStateComplete {
		t.Fatalf("state = %q", store.deliveries["crash-window"].claim.State)
	}
}

func TestWebhookProcessingFailureIsDurablyRetried(t *testing.T) {
	store := newMemoryWebhookStore()
	sink := &idempotentSink{fail: true}
	processor := newTestProcessor(t, store, sink)
	body := observationBody()
	result, err := processor.Process(context.Background(), "pull_request", "retry", signed(body), body)
	if err == nil || !result.Durable || store.deliveries["retry"].claim.State != domain.SCMWebhookStateRetry {
		t.Fatalf("result = %#v, error = %v, delivery = %#v", result, err, store.deliveries["retry"])
	}
	sink.fail = false
	processed, err := processor.RetryPending(context.Background(), 10)
	if err != nil || processed != 1 || sink.writeCalls != 1 {
		t.Fatalf("processed = %d, error = %v, writes = %d", processed, err, sink.writeCalls)
	}
}

func TestWebhookSignalCarriesRequiredDeliveryKeySeparately(t *testing.T) {
	store := newMemoryWebhookStore()
	sink := &idempotentSink{}
	processor := newTestProcessor(t, store, sink)
	body := observationBody()
	result, err := processor.Process(context.Background(), "pull_request", "delivery-key", signed(body), body)
	if err != nil || result.Signal == nil {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
	signal := sink.deliveries["delivery-key"]
	if signal.Repository != "acme/widgets" || signal.PullRequestNumber != 7 || signal.HeadSHA != "abc123" {
		t.Fatalf("signal = %#v", signal)
	}
}
