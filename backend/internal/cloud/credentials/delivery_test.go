package credentials

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

var testSecret = []byte(`{"claudeAiOauth":{"accessToken":"secret-marker"}}`)

func TestDeliverWaitsForExplicitHarnessAckBeforePurgeAndZero(t *testing.T) {
	store := newFakeDeliveryStore()
	opener := &fakeOpener{secret: append([]byte(nil), testSecret...)}
	loaded := make(chan struct{})
	release := make(chan struct{})
	sink := &fakeSink{load: func(_ context.Context, request LoadRequest) (LoadAcknowledgement, error) {
		if isZero(request.Files[0].Content) {
			t.Fatal("plaintext zeroed before harness load")
		}
		close(loaded)
		<-release
		return validAck(request), nil
	}}
	service := mustDeliveryService(t, store, opener, DefaultDeliveryLimits())
	done := make(chan error, 1)
	go func() {
		_, err := service.Deliver(context.Background(), testVerifiedCapability(), ProviderClaudeCode, "request-1", sink)
		done <- err
	}()
	<-loaded
	if sink.purgeCount() != 0 || isZero(opener.secret) {
		t.Fatal("purge or zero occurred before explicit acknowledgement")
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if sink.purgeCount() != 1 || !isZero(opener.secret) || store.ackCount != 1 || store.purgeCount != 1 {
		t.Fatalf("purges=%d zero=%v acks=%d auditPurges=%d", sink.purgeCount(), isZero(opener.secret), store.ackCount, store.purgeCount)
	}
}

func TestDeliverRejectsMissingAndFalseAcknowledgementAndPurges(t *testing.T) {
	for name, ack := range map[string]LoadAcknowledgement{
		"missing":         {},
		"false":           {IdempotencyKey: "request-1", Provider: ProviderClaudeCode, Loaded: false, LoadedAt: time.Now(), HarnessReceipt: "receipt"},
		"wrong key":       {IdempotencyKey: "other", Provider: ProviderClaudeCode, Loaded: true, LoadedAt: time.Now(), HarnessReceipt: "receipt"},
		"missing receipt": {IdempotencyKey: "request-1", Provider: ProviderClaudeCode, Loaded: true, LoadedAt: time.Now()},
	} {
		t.Run(name, func(t *testing.T) {
			store := newFakeDeliveryStore()
			opener := &fakeOpener{secret: append([]byte(nil), testSecret...)}
			sink := &fakeSink{ack: ack, ackSet: true}
			service := mustDeliveryService(t, store, opener, DefaultDeliveryLimits())
			_, err := service.Deliver(context.Background(), testVerifiedCapability(), ProviderClaudeCode, "request-1", sink)
			if !errors.Is(err, ErrLoadNotAcknowledged) {
				t.Fatalf("error = %v", err)
			}
			if sink.purgeCount() != 1 || !isZero(opener.secret) || store.ackCount != 0 || store.failureCount != 1 {
				t.Fatalf("purges=%d zero=%v acks=%d failures=%d", sink.purgeCount(), isZero(opener.secret), store.ackCount, store.failureCount)
			}
		})
	}
}

func TestDeliverCancelUsesDetachedRemotePurgeAndZeros(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	store := newFakeDeliveryStore()
	opener := &fakeOpener{secret: append([]byte(nil), testSecret...)}
	sink := &fakeSink{load: func(_ context.Context, _ LoadRequest) (LoadAcknowledgement, error) {
		cancel()
		return LoadAcknowledgement{}, context.Canceled
	}, purge: func(ctx context.Context, _, _ string, _ []string) error {
		if ctx.Err() != nil {
			t.Fatalf("purge inherited cancelled context: %v", ctx.Err())
		}
		return nil
	}}
	service := mustDeliveryService(t, store, opener, DefaultDeliveryLimits())
	if _, err := service.Deliver(ctx, testVerifiedCapability(), ProviderClaudeCode, "request-1", sink); !errors.Is(err, ErrDeliveryFailed) {
		t.Fatalf("error = %v", err)
	}
	if sink.purgeCount() != 1 || !isZero(opener.secret) || store.lastFailure != FailureCancelled {
		t.Fatalf("purges=%d zero=%v failure=%q", sink.purgeCount(), isZero(opener.secret), store.lastFailure)
	}
}

func TestDeliverTimeoutUsesDetachedRemotePurgeAndZeros(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	store := newFakeDeliveryStore()
	opener := &fakeOpener{secret: append([]byte(nil), testSecret...)}
	sink := &fakeSink{load: func(ctx context.Context, _ LoadRequest) (LoadAcknowledgement, error) {
		<-ctx.Done()
		return LoadAcknowledgement{}, ctx.Err()
	}, purge: func(ctx context.Context, _, _ string, _ []string) error {
		if ctx.Err() != nil {
			t.Fatalf("purge inherited timed-out context: %v", ctx.Err())
		}
		return nil
	}}
	service := mustDeliveryService(t, store, opener, DefaultDeliveryLimits())
	if _, err := service.Deliver(ctx, testVerifiedCapability(), ProviderClaudeCode, "request-1", sink); !errors.Is(err, ErrDeliveryFailed) {
		t.Fatalf("error = %v", err)
	}
	if sink.purgeCount() != 1 || !isZero(opener.secret) || store.lastFailure != FailureCancelled {
		t.Fatalf("purges=%d zero=%v failure=%q", sink.purgeCount(), isZero(opener.secret), store.lastFailure)
	}
}

func TestDuplicateDeliveryDoesNotReloadOrDoubleAudit(t *testing.T) {
	store := newFakeDeliveryStore()
	opener := &fakeOpener{secret: append([]byte(nil), testSecret...)}
	sink := &fakeSink{}
	service := mustDeliveryService(t, store, opener, DefaultDeliveryLimits())
	first, err := service.Deliver(context.Background(), testVerifiedCapability(), ProviderClaudeCode, "request-1", sink)
	if err != nil {
		t.Fatal(err)
	}
	opener.secret = append([]byte(nil), testSecret...)
	second, err := service.Deliver(context.Background(), testVerifiedCapability(), ProviderClaudeCode, "request-1", sink)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || sink.loadCount != 1 || store.ackCount != 1 || opener.openCount != 1 {
		t.Fatalf("first=%#v second=%#v loads=%d acks=%d opens=%d", first, second, sink.loadCount, store.ackCount, opener.openCount)
	}
	if sink.purgeCount() != 2 || store.purgeCount != 2 {
		t.Fatalf("idempotent purge retries = %d/%d", sink.purgeCount(), store.purgeCount)
	}
}

func TestDeliveryEnforcesPerItemAggregateAndConcurrentLimits(t *testing.T) {
	for _, testCase := range []struct {
		name              string
		maxItem, maxTotal int
	}{{"item", 8, MaxDeliveryBytes}, {"aggregate", MaxCredentialBytes, 8}} {
		t.Run(testCase.name, func(t *testing.T) {
			limits := DefaultDeliveryLimits()
			limits.MaxItemBytes, limits.MaxAggregateBytes = testCase.maxItem, testCase.maxTotal
			store := newFakeDeliveryStore()
			opener := &fakeOpener{secret: append([]byte(nil), testSecret...)}
			sink := &fakeSink{}
			service := mustDeliveryService(t, store, opener, limits)
			if _, err := service.Deliver(context.Background(), testVerifiedCapability(), ProviderClaudeCode, "request-1", sink); !errors.Is(err, ErrInvalid) {
				t.Fatalf("error = %v", err)
			}
			if sink.loadCount != 0 || sink.purgeCount() != 1 || !isZero(opener.secret) {
				t.Fatalf("loads=%d purges=%d zero=%v", sink.loadCount, sink.purgeCount(), isZero(opener.secret))
			}
		})
	}

	limits := DefaultDeliveryLimits()
	limits.MaxConcurrent = 1
	store := newFakeDeliveryStore()
	firstLoaded := make(chan struct{})
	release := make(chan struct{})
	sink := &fakeSink{load: func(_ context.Context, request LoadRequest) (LoadAcknowledgement, error) {
		close(firstLoaded)
		<-release
		return validAck(request), nil
	}}
	service := mustDeliveryService(t, store, &fakeOpener{secret: append([]byte(nil), testSecret...)}, limits)
	done := make(chan struct{})
	go func() {
		_, _ = service.Deliver(context.Background(), testVerifiedCapability(), ProviderClaudeCode, "request-1", sink)
		close(done)
	}()
	<-firstLoaded
	if _, err := service.Deliver(context.Background(), testVerifiedCapability(), ProviderClaudeCode, "request-2", sink); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("concurrent error = %v", err)
	}
	close(release)
	<-done
}

