package tenant_test

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

func TestFromContextRoundTrips(t *testing.T) {
	want := tenant.Identity{OrgID: "org_1", OrgSlug: "acme", UserID: "usr_1", Role: "owner"}
	ctx := tenant.WithIdentity(context.Background(), want)

	got, ok := tenant.FromContext(ctx)
	if !ok {
		t.Fatal("expected an identity in context")
	}
	if got != want {
		t.Fatalf("identity = %+v, want %+v", got, want)
	}
	orgID, err := tenant.OrgID(ctx)
	if err != nil || orgID != "org_1" {
		t.Fatalf("OrgID = %q, %v; want org_1, nil", orgID, err)
	}
	userID, err := tenant.UserID(ctx)
	if err != nil || userID != "usr_1" {
		t.Fatalf("UserID = %q, %v; want usr_1, nil", userID, err)
	}
}

// A half-populated identity must not reach a store: a blank OrgID would widen
// an org-scoped query into a cross-tenant read.
func TestWithIdentityRejectsIncompleteScope(t *testing.T) {
	for name, id := range map[string]tenant.Identity{
		"no org":    {UserID: "usr_1"},
		"no user":   {OrgID: "org_1"},
		"blank org": {OrgID: "   ", UserID: "usr_1"},
		"empty":     {},
	} {
		t.Run(name, func(t *testing.T) {
			ctx := tenant.WithIdentity(context.Background(), id)
			if _, ok := tenant.FromContext(ctx); ok {
				t.Fatalf("incomplete identity %+v was stored in context", id)
			}
		})
	}
}

func TestOrgIDWithoutIdentityFails(t *testing.T) {
	if _, err := tenant.OrgID(context.Background()); !errors.Is(err, tenant.ErrNoTenant) {
		t.Fatalf("OrgID error = %v, want ErrNoTenant", err)
	}
	if _, err := tenant.UserID(context.Background()); !errors.Is(err, tenant.ErrNoTenant) {
		t.Fatalf("UserID error = %v, want ErrNoTenant", err)
	}
	//nolint:staticcheck // deliberately exercising the nil-context guard
	if _, ok := tenant.FromContext(nil); ok {
		t.Fatal("nil context reported an identity")
	}
}
