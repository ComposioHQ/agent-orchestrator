package capability

import (
	"context"
	"sync"
	"time"
)

// MemoryStore keeps grants in process memory. It is the reference
// implementation of Store: single-process deployments and every test in the
// compute plane use it, and a PostgreSQL adapter must reproduce its semantics
// (idempotent revoke, revoked-and-expired retention, selector matching).
type MemoryStore struct {
	mu      sync.RWMutex
	records map[string]Record
}

// NewMemoryStore returns an empty in-memory capability store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{records: make(map[string]Record)}
}

var _ Store = (*MemoryStore)(nil)

// Insert persists a grant, refusing a duplicate id.
func (s *MemoryStore) Insert(_ context.Context, record Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.records[record.ID]; exists {
		return ErrConflict
	}
	s.records[record.ID] = record
	return nil
}

// ByID loads one grant.
func (s *MemoryStore) ByID(_ context.Context, id string) (Record, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.records[id]
	if !ok {
		return Record{}, ErrNotFound
	}
	return record, nil
}

// Revoke marks a grant revoked. Re-revoking keeps the original instant so the
// audit trail records when access actually ended.
func (s *MemoryStore) Revoke(_ context.Context, id string, at time.Time, rotatedToID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.records[id]
	if !ok {
		return ErrNotFound
	}
	if record.RevokedAt.IsZero() {
		record.RevokedAt = at.UTC()
	}
	if rotatedToID != "" && record.RotatedToID == "" {
		record.RotatedToID = rotatedToID
	}
	s.records[id] = record
	return nil
}

// RevokeScope revokes every live grant matching the selector.
func (s *MemoryStore) RevokeScope(_ context.Context, selector Selector, at time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	revoked := 0
	for id, record := range s.records {
		if !record.RevokedAt.IsZero() || !selector.Matches(record.Scope) {
			continue
		}
		record.RevokedAt = at.UTC()
		s.records[id] = record
		revoked++
	}
	return revoked, nil
}

// DeleteExpired drops grants that stopped being usable before the cutoff.
func (s *MemoryStore) DeleteExpired(_ context.Context, before time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	deleted := 0
	for id, record := range s.records {
		expired := !record.ExpiresAt.IsZero() && record.ExpiresAt.Before(before)
		revoked := !record.RevokedAt.IsZero() && record.RevokedAt.Before(before)
		if expired || revoked {
			delete(s.records, id)
			deleted++
		}
	}
	return deleted, nil
}

// Len reports how many grant rows are retained. Tests use it to assert purge
// behavior without reaching into the map.
func (s *MemoryStore) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.records)
}
