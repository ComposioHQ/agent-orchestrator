package runtime

import (
	"context"
	"time"
)

// Store is the compute plane's durable placement port. It is consumer-owned
// and deliberately narrow: this package defines what it needs and the storage
// worker's adapter (or the in-memory reference implementation in runtimetest)
// satisfies it. Nothing here exposes a transaction or a SQL type.
//
// Every mutation is generation-checked. A writer presents the generation it
// read; the store applies the change only if the row still carries it and
// returns ErrConflict otherwise. That is what makes concurrent Ensure/Stop/
// Delete calls and the reconciler safe against each other without a lock.
type Store interface {
	// Ensure returns the live placement for a ref, creating it in
	// StateProvisioning when absent. created reports whether this call was the
	// one that inserted the row, which is how the lifecycle keeps create
	// idempotent under concurrent callers.
	//
	// A row in StateDeleting must NOT be resurrected: implementations return
	// the existing record with created=false, and the caller maps that to
	// ErrDeleting.
	// Quota evaluation and insertion are one atomic reservation. Adapters must
	// serialize competing reservations for the affected org/user/workspace
	// (for example with transaction-scoped advisory locks in PostgreSQL).
	Ensure(ctx context.Context, ref Ref, quotas Quotas, now time.Time) (record Record, created bool, err error)
	// Get loads the placement for a ref, returning ErrNotFound when absent.
	Get(ctx context.Context, ref Ref) (Record, error)
	// GetByID loads a placement by row id, returning ErrNotFound when absent.
	GetByID(ctx context.Context, id string) (Record, error)
	// Save persists a mutated record, returning ErrConflict when the presented
	// generation is stale. The returned record carries the new generation.
	Save(ctx context.Context, record Record) (Record, error)
	// Delete removes a row that has already been torn down at the provider. It
	// returns ErrConflict on a stale generation and succeeds when the row is
	// already gone, so a retried cascade converges.
	Delete(ctx context.Context, id string, generation int64) error
	// List returns placements matching a filter, oldest first.
	List(ctx context.Context, filter Filter) ([]Record, error)
}

// Filter selects placements. Empty string fields are wildcards; the zero
// Filter matches every row in every tenant, which only the reconciler uses.
type Filter struct {
	OrgID       string
	WorkspaceID string
	SessionID   string
	UserID      string
	Role        Role
	// States, when non-empty, restricts the match to those states.
	States []State
	// ExcludeTerminal drops rows already on their way out (StateDeleting).
	// Quota counting sets it so a session being torn down does not block its
	// replacement.
	ExcludeTerminal bool
	// HeartbeatBefore, when non-zero, matches rows whose last heartbeat is
	// strictly older than the instant — including rows that never checked in,
	// which are matched on CreatedAt instead.
	HeartbeatBefore time.Time
	// UpdatedBefore, when non-zero, matches rows not touched since the instant.
	UpdatedBefore time.Time
}

// Matches reports whether a record satisfies the filter. Store adapters that
// can push the predicate into a query should; this helper keeps the semantics
// in one tested place and is what the in-memory reference store uses.
func (f Filter) Matches(record Record) bool {
	if f.OrgID != "" && record.OrgID != f.OrgID {
		return false
	}
	if f.WorkspaceID != "" && record.WorkspaceID != f.WorkspaceID {
		return false
	}
	if f.SessionID != "" && record.SessionID != f.SessionID {
		return false
	}
	if f.UserID != "" && record.UserID != f.UserID {
		return false
	}
	if f.Role != "" && record.Role != f.Role {
		return false
	}
	if f.ExcludeTerminal && record.State.Terminal() {
		return false
	}
	if len(f.States) > 0 {
		matched := false
		for _, state := range f.States {
			if record.State == state {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	if !f.HeartbeatBefore.IsZero() && !lastContact(record).Before(f.HeartbeatBefore) {
		return false
	}
	if !f.UpdatedBefore.IsZero() && !record.UpdatedAt.Before(f.UpdatedBefore) {
		return false
	}
	return true
}

// lastContact is the most recent evidence that a placement is wanted: an
// authenticated heartbeat if one ever arrived, otherwise the moment the row was
// created. Falling back to CreatedAt is what lets the reaper collect a sandbox
// that was provisioned for a session nobody ever attached to.
func lastContact(record Record) time.Time {
	if !record.LastHeartbeatAt.IsZero() {
		return record.LastHeartbeatAt
	}
	return record.CreatedAt
}
