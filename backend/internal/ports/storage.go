package ports

import "errors"

// The durable-state ports.
//
// AO's projects, sessions, session worktrees, and conversations are the state
// the sidebar and kanban read and the lifecycle manager advances. Two engines
// persist them: the local desktop daemon uses the SQLite store in
// internal/storage/sqlite/store, and the hosted control plane uses the
// tenant-scoped PostgreSQL store in internal/cloud/postgres. A deployment runs
// exactly one of them — there is no dual-write and no synchronisation layer
// between the two, because two writable copies of a session row have no
// truthful merge.
//
// The interfaces below are deliberately narrow and shaped to what the existing
// services already call, in the signatures they already use. Adopting them is a
// type assertion rather than a rewrite, and the services and HTTP API stay the
// only consumers: a hosted deployment gets the same API, not a second one.
//
// # Tenancy
//
// No port signature carries a tenant argument. Locally there is no tenant; in
// the hosted control plane the tenant rides on the context as a
// tenant.Identity, and the PostgreSQL store projects it onto the session
// variables its row-level security policies read. A cloud store handed a
// context with no identity fails the call — see tenant.ErrNoTenant — rather
// than running an unscoped query, because an unscoped query is a cross-tenant
// read.
//
// # Conformance
//
// internal/storage/conformance holds the one behavioural suite both
// implementations must pass. A new port method belongs in that suite before it
// gains a second implementation.

// The storage error vocabulary. Implementations wrap these so a service can
// branch on the failure without knowing which engine produced it; callers use
// errors.Is, never string matching.
//
// Absence is deliberately not in this list. The read ports report a missing row
// as ok=false with a nil error, because "no such project" is an ordinary answer
// to a lookup rather than a failure. ErrStorageNotFound covers the few writes
// that require the row to already exist.
var (
	// ErrStorageNotFound means the record a write targeted does not exist, or
	// is not visible to the acting tenant — the two are indistinguishable by
	// design, so a probe cannot enumerate another tenant's ids.
	ErrStorageNotFound = errors.New("storage: record not found")
	// ErrStorageConflict means the write lost a uniqueness constraint.
	ErrStorageConflict = errors.New("storage: record conflicts with an existing record")
	// ErrStorageInvalid means the record violates the schema's own integrity
	// rules (a NOT NULL, CHECK, or type constraint), which is a caller bug
	// rather than a transient failure.
	ErrStorageInvalid = errors.New("storage: invalid record")
)
