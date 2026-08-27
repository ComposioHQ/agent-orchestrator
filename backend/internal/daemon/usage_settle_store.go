package daemon

import (
	"context"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	usagetelemetry "github.com/aoagents/agent-orchestrator/backend/internal/service/usagetelemetry"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// usageSettleStore wraps the SQLite store the usage Collector runs on so that
// per-session token-usage telemetry is emitted at the correct moment: after the
// pipeline has actually finished ingesting a session's transcript, not at
// session exit (where the transcript is typically not yet read and a summary
// read would see zero tokens).
//
// CompleteUsageBindingIfSettled is the pipeline's settle signal: it flips a
// binding from finalizing to complete exactly once, on that atomic transition,
// and returns true only then. That makes it a natural, retry-safe trigger. When
// the last binding of a session settles, we emit once; the Emitter additionally
// dedupes by total, so multi-binding settles and reconcile retries never
// double-count, and a rejected termination (whose bindings never settle) never
// produces a false event.
//
// It learns each binding's session id from the records the collector already
// reads/writes, so no new store query is needed. A binding first observed only
// after a daemon restart (its id not in the in-memory map) is skipped rather
// than mis-attributed; the common case, where finalize and settle happen in one
// process, is covered.
type usageSettleStore struct {
	*sqlite.Store
	emitter *usagetelemetry.Emitter

	mu      sync.Mutex
	session map[int64]domain.SessionID // bindingID -> sessionID
}

func newUsageSettleStore(s *sqlite.Store, emitter *usagetelemetry.Emitter) *usageSettleStore {
	return &usageSettleStore{Store: s, emitter: emitter, session: make(map[int64]domain.SessionID)}
}

func (s *usageSettleStore) remember(records ...domain.UsageBindingRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range records {
		if r.ID != 0 {
			s.session[r.ID] = r.SessionID
		}
	}
}

func (s *usageSettleStore) sessionFor(bindingID int64) (domain.SessionID, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.session[bindingID]
	return id, ok
}

// The record-returning methods are tapped only to learn bindingID -> sessionID;
// behavior is otherwise identical to the embedded store.

func (s *usageSettleStore) UpsertUsageBinding(ctx context.Context, in domain.UsageBindingRecord) (domain.UsageBindingRecord, error) {
	r, err := s.Store.UpsertUsageBinding(ctx, in)
	if err == nil {
		s.remember(r)
	}
	return r, err
}

func (s *usageSettleStore) FinalizeUsageBindingsForSessionLaunch(ctx context.Context, id domain.SessionID, launchID string, revision, at time.Time) ([]domain.UsageBindingRecord, error) {
	records, err := s.Store.FinalizeUsageBindingsForSessionLaunch(ctx, id, launchID, revision, at)
	if err == nil {
		s.remember(records...)
	}
	return records, err
}

func (s *usageSettleStore) ListUsageBindingsForSession(ctx context.Context, id domain.SessionID) ([]domain.UsageBindingRecord, error) {
	records, err := s.Store.ListUsageBindingsForSession(ctx, id)
	if err == nil {
		s.remember(records...)
	}
	return records, err
}

func (s *usageSettleStore) GetUsageBinding(ctx context.Context, id domain.SessionID, harness domain.AgentHarness, nativeRootID string) (domain.UsageBindingRecord, bool, error) {
	r, ok, err := s.Store.GetUsageBinding(ctx, id, harness, nativeRootID)
	if err == nil && ok {
		s.remember(r)
	}
	return r, ok, err
}

// CompleteUsageBindingIfSettled is the trigger: on a genuine settle, if every
// binding of the session is now terminal, emit the session's usage once.
func (s *usageSettleStore) CompleteUsageBindingIfSettled(ctx context.Context, bindingID int64, at time.Time) (bool, error) {
	settled, err := s.Store.CompleteUsageBindingIfSettled(ctx, bindingID, at)
	if err != nil || !settled {
		return settled, err
	}
	sessionID, ok := s.sessionFor(bindingID)
	if !ok {
		return settled, err
	}
	bindings, listErr := s.Store.ListUsageBindingsForSession(ctx, sessionID)
	if listErr == nil && usagetelemetry.AllBindingsSettled(bindings) {
		s.emitter.EmitSessionUsage(ctx, sessionID)
	}
	return settled, err
}
