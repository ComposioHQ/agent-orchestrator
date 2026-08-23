package storageports

import "errors"

// The port error vocabulary. Store implementations wrap these so services can
// branch on the failure without knowing which engine produced it; callers use
// errors.Is, never string matching.
//
// Absence is not in this list on purpose. The read ports report a missing row
// as ok=false with a nil error, because "no such project" is an ordinary answer
// to a lookup rather than a failure. ErrNotFound covers the writes that require
// a row to already exist.
var (
	// ErrNotFound means the record a write targeted does not exist, or is not
	// visible to the acting tenant — the two are indistinguishable by design.
	ErrNotFound = errors.New("storage: record not found")
	// ErrConflict means the write lost a uniqueness constraint.
	ErrConflict = errors.New("storage: record conflicts with an existing record")
	// ErrInvalid means the record violates the schema's own integrity rules
	// (a NOT NULL, CHECK, or type constraint), which is a caller bug.
	ErrInvalid = errors.New("storage: invalid record")
	// ErrTenantRequired means a tenant-scoped store was called on a context
	// with no resolved tenant. It is deliberately fatal to the request: the
	// alternative is a query that silently spans tenants.
	ErrTenantRequired = errors.New("storage: tenant context required")
)