func TestDeliveryPropagatesDurableInflightAndAggregateQuotaFailures(t *testing.T) {
	for _, failure := range []error{ErrDeliveryInFlight, ErrLimitExceeded} {
		store := newFakeDeliveryStore()
		store.claimErr = failure
		opener := &fakeOpener{secret: append([]byte(nil), testSecret...)}
		sink := &fakeSink{}
		service := mustDeliveryService(t, store, opener, DefaultDeliveryLimits())
		if _, err := service.Deliver(context.Background(), testVerifiedCapability(), ProviderClaudeCode, "request-1", sink); !errors.Is(err, failure) {
			t.Fatalf("error = %v, want %v", err, failure)
		}
		if opener.openCount != 0 || sink.loadCount != 0 {
			t.Fatal("quota failure opened or delivered credential")
		}
	}
}

type fakeOpener struct {
	secret    []byte
	openCount int
}

func (f *fakeOpener) Open(ctx context.Context, _ CredentialRecord, consume func([]byte) error) error {
	f.openCount++
	defer Erase(f.secret)
	return consume(f.secret)
}

type fakeSink struct {
	mu        sync.Mutex
	ack       LoadAcknowledgement
	ackSet    bool
	load      func(context.Context, LoadRequest) (LoadAcknowledgement, error)
	purge     func(context.Context, string, string, []string) error
	loadCount int
	purges    int
}

