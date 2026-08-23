package runtime

import (
	"errors"
	"fmt"
)

// The compute plane's error contract. Callers (and the HTTP layer the
// integrator wires) map these to status codes:
//
//	ErrInvalid             -> 400
//	ErrNotFound            -> 404
//	ErrConflict            -> 409
//	QuotaError             -> 429 with the limit surfaced (see below)
//	ErrProviderUnavailable -> 503, retryable
//
// Anything else is an internal error and must not be reported as a tenant
// mistake.
var (
	// ErrInvalid means the request itself is malformed.
	ErrInvalid = errors.New("invalid compute request")
	// ErrNotFound means no placement row exists for the reference.
	ErrNotFound = errors.New("sandbox not found")
	// ErrConflict means another writer changed the row since it was read, or
	// the requested transition is illegal from the current state.
	ErrConflict = errors.New("sandbox changed concurrently")
	// ErrQuotaExceeded is the sentinel every QuotaError matches, so callers can
	// branch on the class without unwrapping the detail.
	ErrQuotaExceeded = errors.New("compute quota exceeded")
	// ErrProviderUnavailable means the sandbox provider could not be reached or
	// failed transiently. It is retryable and is never a tenant error.
	ErrProviderUnavailable = errors.New("sandbox provider unavailable")
	// ErrDeleting means the placement is being torn down and cannot be
	// resurrected; the caller must wait and create a new session.
	ErrDeleting = errors.New("sandbox is being deleted")
)

// QuotaScope names what a limit is counted over.
type QuotaScope string

const (
	// ScopeOrg counts every live sandbox in an organization.
	ScopeOrg QuotaScope = "org"
	// ScopeUser counts every live sandbox owned by one user across orgs they
	// belong to, which is what stops one member exhausting a shared org limit.
	ScopeUser QuotaScope = "user"
	// ScopeWorkspace counts live sandboxes inside one workspace.
	ScopeWorkspace QuotaScope = "workspace"
)

// QuotaError is the clear, machine-readable half of the quota contract: which
// limit was hit, over what subject, what the limit is, and how many are already
// in use. A client can render this without parsing prose, and support can tell
// "raise this org's limit" from "this user is looping".
type QuotaError struct {
	Scope    QuotaScope
	Resource string
	Subject  string
	Limit    int
	InUse    int
}

// Error renders the limit in a stable, greppable form.
func (e *QuotaError) Error() string {
	return fmt.Sprintf("compute quota exceeded: %s %s limit %d reached for %s (%d in use)",
		e.Scope, e.Resource, e.Limit, e.Subject, e.InUse)
}

// Is lets errors.Is(err, ErrQuotaExceeded) match any quota failure.
func (e *QuotaError) Is(target error) bool { return target == ErrQuotaExceeded }

// providerFailure wraps a provider error as retryable without losing the
// original for logs.
func providerFailure(operation string, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrSandboxNotFound) {
		return err
	}
	return fmt.Errorf("%w: %s: %w", ErrProviderUnavailable, operation, err)
}
