package store_test

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/storage/conformance"
	storageports "github.com/aoagents/agent-orchestrator/backend/internal/storage/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

// The SQLite store is the local-mode implementation of the storage ports. These
// assertions fail at compile time if a port method is added without it.
var (
	_ storageports.ProjectStore         = (*sqlite.Store)(nil)
	_ storageports.SessionStore         = (*sqlite.Store)(nil)
	_ storageports.SessionWorktreeStore = (*sqlite.Store)(nil)
)

func TestSQLiteStorageConformance(t *testing.T) {
	conformance.Run(t, func(t *testing.T) conformance.Harness {
		store := sqlitetest.MustOpen(t)
		return conformance.Harness{
			Projects:  store,
			Sessions:  store,
			Worktrees: store,
		}
	})
}
