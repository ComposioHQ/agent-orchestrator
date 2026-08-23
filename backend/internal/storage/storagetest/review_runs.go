package storagetest

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ReviewRunPersistenceStore is the shared review parent/run persistence seam.
type ReviewRunPersistenceStore interface {
	ports.ReviewRunStore
	ports.PRStore
	UpsertReview(context.Context, domain.Review) error
}

// ReviewRunFixture identifies an existing project and worker session.
type ReviewRunFixture struct {
	Store     ReviewRunPersistenceStore
	ProjectID domain.ProjectID
	SessionID domain.SessionID
}

// RunReviewRunConformance verifies review-pass identity and lifecycle mutation
// semantics shared by SQLite and PostgreSQL. CDC remains trigger-owned.
func RunReviewRunConformance(t testing.TB, ctx context.Context, f ReviewRunFixture) {
	t.Helper()
	now := time.Date(2026, 8, 23, 14, 0, 0, 0, time.UTC)
	review := domain.Review{
		ID: "review-conformance", SessionID: f.SessionID, ProjectID: f.ProjectID,
		Harness: domain.ReviewerCodex, PRURL: "https://github.com/acme/repo/pull/11",
		ReviewerHandleID: "reviewer-handle", AgentSessionID: "native-reviewer",
		CreatedAt: now, UpdatedAt: now,
	}
	pr := domain.PullRequest{
		URL: review.PRURL, SessionID: f.SessionID, Number: 11, Provider: "github",
		Host: "github.com", Repo: "acme/repo", ProviderID: "pr-review-conformance",
		HeadSHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", UpdatedAt: now,
	}
	if err := f.Store.WriteSCMObservation(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		t.Fatalf("write review PR: %v", err)
	}
	if err := f.Store.UpsertReview(ctx, review); err != nil {
		t.Fatalf("upsert review: %v", err)
	}
	run := domain.ReviewRun{
		ID: "run-conformance", ReviewID: review.ID, SessionID: f.SessionID,
		BatchID: "batch-conformance", Harness: review.Harness, PRURL: review.PRURL,
		TargetSHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Status: domain.ReviewRunRunning,
		CreatedAt: now, AutoInjectReview: true,
	}
	if err := f.Store.InsertReviewRun(ctx, run); err != nil {
		t.Fatalf("insert review run: %v", err)
	}
	duplicate := run
	duplicate.ID = "run-conformance-duplicate"
	if err := f.Store.InsertReviewRun(ctx, duplicate); !errors.Is(err, domain.ErrDuplicateReviewRun) {
		t.Fatalf("duplicate error = %v, want ErrDuplicateReviewRun", err)
	}
	got, ok, err := f.Store.GetReviewRun(ctx, run.ID)
	if err != nil || !ok || got.TriggerSource != domain.ReviewTriggerManual || got.AutoInjectReview != run.AutoInjectReview {
		t.Fatalf("get review run = %+v ok=%v err=%v", got, ok, err)
	}
	if got, ok, err := f.Store.GetReviewRunBySessionPRSHAAndHarness(ctx, f.SessionID, run.PRURL, run.TargetSHA, run.Harness); err != nil || !ok || got.ID != run.ID {
		t.Fatalf("get review run by identity = %+v ok=%v err=%v", got, ok, err)
	}
	if updated, err := f.Store.UpdateReviewRunResult(ctx, run.ID, domain.ReviewRunComplete, domain.VerdictApproved, "approved", "provider-review-1", true); err != nil || !updated {
		t.Fatalf("update review result = %v, %v", updated, err)
	}
	deliveredAt := now.Add(time.Minute)
	if updated, err := f.Store.MarkReviewRunDelivered(ctx, run.ID, deliveredAt); err != nil || !updated {
		t.Fatalf("mark delivered = %v, %v", updated, err)
	}
	got, ok, err = f.Store.GetReviewRun(ctx, run.ID)
	if err != nil || !ok || got.Status != domain.ReviewRunDelivered || got.DeliveredAt == nil || !got.DeliveredAt.Equal(deliveredAt) {
		t.Fatalf("delivered run = %+v ok=%v err=%v", got, ok, err)
	}

	stale := run
	stale.ID = "run-conformance-stale"
	stale.TargetSHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	stale.BatchID = "batch-lifecycle"
	stale.CreatedAt = now.Add(2 * time.Minute)
	if err := f.Store.InsertReviewRun(ctx, stale); err != nil {
		t.Fatal(err)
	}
	current := stale
	current.ID = "run-conformance-current"
	current.TargetSHA = "cccccccccccccccccccccccccccccccccccccccc"
	current.CreatedAt = now.Add(3 * time.Minute)
	if err := f.Store.InsertReviewRun(ctx, current); err != nil {
		t.Fatal(err)
	}
	if changed, err := f.Store.SupersedeStaleRunningReviewRuns(ctx, f.SessionID, run.PRURL, current.TargetSHA, "superseded"); err != nil || changed != 1 {
		t.Fatalf("supersede = %d, %v", changed, err)
	}
	if changed, err := f.Store.CancelRunningReviewRunsBySessionAndHarness(ctx, f.SessionID, run.Harness, "cancelled"); err != nil || changed != 1 {
		t.Fatalf("cancel = %d, %v", changed, err)
	}
	if running, err := f.Store.ListRunningReviewRunsBySession(ctx, f.SessionID); err != nil || len(running) != 0 {
		t.Fatalf("running review runs = %+v err=%v", running, err)
	}
	if batch, err := f.Store.ListReviewRunsByBatch(ctx, f.SessionID, "batch-lifecycle"); err != nil || len(batch) != 2 || batch[0].ID != stale.ID || batch[1].ID != current.ID {
		t.Fatalf("batch review runs = %+v err=%v", batch, err)
	}
	if all, err := f.Store.ListReviewRunsBySession(ctx, f.SessionID); err != nil || len(all) != 3 {
		t.Fatalf("all review runs = %+v err=%v", all, err)
	}
	renamed := pr
	renamed.URLAlias = pr.URL
	renamed.URL = "https://github.com/acme/renamed/pull/11"
	renamed.Repo = "acme/renamed"
	if err := f.Store.WriteSCMObservation(ctx, renamed, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		t.Fatalf("rename review PR: %v", err)
	}
	if moved, ok, err := f.Store.GetReviewRunBySessionPRAndSHA(ctx, f.SessionID, renamed.URL, run.TargetSHA); err != nil || !ok || moved.ID != run.ID {
		t.Fatalf("renamed review run = %+v ok=%v err=%v", moved, ok, err)
	}
}
