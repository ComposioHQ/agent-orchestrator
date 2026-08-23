package storageports

import "context"

// Tenant identifies who a hosted request acts as. It is the only tenancy input
// a store implementation may use: a cloud store must never derive scope from
// row contents, a caller-supplied filter, or an ambient default.
//
// UserID and OrgID are the AO identities minted by the control plane
// (internal/cloud/domain.Principal and .Membership), not provider identities.
type Tenant struct {
	// UserID is the acting AO user.
	UserID string
	// OrgID is the organization the request acts within. A user with several
	// memberships resolves exactly one per request; "all my orgs" is a read
	// the API does not offer.
	OrgID string
}

// IsZero reports whether no tenant was resolved.
func (t Tenant) IsZero() bool { return t.UserID == "" && t.OrgID == "" }

// Valid reports whether both halves of the tenant are present. A half-populated
// tenant is always a bug: row-level security keys on both.
func (t Tenant) Valid() bool { return t.UserID != "" && t.OrgID != "" }

type tenantContextKey struct{}

// WithTenant returns a context carrying tenant. The hosted HTTP layer attaches
// it once per request, after it has loaded memberships from the database;
// nothing below that layer may construct one from untrusted input.
func WithTenant(ctx context.Context, tenant Tenant) context.Context {
	return context.WithValue(ctx, tenantContextKey{}, tenant)
}

// TenantFrom returns the tenant carried by ctx. ok is false in local mode,
// where there is no tenant and the SQLite store ignores this entirely.
func TenantFrom(ctx context.Context) (Tenant, bool) {
	tenant, ok := ctx.Value(tenantContextKey{}).(Tenant)
	if !ok || !tenant.Valid() {
		return Tenant{}, false
	}
	return tenant, true
}
