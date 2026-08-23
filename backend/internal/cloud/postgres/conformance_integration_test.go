package postgres_test

import (
	"context"
	"testing"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres/pgtest"
	storageports "github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/conformance"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

var (
	_ storageports.ProjectStore         = (*postgres.Store)(nil)
	_ storageports.SessionStore         = (*postgres.Store)(nil)
	_ storageports.SessionWorktreeStore = (*postgres.Store)(nil)
)

func TestPostgresCoreStorageConformance(t *testing.T) {
	conformance.Run(t, func(t *testing.T) conformance.Harness {
		store := pgtest.New(t)
		alice := signUp(t, store, "alice")
		bob := signUp(t, store, "bob")
		return conformance.Harness{
			Projects:  store,
			Sessions:  store,
			Worktrees: store,
			Ctx:       tenant.WithIdentity(context.Background(), alice),
			OtherTenant: &conformance.Harness{
				Projects:  store,
				Sessions:  store,
				Worktrees: store,
				Ctx:       tenant.WithIdentity(context.Background(), bob),
			},
		}
	})
}

func TestPostgresRefusesAnUnscopedContext(t *testing.T) {
	store := pgtest.New(t)
	ctx := context.Background()

	if _, err := store.ListProjects(ctx); !isTenantRequired(err) {
		t.Fatalf("ListProjects without a tenant = %v, want ErrNoTenant", err)
	}
	if _, err := store.ListAllSessions(ctx); !isTenantRequired(err) {
		t.Fatalf("ListAllSessions without a tenant = %v, want ErrNoTenant", err)
	}
	if err := store.UpsertProject(ctx, newTenantProject()); !isTenantRequired(err) {
		t.Fatalf("UpsertProject without a tenant = %v, want ErrNoTenant", err)
	}

	half := tenant.WithIdentity(ctx, tenant.Identity{UserID: "not-a-uuid"})
	if _, err := store.ListProjects(half); !isTenantRequired(err) {
		t.Fatalf("ListProjects with half a tenant = %v, want ErrNoTenant", err)
	}
}

func signUp(t *testing.T, store *postgres.Store, name string) tenant.Identity {
	t.Helper()
	ctx := context.Background()
	principal, err := store.UpsertGoogleUser(ctx, clouddomain.Principal{
		ExternalID:  "google-" + name,
		Email:       name + "@example.com",
		DisplayName: name,
	})
	if err != nil {
		t.Fatalf("sign up %s: %v", name, err)
	}
	memberships, err := store.ListMemberships(ctx, principal)
	if err != nil {
		t.Fatalf("list memberships for %s: %v", name, err)
	}
	if len(memberships) != 1 {
		t.Fatalf("%s has %d memberships, want the personal org", name, len(memberships))
	}
	return tenant.Identity{UserID: principal.UserID, OrgID: memberships[0].OrgID}
}
