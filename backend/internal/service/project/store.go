package project

import (
	storageports "github.com/aoagents/agent-orchestrator/backend/internal/storage/ports"
)

// Store is the durable project persistence surface required by Service.
//
// It is an alias for the shared storage port rather than a second declaration
// of the same methods: Service must keep working unchanged whether the daemon
// is running on local SQLite or on the hosted, tenant-scoped PostgreSQL store,
// and two hand-maintained copies of one contract is how that stops being true.
type Store = storageports.ProjectStore
