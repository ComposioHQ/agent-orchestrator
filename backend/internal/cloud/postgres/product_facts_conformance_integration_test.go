package postgres_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres/pgtest"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/storagetest"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

func TestPostgresProductFactsConformance(t *testing.T) {
	store := pgtest.New(t)
	alice := signUp(t, store, "product-facts-alice")
	bob := signUp(t, store, "product-facts-bob")
	ctx := tenant.WithIdentity(context.Background(), alice)
	project := newTenantProject()
	project.ID = "product-facts"
	project.Path = "/repos/product-facts"
	if err := store.UpsertProject(ctx, project); err != nil {
		t.Fatal(err)
	}
	projectID := domain.ProjectID(project.ID)
	first, err := store.CreateSession(ctx, productFactSession(projectID))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.CreateSession(ctx, productFactSession(projectID))
	if err != nil {
		t.Fatal(err)
	}
	storagetest.RunProductFactsConformance(t, ctx, storagetest.ProductFactsFixture{Store: store, ProjectID: projectID, SessionID: first.ID, OtherSessionID: second.ID})

	bobCtx := tenant.WithIdentity(context.Background(), bob)
	if _, ok, err := store.GetPR(bobCtx, "https://github.com/acme/repo/pull/7"); err != nil || ok {
		t.Fatalf("cross-tenant GetPR = ok:%v err:%v", ok, err)
	}
	forged := tenant.WithIdentity(context.Background(), tenant.Identity{OrgID: alice.OrgID, UserID: bob.UserID})
	pr := domain.PullRequest{URL: "https://github.com/acme/repo/pull/forged", SessionID: first.ID, Number: 8, UpdatedAt: time.Now().UTC()}
	if err := store.WriteSCMObservation(forged, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err == nil {
		t.Fatal("cross-tenant PR write succeeded")
	}
}

func productFactSession(project domain.ProjectID) domain.SessionRecord {
	now := time.Date(2026, 8, 23, 13, 0, 0, 0, time.UTC)
	return domain.SessionRecord{ProjectID: project, Kind: domain.KindWorker, Harness: domain.HarnessCodex, Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now}, Metadata: domain.SessionMetadata{Branch: "feature", WorkspacePath: "/workspace"}, CreatedAt: now, UpdatedAt: now, AutoInjectReview: true, AutoInjectCI: true}
}
