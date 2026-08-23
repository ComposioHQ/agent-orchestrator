// Package tenant carries the hosted control plane's per-request tenant
// identity — which organization and user a request acts as — through
// context.Context.
//
// The hosted control plane serves the same application API as the local
// daemon, but every store read and write has to be scoped to one organization.
// Threading an orgID parameter through every service and store method would
// mean touching the entire local composition (which must stay behaviorally
// identical) and would make "forgot to pass the org" a silent data leak rather
// than a compile error. Instead the cloud mount resolves the tenant once, in
// one authenticated middleware, and the injected cloud stores read it back
// here. A store that is handed a context with no identity gets ErrNoTenant and
// must fail the request rather than fall back to an unscoped query.
//
// Nothing in the local daemon composition sets an identity: the local stores
// are single-tenant by construction and never call FromContext.
package tenant

import (
	"context"
	"errors"
	"strings"
)

// ErrNoTenant reports that a context reached tenant-scoped code without a
// resolved identity. Cloud stores must treat this as a hard failure — an
// unscoped query is a cross-tenant read.
var ErrNoTenant = errors.New("tenant: request context carries no tenant identity")

// Identity is the resolved tenant for one request: the organization the
// request acts on, and the authenticated user acting.
type Identity struct {
	// OrgID is the organization's stable identifier. Required.
	OrgID string
	// OrgSlug is the organization's human-readable handle. Informational.
	OrgSlug string
	// UserID is the authenticated principal's AO user id. Required.
	UserID string
	// Role is the principal's role within OrgID (owner, admin, member, ...).
	Role string
}

// Valid reports whether the identity carries both scoping fields. An identity
// missing either is never put into a context.
func (i Identity) Valid() bool {
	return strings.TrimSpace(i.OrgID) != "" && strings.TrimSpace(i.UserID) != ""
}

type contextKey struct{}

// WithIdentity returns a context carrying id. An invalid identity is rejected
// rather than stored, so FromContext can never hand a store a half-populated
// scope that would widen a query.
func WithIdentity(ctx context.Context, id Identity) context.Context {
	if !id.Valid() {
		return ctx
	}
	return context.WithValue(ctx, contextKey{}, id)
}

// FromContext returns the request's tenant identity.
func FromContext(ctx context.Context) (Identity, bool) {
	if ctx == nil {
		return Identity{}, false
	}
	id, ok := ctx.Value(contextKey{}).(Identity)
	return id, ok
}

// OrgID returns the organization the request is scoped to, or ErrNoTenant.
// Cloud store implementations call this at the top of every query.
func OrgID(ctx context.Context) (string, error) {
	id, ok := FromContext(ctx)
	if !ok {
		return "", ErrNoTenant
	}
	return id.OrgID, nil
}

// UserID returns the acting principal's id, or ErrNoTenant.
func UserID(ctx context.Context) (string, error) {
	id, ok := FromContext(ctx)
	if !ok {
		return "", ErrNoTenant
	}
	return id.UserID, nil
}
