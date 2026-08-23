package ports

import "errors"

// The durable core-state ports are implemented by both the local SQLite store
// and the hosted, tenant-scoped PostgreSQL store. Services remain the only
// consumers: a deployment selects one store implementation and never dual
// writes between them.
//
// Tenant identity is carried by context rather than method arguments. SQLite
// ignores it; PostgreSQL requires tenant.Identity and refuses an unscoped call.
var (
	ErrStorageNotFound = errors.New("storage: record not found")
	ErrStorageConflict = errors.New("storage: record conflicts with an existing record")
	ErrStorageInvalid  = errors.New("storage: invalid record")
)
