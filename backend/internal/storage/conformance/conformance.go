// Package conformance is the one behavioural contract every storage port
// implementation must satisfy.
//
// Both the local SQLite store and the hosted PostgreSQL store run this suite.
// It exists because the two engines differ in ways that are easy to get wrong
// and invisible in unit tests written against a single backend: NULL versus
// empty-string columns, JSON round-tripping, timestamp precision and location,
// ordering with no explicit ORDER BY, and "how many rows did that update
// touch". Anything a service is allowed to rely on belongs here.
//
// A new port method must gain a case in this suite before it gains a second
// implementation.
package conformance

import (
	"context"
	"testing"

	storageports "github.com/aoagents/agent-orchestrator/backend/internal/storage/ports"
)

// Harness is one implementation's view of a store, ready for a single test.
// Each call to a Factory must produce an empty store: the suite never cleans up
// after itself.
type Harness struct {
	Projects  storageports.ProjectStore
	Sessions  storageports.SessionStore
	Worktrees storageports.SessionWorktreeStore

	// Ctx is the context every store call in the suite runs under. A hosted
	// implementation puts its tenant on it; the local one supplies a plain
	// background context.
	Ctx context.Context

	// OtherTenant is a second tenant's view of the SAME underlying store. It is
	// nil for implementations that have no tenancy, and the cross-tenant
	// isolation assertions are skipped for those. When it is set, the suite
	// requires that neither tenant can read, update, or even detect the
	// existence of the other's rows.
	OtherTenant *Harness
}

func (h Harness) ctx() context.Context {
	if h.Ctx == nil {
		return context.Background()
	}
	return h.Ctx
}

// Factory builds a fresh, empty harness for one test.
type Factory func(t *testing.T) Harness

// Run executes the whole contract. Callers name the subtest after their
// implementation so a failure identifies the engine as well as the behaviour.
func Run(t *testing.T, newHarness Factory) {
	t.Helper()
	t.Run("Projects", func(t *testing.T) { runProjects(t, newHarness) })
	t.Run("Sessions", func(t *testing.T) { runSessions(t, newHarness) })
	t.Run("SessionWorktrees", func(t *testing.T) { runSessionWorktrees(t, newHarness) })
	t.Run("TenantIsolation", func(t *testing.T) { runTenantIsolation(t, newHarness) })
}
