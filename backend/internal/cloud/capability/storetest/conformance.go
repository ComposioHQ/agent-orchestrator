// Package storetest defines the durable terminal-ticket conformance suite.
package storetest

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
)

// RunCapabilityConformance verifies durable liveness, idempotent revocation,
// selector isolation, and retention cleanup for sandbox capabilities.
func RunCapabilityConformance(t *testing.T, factory func() capability.Store) {
	t.Helper()
	now := time.Date(2026, 8, 23, 20, 0, 0, 0, time.UTC)
	scope := capability.Scope{
		OrgID: "org", WorkspaceID: "workspace", SessionID: "session", Role: capability.RoleWorker,
		Operations: []capability.Operation{capability.OpSessionRead},
	}

	t.Run("persists liveness and preserves first revocation", func(t *testing.T) {
		store := factory()
		record := capability.Record{ID: "grant", Scope: scope, Verifier: "digest", IssuedAt: now, ExpiresAt: now.Add(time.Hour)}
		if err := store.Insert(context.Background(), record); err != nil {
			t.Fatal(err)
		}
		if err := store.Revoke(context.Background(), record.ID, now.Add(time.Minute), "successor"); err != nil {
			t.Fatal(err)
		}
		if err := store.Revoke(context.Background(), record.ID, now.Add(2*time.Minute), "other"); err != nil {
			t.Fatal(err)
		}
		stored, err := store.ByID(context.Background(), record.ID)
		if err != nil {
			t.Fatal(err)
		}
		if !stored.RevokedAt.Equal(now.Add(time.Minute)) || stored.RotatedToID != "successor" {
			t.Fatalf("revoked record = %#v", stored)
		}
	})

	t.Run("scope revocation is isolated and idempotent", func(t *testing.T) {
		store := factory()
		for _, record := range []capability.Record{
			{ID: "inside", Scope: scope, Verifier: "one", IssuedAt: now, ExpiresAt: now.Add(time.Hour)},
			{ID: "outside", Scope: capability.Scope{OrgID: "other", WorkspaceID: "workspace", SessionID: "session", Role: capability.RoleWorker, Operations: []capability.Operation{capability.OpSessionRead}}, Verifier: "two", IssuedAt: now, ExpiresAt: now.Add(time.Hour)},
		} {
			if err := store.Insert(context.Background(), record); err != nil {
				t.Fatal(err)
			}
		}
		selector := capability.Selector{OrgID: "org", WorkspaceID: "workspace", SessionID: "session"}
		if count, err := store.RevokeScope(context.Background(), selector, now); err != nil || count != 1 {
			t.Fatalf("first RevokeScope count=%d err=%v", count, err)
		}
		if count, err := store.RevokeScope(context.Background(), selector, now.Add(time.Minute)); err != nil || count != 0 {
			t.Fatalf("second RevokeScope count=%d err=%v", count, err)
		}
		outside, err := store.ByID(context.Background(), "outside")
		if err != nil || !outside.RevokedAt.IsZero() {
			t.Fatalf("outside record = %#v err=%v", outside, err)
		}
	})

	t.Run("purges only spent rows before cutoff", func(t *testing.T) {
		store := factory()
		for _, record := range []capability.Record{
			{ID: "expired", Scope: scope, Verifier: "expired", IssuedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour)},
			{ID: "live", Scope: scope, Verifier: "live", IssuedAt: now, ExpiresAt: now.Add(time.Hour)},
		} {
			if err := store.Insert(context.Background(), record); err != nil {
				t.Fatal(err)
			}
		}
		if count, err := store.DeleteExpired(context.Background(), now); err != nil || count != 1 {
			t.Fatalf("DeleteExpired count=%d err=%v", count, err)
		}
		if _, err := store.ByID(context.Background(), "expired"); !errors.Is(err, capability.ErrNotFound) {
			t.Fatalf("expired ByID error = %v", err)
		}
		if _, err := store.ByID(context.Background(), "live"); err != nil {
			t.Fatalf("live grant was purged: %v", err)
		}
	})
}

