// Package conformance defines the shared behavioral contract for the local
// SQLite and tenant-scoped PostgreSQL core stores.
package conformance

import (
	"context"
	"testing"

	storageports "github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Harness is one empty implementation under test. OtherTenant, when present,
// views the same database through a different tenant identity.
type Harness struct {
	Projects  storageports.ProjectStore
	Sessions  storageports.SessionStore
	Worktrees storageports.SessionWorktreeStore

	Ctx         context.Context
	OtherTenant *Harness
}

func (h Harness) ctx() context.Context {
	if h.Ctx == nil {
		return context.Background()
	}
	return h.Ctx
}

type Factory func(t *testing.T) Harness

// Run executes the complete core-store contract.
func Run(t *testing.T, newHarness Factory) {
	t.Helper()
	t.Run("Projects", func(t *testing.T) { runProjects(t, newHarness) })
	t.Run("Sessions", func(t *testing.T) { runSessions(t, newHarness) })
	t.Run("SessionWorktrees", func(t *testing.T) { runSessionWorktrees(t, newHarness) })
	t.Run("TenantIsolation", func(t *testing.T) { runTenantIsolation(t, newHarness) })
}
