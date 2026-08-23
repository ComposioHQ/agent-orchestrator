package store_test

import (
	"testing"

	storageports "github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/conformance"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

var (
	_ storageports.ProjectStore         = (*sqlite.Store)(nil)
	_ storageports.SessionStore         = (*sqlite.Store)(nil)
	_ storageports.SessionWorktreeStore = (*sqlite.Store)(nil)
)

func TestSQLiteCoreStorageConformance(t *testing.T) {
	conformance.Run(t, func(t *testing.T) conformance.Harness {
		store := sqlitetest.MustOpen(t)
		return conformance.Harness{
			Projects:  store,
			Sessions:  store,
			Worktrees: store,
		}
	})
}
