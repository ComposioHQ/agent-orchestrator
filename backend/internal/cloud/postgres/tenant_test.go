package postgres

import (
	"context"
	"errors"
	"testing"

	storageports "github.com/aoagents/agent-orchestrator/backend/internal/storage/ports"
)

// A store call that reaches the database without a tenant would run unscoped,
// so the scope is resolved before any connection is taken from the pool. These
// cases need no database precisely because the refusal happens first.
func TestTenantFromRefusesAnythingButAWholeTenant(t *testing.T) {
	for _, tc := range []struct {
		name   string
		ctx    context.Context
		wantOK bool
	}{
		{"no tenant at all", context.Background(), false},
		{
			"user without an org",
			storageports.WithTenant(context.Background(), storageports.Tenant{UserID: "user-1"}),
			false,
		},
		{
			"org without a user",
			storageports.WithTenant(context.Background(), storageports.Tenant{OrgID: "org-1"}),
			false,
		},
		{
			"whole tenant",
			storageports.WithTenant(context.Background(), storageports.Tenant{UserID: "user-1", OrgID: "org-1"}),
			true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			scope, err := tenantFrom(tc.ctx)
			if tc.wantOK {
				if err != nil {
					t.Fatalf("tenantFrom = %v, want a scope", err)
				}
				if scope.userID != "user-1" || scope.orgID != "org-1" {
					t.Fatalf("scope = %#v", scope)
				}
				return
			}
			if !errors.Is(err, storageports.ErrTenantRequired) {
				t.Fatalf("tenantFrom = %v, want ErrTenantRequired", err)
			}
		})
	}
}
