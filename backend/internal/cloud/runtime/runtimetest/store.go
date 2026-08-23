// Package runtimetest provides the compute plane's in-memory reference store
// and a scriptable sandbox provider fake.
//
// Both are exported rather than kept as unexported test helpers so the
// integrator can wire a working compute plane (and write control-plane HTTP
// tests) before the PostgreSQL placement adapter lands, and so the eventual
// adapter has an executable definition of the semantics it must reproduce:
// generation-checked writes, non-resurrecting deletes, and idempotent Ensure.
package runtimetest

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
)

// MemoryStore is an in-memory runtime.Store.
type MemoryStore struct {
	mu      sync.Mutex
	records map[string]runtime.Record
	nextID  int
	// FailNextSave, when non-nil, is returned by the next Save and then
	// cleared. Tests use it to exercise partial-failure recovery.
	FailNextSave error
	// FailNextDelete behaves the same way for Delete.
	FailNextDelete error
}

// NewMemoryStore returns an empty store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{records: make(map[string]runtime.Record)}
}

var _ runtime.Store = (*MemoryStore)(nil)

func placementKey(ref runtime.Ref) string {
	return ref.OrgID + "\x00" + ref.WorkspaceID + "\x00" + ref.SessionID
}

func (s *MemoryStore) findLocked(ref runtime.Ref) (runtime.Record, bool) {
	key := placementKey(ref)
	for _, record := range s.records {
		if placementKey(record.Ref()) == key {
			return record, true
		}
	}
	return runtime.Record{}, false
}

// Ensure inserts a placement row when absent.
func (s *MemoryStore) Ensure(_ context.Context, ref runtime.Ref, now time.Time) (runtime.Record, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.findLocked(ref); ok {
		if existing.Role != ref.Role {
			return runtime.Record{}, false, runtime.ErrConflict
		}
		return existing, false, nil
	}
	s.nextID++
	record := runtime.Record{
		ID:           fmt.Sprintf("rt-%d", s.nextID),
		OrgID:        ref.OrgID,
		WorkspaceID:  ref.WorkspaceID,
		SessionID:    ref.SessionID,
		UserID:       ref.UserID,
		Role:         ref.Role,
		State:        runtime.StateProvisioning,
		DesiredState: runtime.StateRunning,
		Generation:   1,
		CreatedAt:    now.UTC(),
		UpdatedAt:    now.UTC(),
	}
	s.records[record.ID] = record
	return record, true, nil
}

// Get loads a placement by reference.
func (s *MemoryStore) Get(_ context.Context, ref runtime.Ref) (runtime.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.findLocked(ref)
	if !ok {
		return runtime.Record{}, runtime.ErrNotFound
	}
	return record, nil
}

// GetByID loads a placement by row id.
func (s *MemoryStore) GetByID(_ context.Context, id string) (runtime.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.records[id]
	if !ok {
		return runtime.Record{}, runtime.ErrNotFound
	}
	return record, nil
}

// Save applies a generation-checked update.
func (s *MemoryStore) Save(_ context.Context, record runtime.Record) (runtime.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.FailNextSave; err != nil {
		s.FailNextSave = nil
		return runtime.Record{}, err
	}
	current, ok := s.records[record.ID]
	if !ok {
		return runtime.Record{}, runtime.ErrNotFound
	}
	if current.Generation != record.Generation {
		return runtime.Record{}, runtime.ErrConflict
	}
	record.Generation = current.Generation + 1
	record.CreatedAt = current.CreatedAt
	s.records[record.ID] = record
	return record, nil
}

// Delete removes a row, refusing a stale generation.
func (s *MemoryStore) Delete(_ context.Context, id string, generation int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.FailNextDelete; err != nil {
		s.FailNextDelete = nil
		return err
	}
	current, ok := s.records[id]
	if !ok {
		return nil
	}
	if current.Generation != generation {
		return runtime.ErrConflict
	}
	delete(s.records, id)
	return nil
}

// List returns matching rows, oldest first.
func (s *MemoryStore) List(_ context.Context, filter runtime.Filter) ([]runtime.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.matchLocked(filter), nil
}

// Count returns how many rows match.
func (s *MemoryStore) Count(_ context.Context, filter runtime.Filter) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.matchLocked(filter)), nil
}

func (s *MemoryStore) matchLocked(filter runtime.Filter) []runtime.Record {
	matched := make([]runtime.Record, 0, len(s.records))
	for _, record := range s.records {
		if filter.Matches(record) {
			matched = append(matched, record)
		}
	}
	runtime.SortRecords(matched)
	return matched
}

// Len reports how many rows the store holds.
func (s *MemoryStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.records)
}

// Put installs a record directly, bypassing generation checks. Tests use it to
// stage states the lifecycle would not normally produce.
func (s *MemoryStore) Put(record runtime.Record) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if record.ID == "" {
		s.nextID++
		record.ID = fmt.Sprintf("rt-%d", s.nextID)
	}
	if record.Generation == 0 {
		record.Generation = 1
	}
	s.records[record.ID] = record
}
