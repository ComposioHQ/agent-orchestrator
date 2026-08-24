package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres/pgtest"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

func TestWorkspacePlacementStoreIdempotencyAndTenantScope(t *testing.T) {
	store := pgtest.New(t)
	ctx := context.Background()
	principal, err := store.UpsertGoogleUser(ctx, domain.Principal{
		Provider: "google", ExternalID: "placement-owner", Email: "placement@example.com", DisplayName: "Placement",
	})
	if err != nil {
		t.Fatal(err)
	}
	memberships, err := store.ListMemberships(ctx, principal)
	if err != nil || len(memberships) != 1 {
		t.Fatalf("memberships=%#v err=%v", memberships, err)
	}
	identity := tenant.Identity{OrgID: memberships[0].OrgID, OrgSlug: memberships[0].OrgSlug, UserID: principal.UserID, Role: memberships[0].Role}
	ctx = tenant.WithIdentity(ctx, identity)

	input := domain.CreateWorkspacePlacement{
		DisplayName: "App", RepositoryURL: "https://github.com/acme/app.git", DefaultBranch: "main",
		Config: json.RawMessage(`{"region":"us-west-2"}`), IdempotencyKey: "create-1",
	}
	first, created, err := store.CreateWorkspacePlacement(ctx, input)
	if err != nil || !created {
		t.Fatalf("first=%#v created=%v err=%v", first, created, err)
	}
	replay, created, err := store.CreateWorkspacePlacement(ctx, input)
	if err != nil || created || replay.ID != first.ID {
		t.Fatalf("replay=%#v created=%v err=%v", replay, created, err)
	}
	conflicting := input
	conflicting.RepositoryURL = "https://github.com/acme/other.git"
	if _, _, err := store.CreateWorkspacePlacement(ctx, conflicting); !errors.Is(err, postgres.ErrConflict) {
		t.Fatalf("conflicting idempotency key err=%v", err)
	}

	deleting, changed, err := store.RequestWorkspacePlacementDelete(ctx, first.ID, "delete-1")
	if err != nil || !changed || deleting.Intent != domain.WorkspacePlacementDelete {
		t.Fatalf("delete=%#v changed=%v err=%v", deleting, changed, err)
	}
	replayedDelete, changed, err := store.RequestWorkspacePlacementDelete(ctx, first.ID, "delete-1")
	if err != nil || changed || replayedDelete.ID != first.ID {
		t.Fatalf("delete replay=%#v changed=%v err=%v", replayedDelete, changed, err)
	}
	if _, _, err := store.RequestWorkspacePlacementResume(ctx, first.ID, "delete-1"); !errors.Is(err, postgres.ErrConflict) {
		t.Fatalf("cross-operation idempotency key err=%v", err)
	}

	page, err := store.ListWorkspacePlacements(ctx, "", 25)
	if err != nil || len(page.Workspaces) != 1 || page.Workspaces[0].OwnerUserID != principal.UserID {
		t.Fatalf("page=%#v err=%v", page, err)
	}
	foreign := tenant.WithIdentity(context.Background(), tenant.Identity{
		OrgID: "cf4ab195-2222-4934-b40c-b3621d279c44", OrgSlug: "foreign", UserID: principal.UserID, Role: "owner",
	})
	if _, err := store.GetWorkspacePlacement(foreign, first.ID); !errors.Is(err, postgres.ErrNotFound) {
		t.Fatalf("cross-tenant get err=%v", err)
	}
}