// RunTerminalTicketConformance verifies atomic one-time consumption and
// durable liveness. PostgreSQL adapter tests must invoke it with a fresh store.
func RunTerminalTicketConformance(t *testing.T, factory func() capability.TerminalTicketStore) {
	t.Helper()
	now := time.Date(2026, 8, 23, 20, 0, 0, 0, time.UTC)
	scope := capability.TerminalTicketScope{
		OrgID: "org", WorkspaceID: "workspace", SessionID: "session", SandboxID: "runtime", Role: capability.RoleWorker,
	}

	t.Run("only one concurrent consume succeeds", func(t *testing.T) {
		store := factory()
		verifier := bytes.Repeat([]byte{0x42}, 32)
		ticket := capability.TerminalTicket{ID: "ticket", Verifier: verifier, Scope: scope, IssuedAt: now, ExpiresAt: now.Add(time.Minute)}
		if err := store.Insert(context.Background(), ticket); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		errs := make(chan error, 2)
		var ready sync.WaitGroup
		ready.Add(2)
		for range 2 {
			go func() {
				ready.Done()
				<-start
				_, err := store.Consume(context.Background(), verifier, scope, now.Add(time.Second))
				errs <- err
			}()
		}
		ready.Wait()
		close(start)
		var succeeded, spent int
		for range 2 {
			err := <-errs
			if err == nil {
				succeeded++
			} else if errors.Is(err, capability.ErrTicketSpent) {
				spent++
			} else {
				t.Fatalf("Consume error = %v", err)
			}
		}
		if succeeded != 1 || spent != 1 {
			t.Fatalf("succeeded=%d spent=%d, want one each", succeeded, spent)
		}
	})

	t.Run("scope mismatch does not spend", func(t *testing.T) {
		store := factory()
		verifier := bytes.Repeat([]byte{0x24}, 32)
		ticket := capability.TerminalTicket{ID: "scoped", Verifier: verifier, Scope: scope, IssuedAt: now, ExpiresAt: now.Add(time.Minute)}
		if err := store.Insert(context.Background(), ticket); err != nil {
			t.Fatal(err)
		}
		wrong := scope
		wrong.SessionID = "other"
		if _, err := store.Consume(context.Background(), verifier, wrong, now); !errors.Is(err, capability.ErrTicketNotFound) {
			t.Fatalf("wrong-scope Consume error = %v", err)
		}
		if _, err := store.Consume(context.Background(), verifier, scope, now); err != nil {
			t.Fatalf("correct Consume after mismatch = %v", err)
		}
	})

	t.Run("expiry and revocation are durable", func(t *testing.T) {
		store := factory()
		expiredVerifier := bytes.Repeat([]byte{0x11}, 32)
		expired := capability.TerminalTicket{
			ID: "expired", Verifier: expiredVerifier, Scope: scope, Scopes: []string{"terminal:read"},
			IssuedAt: now.Add(-2 * time.Minute), ExpiresAt: now.Add(-time.Minute),
		}
		if err := store.Insert(context.Background(), expired); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Consume(context.Background(), expiredVerifier, scope, now); !errors.Is(err, capability.ErrTicketExpired) {
			t.Fatalf("expired Consume error = %v", err)
		}

		revokedVerifier := bytes.Repeat([]byte{0x12}, 32)
		revoked := capability.TerminalTicket{
			ID: "revoked", Verifier: revokedVerifier, Scope: scope, Scopes: []string{"terminal:read"},
			IssuedAt: now, ExpiresAt: now.Add(time.Minute),
		}
		if err := store.Insert(context.Background(), revoked); err != nil {
			t.Fatal(err)
		}
		selector := capability.Selector{OrgID: scope.OrgID, WorkspaceID: scope.WorkspaceID, SessionID: scope.SessionID}
		if count, err := store.RevokeScope(context.Background(), selector, now); err != nil || count != 1 {
			t.Fatalf("RevokeScope count=%d err=%v", count, err)
		}
		if _, err := store.Consume(context.Background(), revokedVerifier, scope, now); !errors.Is(err, capability.ErrTicketRevoked) {
			t.Fatalf("revoked Consume error = %v", err)
		}
	})
}
