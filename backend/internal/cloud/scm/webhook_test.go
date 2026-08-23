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

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

type recordedRepository struct {
	installationID int64
	repositoryID   int64
	fullName       string
	private        bool
}

type memoryWebhookStore struct {
	mu            sync.Mutex
	deliveries    map[string]int
	installations map[int64]domain.SCMInstallation
	statuses      []string
	added         []recordedRepository
	removed       []recordedRepository
	recordErr     error
}

func newMemoryWebhookStore() *memoryWebhookStore {
	return &memoryWebhookStore{
		deliveries:    map[string]int{},
		installations: map[int64]domain.SCMInstallation{},
	}
}

func (s *memoryWebhookStore) RecordSCMWebhookDelivery(
	_ context.Context,
	deliveryID, _ string,
	_ int64,
) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.recordErr != nil {
		return false, s.recordErr
	}
	s.deliveries[deliveryID]++
	return s.deliveries[deliveryID] == 1, nil
}

func (s *memoryWebhookStore) SCMInstallationContext(
	_ context.Context,
	externalInstallationID int64,
) (domain.SCMInstallation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	installation, ok := s.installations[externalInstallationID]
	if !ok {
		return domain.SCMInstallation{}, postgres.ErrNotFound
	}
	return installation, nil
}

func (s *memoryWebhookStore) SetSCMInstallationStatus(
	_ context.Context,
	_ int64,
	status string,
) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.statuses = append(s.statuses, status)
	return true, nil
}

func (s *memoryWebhookStore) AddSCMWebhookRepository(
	_ context.Context,
	externalInstallationID, externalRepositoryID int64,
	fullName string,
	private bool,
) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.added = append(s.added, recordedRepository{externalInstallationID, externalRepositoryID, fullName, private})
	return true, nil
}

func (s *memoryWebhookStore) RemoveSCMWebhookRepository(
	_ context.Context,
	externalInstallationID, externalRepositoryID int64,
) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removed = append(s.removed, recordedRepository{installationID: externalInstallationID, repositoryID: externalRepositoryID})
	return true, nil
}

type recordingSink struct {
	mu      sync.Mutex
	signals []SCMObservationSignal
	err     error
}

func (s *recordingSink) ObserveSCMSignal(_ context.Context, signal SCMObservationSignal) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	s.signals = append(s.signals, signal)
	return nil
}

func (s *recordingSink) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.signals)
}

var webhookSecret = []byte("hunter2-webhook-secret")

func sign(body []byte) string {
	mac := hmac.New(sha256.New, webhookSecret)
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func TestVerifyWebhookSignature(t *testing.T) {
	body := []byte(`{"action":"opened"}`)
	valid := sign(body)
	cases := []struct {
		name      string
		secret    []byte
		body      []byte
		signature string
		wantErr   error
	}{
		{name: "valid", secret: webhookSecret, body: body, signature: valid},
		{name: "tampered body", secret: webhookSecret, body: []byte(`{"action":"closed"}`), signature: valid, wantErr: ErrInvalidSignature},
		{name: "wrong secret", secret: []byte("other"), body: body, signature: valid, wantErr: ErrInvalidSignature},
		{name: "missing header", secret: webhookSecret, body: body, signature: "", wantErr: ErrInvalidSignature},
		{name: "sha1 header", secret: webhookSecret, body: body, signature: "sha1=" + valid[7:], wantErr: ErrInvalidSignature},
		{name: "not hex", secret: webhookSecret, body: body, signature: "sha256=zzzz", wantErr: ErrInvalidSignature},
		{name: "truncated digest", secret: webhookSecret, body: body, signature: valid[:20], wantErr: ErrInvalidSignature},
		{name: "no secret configured", secret: nil, body: body, signature: valid, wantErr: ErrNotConfigured},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			err := VerifyWebhookSignature(testCase.secret, testCase.body, testCase.signature)
			if !errors.Is(err, testCase.wantErr) {
				t.Fatalf("error = %v, want %v", err, testCase.wantErr)
			}
		})
	}
}

func newTestProcessor(t *testing.T, store WebhookStore, sink ObservationSink) *WebhookProcessor {
	t.Helper()
	processor, err := NewWebhookProcessor(webhookSecret, store, sink)
	if err != nil {
		t.Fatal(err)
	}
	return processor
}

