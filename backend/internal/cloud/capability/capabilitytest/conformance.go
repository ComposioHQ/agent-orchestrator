// Package capabilitytest holds the conformance suite every capability store
// adapter must pass. It is a separate package so the production capability
// package never imports testing.
package capabilitytest

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
)

// StoreFactory builds an empty capability store for one conformance case.
type StoreFactory func(t *testing.T) capability.Store

// RunStoreConformance exercises every semantic the authority depends on. It
// exists so a PostgreSQL grant adapter can prove it matches the in-memory
// reference: the credential guarantees (revocation takes effect immediately,
// re-revoking preserves when access actually ended, a scope selector cannot
// escape its organization) are all store behaviour, and each is easy to get
// subtly wrong in SQL.
//
// Call it from the adapter's own test package:
//
//	func TestPostgresCapabilityStore(t *testing.T) {
//	    capabilitytest.RunStoreConformance(t, func(t *testing.T) capability.Store { ... })
//	}
func RunStoreConformance(t *testing.T, newStore StoreFactory) {
	t.Helper()
	ctx := context.Background()
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)

	scope := func(org, workspace, session string) capability.Scope {
		normalized, err := capability.Scope{
			OrgID: org, WorkspaceID: workspace, SessionID: session,
			Role:       capability.RoleWorker,
			Operations: []capability.Operation{capability.OpSandboxHeartbeat},
		}.Normalize()
		if err != nil {
			t.Fatalf("building a test scope: %v", err)
		}
		return normalized
	}
	record := func(id string, scope capability.Scope, expiresAt time.Time) capability.Record {
		return capability.Record{ID: id, Scope: scope, Verifier: "verifier-" + id, IssuedAt: now, ExpiresAt: expiresAt}
	}

	t.Run("insert and load round-trip the scope", func(t *testing.T) {
		store := newStore(t)
		original := record("grant-1", scope("org-1", "ws-1", "sess-1"), now.Add(time.Hour))
		if err := store.Insert(ctx, original); err != nil {
			t.Fatal(err)
		}
		loaded, err := store.ByID(ctx, "grant-1")
		if err != nil {
			t.Fatal(err)
		}
		if loaded.Verifier != original.Verifier || !loaded.ExpiresAt.Equal(original.ExpiresAt) {
			t.Fatalf("loaded = %#v", loaded)
		}
		// The operation allow-list is the authorization decision; losing it in
		// persistence would silently deny (or, worse, widen) every request.
		if len(loaded.Scope.Operations) != 1 || loaded.Scope.Operations[0] != capability.OpSandboxHeartbeat {
			t.Fatalf("operations = %#v", loaded.Scope.Operations)
		}
		if loaded.Scope.Role != capability.RoleWorker || loaded.Scope.SessionID != "sess-1" {
			t.Fatalf("scope = %#v", loaded.Scope)
		}
	})

	t.Run("insert refuses a duplicate id", func(t *testing.T) {
		store := newStore(t)
		original := record("grant-1", scope("org-1", "ws-1", "sess-1"), now.Add(time.Hour))
		if err := store.Insert(ctx, original); err != nil {
			t.Fatal(err)
		}
		if err := store.Insert(ctx, original); err == nil {
			t.Fatal("a duplicate grant id was accepted; a collision would let one grant's secret authorize another's scope")
		}
	})

	t.Run("missing grants report capability.ErrNotFound", func(t *testing.T) {
		store := newStore(t)
		if _, err := store.ByID(ctx, "absent"); !errors.Is(err, capability.ErrNotFound) {
			t.Fatalf("ByID err = %v, want capability.ErrNotFound", err)
		}
		if err := store.Revoke(ctx, "absent", now, ""); !errors.Is(err, capability.ErrNotFound) {
			t.Fatalf("Revoke err = %v, want capability.ErrNotFound", err)
		}
	})

	t.Run("revoke is idempotent and records the first instant", func(t *testing.T) {
		store := newStore(t)
		if err := store.Insert(ctx, record("grant-1", scope("org-1", "ws-1", "sess-1"), now.Add(time.Hour))); err != nil {
			t.Fatal(err)
		}
		if err := store.Revoke(ctx, "grant-1", now, "grant-2"); err != nil {
			t.Fatal(err)
		}
		if err := store.Revoke(ctx, "grant-1", now.Add(time.Hour), "grant-3"); err != nil {
			t.Fatalf("second Revoke = %v, want nil so cascade retries converge", err)
		}
		loaded, err := store.ByID(ctx, "grant-1")
		if err != nil {
			t.Fatal(err)
		}
		// Moving the instant forward would misreport when access ended.
		if !loaded.RevokedAt.Equal(now) {
			t.Fatalf("revoked at = %s, want the first revocation %s", loaded.RevokedAt, now)
		}
		if loaded.RotatedToID != "grant-2" {
			t.Fatalf("rotated to = %q, want the first successor", loaded.RotatedToID)
		}
	})

	t.Run("revokeScope stays inside its selector", func(t *testing.T) {
		store := newStore(t)
		grants := map[string]capability.Scope{
			"mine":      scope("org-1", "ws-1", "sess-1"),
			"sibling":   scope("org-1", "ws-1", "sess-2"),
			"workspace": scope("org-1", "ws-2", "sess-3"),
			"foreign":   scope("org-2", "ws-1", "sess-1"),
		}
		for id, granted := range grants {
			if err := store.Insert(ctx, record(id, granted, now.Add(time.Hour))); err != nil {
				t.Fatal(err)
			}
		}
		revoked, err := store.RevokeScope(ctx, capability.Selector{OrgID: "org-1", WorkspaceID: "ws-1", SessionID: "sess-1"}, now)
		if err != nil {
			t.Fatal(err)
		}
		if revoked != 1 {
			t.Fatalf("session revocation count = %d, want 1", revoked)
		}
		revoked, err = store.RevokeScope(ctx, capability.Selector{OrgID: "org-1", WorkspaceID: "ws-1"}, now)
		if err != nil {
			t.Fatal(err)
		}
		// Already-revoked grants must not be recounted, or a workspace
		// teardown reports work it did not do.
		if revoked != 1 {
			t.Fatalf("workspace revocation count = %d, want 1", revoked)
		}
		revoked, err = store.RevokeScope(ctx, capability.Selector{OrgID: "org-1"}, now)
		if err != nil {
			t.Fatal(err)
		}
		if revoked != 1 {
			t.Fatalf("organization revocation count = %d, want the remaining workspace grant", revoked)
		}
		foreign, err := store.ByID(ctx, "foreign")
		if err != nil {
			t.Fatal(err)
		}
		if !foreign.RevokedAt.IsZero() {
			t.Fatal("another organization's grant was revoked")
		}
	})

	t.Run("deleteExpired drops only spent grants past the cutoff", func(t *testing.T) {
		store := newStore(t)
		if err := store.Insert(ctx, record("live", scope("org-1", "ws-1", "sess-1"), now.Add(time.Hour))); err != nil {
			t.Fatal(err)
		}
		if err := store.Insert(ctx, record("expired", scope("org-1", "ws-1", "sess-2"), now.Add(time.Minute))); err != nil {
			t.Fatal(err)
		}
		if err := store.Insert(ctx, record("revoked", scope("org-1", "ws-1", "sess-3"), now.Add(time.Hour))); err != nil {
			t.Fatal(err)
		}
		if err := store.Revoke(ctx, "revoked", now.Add(time.Minute), ""); err != nil {
			t.Fatal(err)
		}

		deleted, err := store.DeleteExpired(ctx, now)
		if err != nil {
			t.Fatal(err)
		}
		if deleted != 0 {
			t.Fatalf("deleted %d before the cutoff, want 0", deleted)
		}
		deleted, err = store.DeleteExpired(ctx, now.Add(2*time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		if deleted != 2 {
			t.Fatalf("deleted %d, want the expired and revoked grants", deleted)
		}
		if _, err := store.ByID(ctx, "live"); err != nil {
			t.Fatalf("a live grant was purged: %v", err)
		}
	})
}