func (f *fakeSink) LoadCredential(ctx context.Context, request LoadRequest) (LoadAcknowledgement, error) {
	f.mu.Lock()
	f.loadCount++
	f.mu.Unlock()
	if f.load != nil {
		return f.load(ctx, request)
	}
	if f.ackSet {
		return f.ack, nil
	}
	return validAck(request), nil
}
func (f *fakeSink) PurgeCredential(ctx context.Context, sandbox, key string, paths []string) error {
	f.mu.Lock()
	f.purges++
	f.mu.Unlock()
	if f.purge != nil {
		return f.purge(ctx, sandbox, key, paths)
	}
	return nil
}
func (f *fakeSink) purgeCount() int { f.mu.Lock(); defer f.mu.Unlock(); return f.purges }

func validAck(request LoadRequest) LoadAcknowledgement {
	return LoadAcknowledgement{IdempotencyKey: request.IdempotencyKey, Provider: request.Provider, Loaded: true, LoadedAt: time.Now(), HarnessReceipt: "harness-receipt"}
}

type fakeDeliveryStore struct {
	mu                                 sync.Mutex
	claim                              DeliveryClaim
	claimErr                           error
	ackCount, purgeCount, failureCount int
	lastFailure                        FailureCode
}

func newFakeDeliveryStore() *fakeDeliveryStore { return &fakeDeliveryStore{} }
func (f *fakeDeliveryStore) ClaimDelivery(_ context.Context, lookup DeliveryLookup, _ DeliveryLimits) (DeliveryClaim, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.claimErr != nil {
		return DeliveryClaim{}, f.claimErr
	}
	if f.claim.State == DeliveryLoaded {
		return f.claim, nil
	}
	f.claim = DeliveryClaim{ID: "delivery-1", Lookup: lookup, SandboxID: "sandbox-1", State: DeliveryClaimed, Credential: CredentialRecord{
		ID: "credential-1", OrgID: lookup.OrgID(), OwnerUserID: "user-1", Provider: lookup.Provider(),
		PlaintextBytes: int64(len(testSecret)), Version: 1,
	}}
	return f.claim, nil
}
func (f *fakeDeliveryStore) AcknowledgeDelivery(_ context.Context, _ string, ack LoadAcknowledgement) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ackCount++
	f.claim.State = DeliveryLoaded
	f.claim.Acknowledgement = ack
	return nil
}
func (f *fakeDeliveryStore) RecordDeliveryPurge(context.Context, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.purgeCount++
	return nil
}
func (f *fakeDeliveryStore) RecordDeliveryFailure(_ context.Context, _ string, code FailureCode) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failureCount++
	f.lastFailure = code
	return nil
}

func mustDeliveryService(t *testing.T, store DeliveryStore, opener PlaintextOpener, limits DeliveryLimits) *DeliveryService {
	t.Helper()
	service, err := NewDeliveryService(store, opener, limits)
	if err != nil {
		t.Fatal(err)
	}
	return service
}