func TestWebhookRejectsBadSignatureBeforeTouchingTheStore(t *testing.T) {
	store := newMemoryWebhookStore()
	processor := newTestProcessor(t, store, nil)
	body := []byte(`{"action":"opened","installation":{"id":55}}`)

	_, err := processor.Process(context.Background(), "pull_request", "delivery-1", "sha256=deadbeef", body)
	if !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("error = %v", err)
	}
	if len(store.deliveries) != 0 {
		t.Fatal("an unverified delivery reached the dedup table")
	}
}

func TestWebhookIsIdempotentPerDeliveryID(t *testing.T) {
	store := newMemoryWebhookStore()
	store.installations[55] = domain.SCMInstallation{
		ID: "installation-55", OrgID: "org-1", Status: domain.InstallationStatusActive,
	}
	sink := &recordingSink{}
	processor := newTestProcessor(t, store, sink)
	body := []byte(`{
		"action":"synchronize",
		"installation":{"id":55},
		"repository":{"id":900,"full_name":"Acme/Widgets"},
		"pull_request":{"number":7,"html_url":"https://github.com/acme/widgets/pull/7","head":{"sha":"abc123"}}
	}`)
	signature := sign(body)

	first, err := processor.Process(context.Background(), "pull_request", "delivery-1", signature, body)
	if err != nil {
		t.Fatal(err)
	}
	if first.Duplicate || first.Signal == nil {
		t.Fatalf("first delivery = %#v", first)
	}
	if first.Signal.Repository != "acme/widgets" || first.Signal.PullRequestNumber != 7 ||
		first.Signal.HeadSHA != "abc123" || first.Signal.OrgID != "org-1" ||
		first.Signal.InstallationID != "installation-55" {
		t.Fatalf("signal = %#v", *first.Signal)
	}

	second, err := processor.Process(context.Background(), "pull_request", "delivery-1", signature, body)
	if err != nil {
		t.Fatal(err)
	}
	if !second.Duplicate || second.Signal != nil {
		t.Fatalf("redelivery = %#v", second)
	}
	if sink.count() != 1 {
		t.Fatalf("redelivery produced %d observations", sink.count())
	}
}

func TestWebhookInstallationLifecycleNarrowsAccess(t *testing.T) {
	store := newMemoryWebhookStore()
	processor := newTestProcessor(t, store, nil)
	cases := []struct {
		action string
		want   string
	}{
		{action: "suspend", want: domain.InstallationStatusSuspended},
		{action: "deleted", want: domain.InstallationStatusRemoved},
		{action: "unsuspend", want: domain.InstallationStatusActive},
		{action: "new_permissions_accepted", want: ""},
	}
	for index, testCase := range cases {
		body := []byte(fmt.Sprintf(`{"action":%q,"installation":{"id":55}}`, testCase.action))
		if _, err := processor.Process(
			context.Background(), "installation", fmt.Sprintf("delivery-%d", index), sign(body), body,
		); err != nil {
			t.Fatal(err)
		}
	}
	if len(store.statuses) != 3 ||
		store.statuses[0] != domain.InstallationStatusSuspended ||
		store.statuses[1] != domain.InstallationStatusRemoved ||
		store.statuses[2] != domain.InstallationStatusActive {
		t.Fatalf("statuses = %#v", store.statuses)
	}
}

func TestWebhookRepositoryChangesNeverWidenTheAllowlist(t *testing.T) {
	store := newMemoryWebhookStore()
	processor := newTestProcessor(t, store, nil)
	body := []byte(`{
		"action":"added",
		"installation":{"id":55},
		"repositories_added":[{"id":901,"full_name":"Acme/New","private":true}],
		"repositories_removed":[{"id":900,"full_name":"Acme/Widgets"}]
	}`)
	if _, err := processor.Process(context.Background(), "installation_repositories", "delivery-1", sign(body), body); err != nil {
		t.Fatal(err)
	}
	if len(store.added) != 1 || store.added[0].repositoryID != 901 || store.added[0].fullName != "Acme/New" {
		t.Fatalf("added = %#v", store.added)
	}
	if len(store.removed) != 1 || store.removed[0].repositoryID != 900 {
		t.Fatalf("removed = %#v", store.removed)
	}
	// The store's add path is the only way a webhook can create a repository
	// row, and its migration hard-codes allowed = FALSE. Assert here that the
	// processor never asks for anything else: there is no "allowed" argument.
}

