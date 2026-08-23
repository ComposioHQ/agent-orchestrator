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

// TestPostgresProductPersistenceConformance runs through pgtest.New, whose
// store connection uses the restricted runtime role rather than the migration
// owner. It therefore covers both adapter conformance and forced-RLS behavior.
func TestPostgresProductPersistenceConformance(t *testing.T) {
	store := pgtest.New(t)
	alice := signUp(t, store, "product-alice")
	bob := signUp(t, store, "product-bob")
	aliceCtx := tenant.WithIdentity(context.Background(), alice)
	bobCtx := tenant.WithIdentity(context.Background(), bob)

	settings, err := store.GetAppSettings(aliceCtx)
	if err != nil || settings.DefaultSessionMode != domain.SessionModeChat {
		t.Fatalf("default settings = %+v err=%v", settings, err)
	}
	storagetest.RunPreferenceConformance(t, aliceCtx, store)

	project := newTenantProject()
	project.ID = "product-facts"
	project.Path = "/repos/product-facts"
	if err := store.UpsertProject(aliceCtx, project); err != nil {
		t.Fatal(err)
	}
	projectID := domain.ProjectID(project.ID)
	first, err := store.CreateSession(aliceCtx, productFactSession(projectID))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.CreateSession(aliceCtx, productFactSession(projectID))
	if err != nil {
		t.Fatal(err)
	}
	storagetest.RunProductFactsConformance(t, aliceCtx, storagetest.ProductFactsFixture{
		Store: store, ProjectID: projectID, SessionID: first.ID, OtherSessionID: second.ID,
	})
	storagetest.RunReviewRunConformance(t, aliceCtx, storagetest.ReviewRunFixture{
		Store: store, ProjectID: projectID, SessionID: first.ID,
	})

	if _, ok, err := store.GetPR(bobCtx, "https://github.com/acme/repo/pull/7"); err != nil || ok {
		t.Fatalf("cross-tenant GetPR = ok:%v err:%v", ok, err)
	}
	forged := tenant.WithIdentity(context.Background(), tenant.Identity{OrgID: alice.OrgID, UserID: bob.UserID})
	pr := domain.PullRequest{URL: "https://github.com/acme/repo/pull/forged", SessionID: first.ID, Number: 8, UpdatedAt: time.Now().UTC()}
	if err := store.WriteSCMObservation(forged, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err == nil {
		t.Fatal("cross-tenant PR write succeeded")
	}
	if err := store.SetDefaultSessionMode(forged, domain.SessionModeTUI, time.Now().UTC()); err == nil {
		t.Fatal("cross-tenant settings write succeeded")
	}
	if err := store.UpsertAgentInventoryCache(forged, `{}`, time.Now().UTC()); err == nil {
		t.Fatal("cross-tenant inventory write succeeded")
	}
	if err := store.InsertReviewRun(forged, domain.ReviewRun{
		ID: "forged-run", ReviewID: "review-conformance", SessionID: first.ID,
		Harness: domain.ReviewerCodex, Status: domain.ReviewRunRunning, CreatedAt: time.Now().UTC(),
	}); err == nil {
		t.Fatal("cross-tenant review run write succeeded")
	}
}

func productFactSession(project domain.ProjectID) domain.SessionRecord {
	now := time.Date(2026, 8, 23, 13, 0, 0, 0, time.UTC)
	return domain.SessionRecord{
		ProjectID:        project,
		Kind:             domain.KindWorker,
		Harness:          domain.HarnessCodex,
		Activity:         domain.Activity{State: domain.ActivityActive, LastActivityAt: now},
		Metadata:         domain.SessionMetadata{Branch: "feature", WorkspacePath: "/workspace"},
		CreatedAt:        now,
		UpdatedAt:        now,
		AutoInjectReview: true,
		AutoInjectCI:     true,
	}
}
