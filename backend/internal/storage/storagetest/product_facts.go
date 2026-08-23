package storagetest

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ProductFactsStore is the shared notification and SCM persistence surface.
type ProductFactsStore interface {
	ports.PRStore
	ports.NotificationStore
	ports.ChangeEventSource
}

// ProductFactsFixture identifies two active sessions already persisted by the
// adapter under test.
type ProductFactsFixture struct {
	Store          ProductFactsStore
	ProjectID      domain.ProjectID
	SessionID      domain.SessionID
	OtherSessionID domain.SessionID
}

// RunProductFactsConformance verifies transactional SCM facts/actions,
// notification behavior, derived status inputs, deterministic ordering, and
// durable change integration against either SQL adapter.
func RunProductFactsConformance(t testing.TB, ctx context.Context, f ProductFactsFixture) {
	t.Helper()
	now := time.Date(2026, 8, 23, 13, 0, 0, 0, time.UTC)
	baseline, err := f.Store.LatestSeq(ctx)
	if err != nil {
		t.Fatalf("latest seq: %v", err)
	}
	pr := domain.PullRequest{URL: "https://github.com/acme/repo/pull/7", SessionID: f.SessionID, Number: 7, CI: domain.CIPassing, Review: domain.ReviewApproved, Mergeability: domain.MergeMergeable, Provider: "github", Host: "github.com", Repo: "acme/repo", ProviderID: "pr-7", SourceBranch: "feature", TargetBranch: "main", HeadSHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Title: "Feature", UpdatedAt: now, ObservedAt: now, CIObservedAt: now, ReviewObservedAt: now}
	checks := []domain.PullRequestCheck{{Name: "test", CommitHash: pr.HeadSHA, Status: domain.PRCheckPassed, Conclusion: "success", URL: "https://ci/7", CreatedAt: now}}
	reviews := []domain.PullRequestReview{{ID: "review-1", Author: "alice", State: domain.ReviewApproved, URL: "https://review/1", TargetSHA: pr.HeadSHA, SubmittedAt: now, AutoInjectReview: true}}
	threads := []domain.PullRequestReviewThread{{ThreadID: "thread-1", Path: "main.go", Line: 7, UpdatedAt: now}}
	comments := []domain.PullRequestComment{{ThreadID: "thread-1", ID: "comment-1", Author: "alice", File: "main.go", Line: 7, Body: "nit", URL: "https://comment/1", CreatedAt: now, AutoInjectReview: true}}
	if err := f.Store.WriteSCMObservation(ctx, pr, checks, reviews, threads, comments, ports.ReviewWriteReplace); err != nil {
		t.Fatalf("write observation: %v", err)
	}
	got, ok, err := f.Store.GetPR(ctx, pr.URL)
	if err != nil || !ok || got.HeadSHA != pr.HeadSHA {
		t.Fatalf("get pr = %+v ok=%v err=%v", got, ok, err)
	}
	facts, err := f.Store.ListPRFactsForSession(ctx, f.SessionID)
	if err != nil || len(facts) != 1 || !facts[0].ReviewComments || facts[0].CI != domain.CIPassing {
		t.Fatalf("facts = %+v err=%v", facts, err)
	}
	if got, err := f.Store.ListChecks(ctx, pr.URL); err != nil || len(got) != 1 || got[0].Name != "test" {
		t.Fatalf("checks = %+v err=%v", got, err)
	}
	if got, err := f.Store.ListPRReviews(ctx, pr.URL); err != nil || len(got) != 1 || !got[0].AutoInjectReview {
		t.Fatalf("reviews = %+v err=%v", got, err)
	}
	if got, err := f.Store.ListPRReviewThreads(ctx, pr.URL); err != nil || len(got) != 1 {
		t.Fatalf("threads = %+v err=%v", got, err)
	}
	if changed, err := f.Store.MarkPRCommentResolved(ctx, pr.URL, "comment-1"); err != nil || !changed {
		t.Fatalf("resolve comment = %v, %v", changed, err)
	}
	facts, err = f.Store.ListPRFactsForSession(ctx, f.SessionID)
	if err != nil || len(facts) != 1 || facts[0].ReviewComments {
		t.Fatalf("resolved facts = %+v err=%v", facts, err)
	}

	if err := f.Store.WriteSCMObservation(ctx, pr, checks, nil, nil, nil, ports.ReviewWriteReplace); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.Store.ListPRReviews(ctx, pr.URL); len(got) != 0 {
		t.Fatalf("replace retained reviews: %+v", got)
	}
	if got, _ := f.Store.ListPRComments(ctx, pr.URL); len(got) != 0 {
		t.Fatalf("replace retained comments: %+v", got)
	}

	claim := pr
	claim.SessionID = f.OtherSessionID
	if _, err := f.Store.ClaimPR(ctx, claim, checks, nil, nil, nil, ports.ReviewWritePreserve, false); !errors.Is(err, ports.ErrPRClaimedByActiveSession) {
		t.Fatalf("guarded claim error = %v", err)
	}
	outcome, err := f.Store.ClaimPR(ctx, claim, checks, nil, nil, nil, ports.ReviewWritePreserve, true)
	if err != nil || outcome.PreviousOwner != f.SessionID {
		t.Fatalf("claim = %+v err=%v", outcome, err)
	}
	if err := f.Store.WriteSCMObservation(ctx, pr, checks, nil, nil, nil, ports.ReviewWritePreserve); err == nil {
		t.Fatal("stale owner write succeeded")
	}

	rec := domain.NotificationRecord{ID: "ntf-conformance-1", SessionID: f.SessionID, ProjectID: f.ProjectID, PRURL: pr.URL, Type: domain.NotificationReadyToMerge, Title: "Ready", Status: domain.NotificationUnread, CreatedAt: now}
	created, inserted, err := f.Store.CreateNotification(ctx, rec)
	if err != nil || !inserted || created.ID != rec.ID {
		t.Fatalf("create notification = %+v %v %v", created, inserted, err)
	}
	dup := rec
	dup.ID = "ntf-conformance-2"
	if _, inserted, err := f.Store.CreateNotification(ctx, dup); err != nil || inserted {
		t.Fatalf("dedupe = %v %v", inserted, err)
	}
	listed, err := f.Store.ListNotifications(ctx, domain.NotificationListUnread, time.Time{}, "", 10)
	if err != nil || len(listed) != 1 {
		t.Fatalf("notifications = %+v err=%v", listed, err)
	}
	if _, ok, err := f.Store.MarkNotificationRead(ctx, rec.ID); err != nil || !ok {
		t.Fatalf("mark read = %v %v", ok, err)
	}
	resolved, err := f.Store.ResolvePRNotifications(ctx, pr.URL, rec.Type, now.Add(time.Minute))
	if err != nil || len(resolved) != 1 {
		t.Fatalf("resolve notification = %+v err=%v", resolved, err)
	}

	events, err := f.Store.EventsAfter(ctx, baseline, 100)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	want := map[ports.ChangeEventType]bool{ports.ChangeEventPRCreated: false, ports.ChangeEventPRCheckRecorded: false, ports.ChangeEventPRSessionChanged: false}
	for _, event := range events {
		if _, ok := want[event.Type]; ok {
			want[event.Type] = true
		}
	}
	for typ, seen := range want {
		if !seen {
			t.Fatalf("missing %s event in %+v", typ, events)
		}
	}
}