func TestWebhookIgnoresUnknownInstallation(t *testing.T) {
	store := newMemoryWebhookStore()
	sink := &recordingSink{}
	processor := newTestProcessor(t, store, sink)
	body := []byte(`{
		"action":"opened",
		"installation":{"id":999},
		"repository":{"id":900,"full_name":"acme/widgets"},
		"pull_request":{"number":7,"head":{"sha":"abc"}}
	}`)
	result, err := processor.Process(context.Background(), "pull_request", "delivery-1", sign(body), body)
	if err != nil {
		t.Fatal(err)
	}
	if result.Signal != nil || sink.count() != 0 {
		t.Fatal("an event for an unknown installation produced an observation")
	}
}

func TestWebhookIgnoresEventsForSuspendedInstallation(t *testing.T) {
	store := newMemoryWebhookStore()
	store.installations[55] = domain.SCMInstallation{
		ID: "installation-55", OrgID: "org-1", Status: domain.InstallationStatusSuspended,
	}
	sink := &recordingSink{}
	processor := newTestProcessor(t, store, sink)
	body := []byte(`{
		"action":"opened",
		"installation":{"id":55},
		"repository":{"id":900,"full_name":"acme/widgets"},
		"pull_request":{"number":7,"head":{"sha":"abc"}}
	}`)
	if _, err := processor.Process(context.Background(), "pull_request", "delivery-1", sign(body), body); err != nil {
		t.Fatal(err)
	}
	if sink.count() != 0 {
		t.Fatal("a suspended installation still produced an observation")
	}
}

func TestWebhookSignalExtraction(t *testing.T) {
	store := newMemoryWebhookStore()
	store.installations[55] = domain.SCMInstallation{
		ID: "installation-55", OrgID: "org-1", Status: domain.InstallationStatusActive,
	}
	processor := newTestProcessor(t, store, nil)
	cases := []struct {
		name       string
		event      string
		body       string
		wantSignal bool
		wantNumber int
		wantSHA    string
	}{
		{
			name:       "issue comment on a pull request",
			event:      "issue_comment",
			body:       `{"installation":{"id":55},"repository":{"full_name":"acme/widgets"},"issue":{"number":9,"pull_request":{"html_url":"u"}}}`,
			wantSignal: true, wantNumber: 9,
		},
		{
			name:  "issue comment on a plain issue",
			event: "issue_comment",
			body:  `{"installation":{"id":55},"repository":{"full_name":"acme/widgets"},"issue":{"number":9}}`,
		},
		{
			name:       "check suite",
			event:      "check_suite",
			body:       `{"installation":{"id":55},"repository":{"full_name":"acme/widgets"},"check_suite":{"head_sha":"deadbeef","pull_requests":[{"number":4}]}}`,
			wantSignal: true, wantNumber: 4, wantSHA: "deadbeef",
		},
		{
			name:       "commit status without a pull request",
			event:      "status",
			body:       `{"installation":{"id":55},"repository":{"full_name":"acme/widgets"},"sha":"cafe"}`,
			wantSignal: true, wantSHA: "cafe",
		},
		{
			name:  "unrelated event",
			event: "star",
			body:  `{"installation":{"id":55},"repository":{"full_name":"acme/widgets"}}`,
		},
		{
			name:  "event without a repository",
			event: "pull_request",
			body:  `{"installation":{"id":55},"pull_request":{"number":3}}`,
		},
	}
	for index, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			body := []byte(testCase.body)
			result, err := processor.Process(
				context.Background(), testCase.event, fmt.Sprintf("signal-delivery-%d", index), sign(body), body,
			)
			if err != nil {
				t.Fatal(err)
			}
			if !testCase.wantSignal {
				if result.Signal != nil {
					t.Fatalf("signal = %#v, want none", *result.Signal)
				}
				return
			}
			if result.Signal == nil {
				t.Fatal("expected a signal")
			}
			if result.Signal.PullRequestNumber != testCase.wantNumber || result.Signal.HeadSHA != testCase.wantSHA {
				t.Fatalf("signal = %#v", *result.Signal)
			}
		})
	}
}

func TestWebhookRequiresEventAndDeliveryID(t *testing.T) {
	store := newMemoryWebhookStore()
	processor := newTestProcessor(t, store, nil)
	body := []byte(`{"installation":{"id":55}}`)
	if _, err := processor.Process(context.Background(), "", "delivery-1", sign(body), body); err == nil {
		t.Fatal("a delivery without an event was accepted")
	}
	if _, err := processor.Process(context.Background(), "pull_request", "", sign(body), body); err == nil {
		t.Fatal("a delivery without an id was accepted")
	}
}

func TestNewWebhookProcessorRequiresSecret(t *testing.T) {
	if _, err := NewWebhookProcessor(nil, newMemoryWebhookStore(), nil); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("error = %v", err)
	}
}
