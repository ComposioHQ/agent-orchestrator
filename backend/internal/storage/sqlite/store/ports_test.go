package store_test

import (
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

// The local SQLite store is one of the two implementations of the durable-state
// ports; the hosted PostgreSQL store in internal/cloud/postgres is the other.
// These assertions are what make "one port, two implementations" a compile
// error to break rather than something the conformance suite discovers at run
// time — a signature that drifts here fails the build of this package.
var (
	_ ports.ProjectStore         = (*store.Store)(nil)
	_ ports.SessionStore         = (*store.Store)(nil)
	_ ports.SessionWorktreeStore = (*store.Store)(nil)
	_ ports.ConversationStore    = (*store.Store)(nil)
	_ ports.ConversationReader   = (*store.Store)(nil)
)
