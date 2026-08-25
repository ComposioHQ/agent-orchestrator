package idlepause

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/domain"
)

// fakeStore records every PauseIfIdle call so a test can assert on what the
// scanner decided without a real database.
type fakeStore struct {
	refs []domain.SandboxRef

	// idle reports, per session, whether PauseIfIdle should pause it.
	idle map[string]bool
	// err, if set, makes PauseIfIdle fail for exactly this session.
	err map[string]error

	listErr error
	paused  []domain.SandboxRef
}

func (f *fakeStore) RunningSandboxSessions(context.Context) ([]domain.SandboxRef, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.refs, nil
}

func (f *fakeStore) PauseIfIdle(_ context.Context, orgID, sessionID string, _ time.Duration) (bool, error) {
	if err := f.err[sessionID]; err != nil {
		return false, err
	}
	if !f.idle[sessionID] {
		return false, nil
	}
	f.paused = append(f.paused, domain.SandboxRef{OrgID: orgID, SessionID: sessionID})
	return true, nil
}

func TestScanOncePausesOnlyIdleSessions(t *testing.T) {
	store := &fakeStore{
		refs: []domain.SandboxRef{
			{OrgID: "org-1", SessionID: "quiet"},
			{OrgID: "org-1", SessionID: "busy"},
		},
		idle: map[string]bool{"quiet": true, "busy": false},
	}
	scanner := New(store, Options{})

	if err := scanner.ScanOnce(context.Background()); err != nil {
		t.Fatalf("ScanOnce() error = %v", err)
	}

	if len(store.paused) != 1 || store.paused[0].SessionID != "quiet" {
		t.Errorf("paused = %v, want exactly session %q", store.paused, "quiet")
	}
}

func TestScanOnceSkipsAFailingSessionAndContinues(t *testing.T) {
	store := &fakeStore{
		refs: []domain.SandboxRef{
			{OrgID: "org-1", SessionID: "errors"},
			{OrgID: "org-1", SessionID: "quiet"},
		},
		idle: map[string]bool{"quiet": true},
		err:  map[string]error{"errors": errors.New("transient failure")},
	}
	scanner := New(store, Options{})

	if err := scanner.ScanOnce(context.Background()); err != nil {
		t.Fatalf("ScanOnce() error = %v, want a per-session error not to fail the scan", err)
	}

	if len(store.paused) != 1 || store.paused[0].SessionID != "quiet" {
		t.Errorf("paused = %v, want the healthy session still paused despite the other's error", store.paused)
	}
}

func TestScanOnceReturnsErrorWhenListingFails(t *testing.T) {
	store := &fakeStore{listErr: errors.New("db unavailable")}
	scanner := New(store, Options{})

	if err := scanner.ScanOnce(context.Background()); err == nil {
		t.Fatal("ScanOnce() error = nil, want the listing failure surfaced")
	}
}

func TestNewFillsDefaults(t *testing.T) {
	scanner := New(&fakeStore{}, Options{})

	if scanner.options.Interval != DefaultInterval {
		t.Errorf("Interval = %v, want default %v", scanner.options.Interval, DefaultInterval)
	}
	if scanner.options.IdleThreshold != DefaultIdleThreshold {
		t.Errorf("IdleThreshold = %v, want default %v", scanner.options.IdleThreshold, DefaultIdleThreshold)
	}
}
