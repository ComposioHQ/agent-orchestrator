package store_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ListPRFactsForSession is the real-SQLite batch read the multi-PR status
// aggregator builds stacks from: every owned PR returned newest-first with its
// state flags and branch pair projected (the stack model needs both).
//
// The branch pair is written via WriteSCMObservation (the observer path, the
// source of truth for tracked PRs). The other writer, WritePR, deliberately
// omits source/target branch (UpsertLegacyPR), so the stack model depends on the
// observer having populated the row.
func TestListPRFactsForSessionProjectsAllPRsNewestFirst(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	r, _ := s.CreateSession(ctx, sampleRecord("mer"))
	now := time.Now().UTC().Truncate(time.Second)

	// A stack: root (open) -> child targets the root branch (open) -> a merged
	// historical PR. Distinct updated_at so newest-first ordering is observable.
	write := func(pr domain.PullRequest) {
		t.Helper()
		if err := s.WriteSCMObservation(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
			t.Fatalf("write %s: %v", pr.URL, err)
		}
	}
	write(domain.PullRequest{URL: "root", SessionID: r.ID, Number: 1, CI: domain.CIPassing, SourceBranch: "feat/x", TargetBranch: "main", UpdatedAt: now, ObservedAt: now})
	write(domain.PullRequest{URL: "child", SessionID: r.ID, Number: 2, Draft: true, SourceBranch: "feat/x/child", TargetBranch: "feat/x", UpdatedAt: now.Add(time.Second), ObservedAt: now})
	write(domain.PullRequest{URL: "old", SessionID: r.ID, Number: 3, Merged: true, SourceBranch: "feat/old", TargetBranch: "main", UpdatedAt: now.Add(2 * time.Second), ObservedAt: now})

	facts, err := s.ListPRFactsForSession(ctx, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(facts) != 3 {
		t.Fatalf("ListPRFactsForSession = %d, want 3", len(facts))
	}
	// Newest-first by updated_at: old, child, root.
	if facts[0].URL != "old" || facts[1].URL != "child" || facts[2].URL != "root" {
		t.Fatalf("order = [%s %s %s], want [old child root]", facts[0].URL, facts[1].URL, facts[2].URL)
	}
	byURL := map[string]domain.PRFacts{}
	for _, f := range facts {
		byURL[f.URL] = f
	}
	if !byURL["old"].Merged || byURL["old"].Closed || byURL["old"].Draft {
		t.Fatalf("merged PR flags wrong: %+v", byURL["old"])
	}
	if !byURL["child"].Draft || byURL["child"].Merged {
		t.Fatalf("draft child flags wrong: %+v", byURL["child"])
	}
	// The stack model is derived from the source/target branch pair, so it must
	// survive the projection.
	if byURL["child"].SourceBranch != "feat/x/child" || byURL["child"].TargetBranch != "feat/x" {
		t.Fatalf("child branch pair lost: %+v", byURL["child"])
	}
	if byURL["root"].SourceBranch != "feat/x" || byURL["root"].TargetBranch != "main" {
		t.Fatalf("root branch pair lost: %+v", byURL["root"])
	}
	if byURL["root"].CI != domain.CIPassing {
		t.Fatalf("root CI = %q, want passing", byURL["root"].CI)
	}

	// A session with no PRs returns an empty (non-nil) slice, never an error.
	empty, _ := s.CreateSession(ctx, sampleRecord("mer"))
	got, err := s.ListPRFactsForSession(ctx, empty.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("no-PR session = %d facts, want 0", len(got))
	}
}

func TestPRStateChangedAtPersistsOnlyOnStateTransitions(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	r, _ := s.CreateSession(ctx, sampleRecord("mer"))
	createdAt := time.Date(2026, 6, 4, 9, 0, 0, 0, time.UTC)
	updatedAt := time.Date(2026, 6, 4, 9, 30, 0, 0, time.UTC)
	readyAt := time.Date(2026, 6, 4, 10, 0, 0, 0, time.UTC)
	laterAt := time.Date(2026, 6, 4, 11, 0, 0, 0, time.UTC)
	pr := domain.PullRequest{
		URL:               "https://github.com/acme/repo/pull/7",
		SessionID:         r.ID,
		Number:            7,
		Draft:             true,
		CreatedAtProvider: createdAt,
		UpdatedAtProvider: updatedAt,
		UpdatedAt:         updatedAt,
		ObservedAt:        updatedAt,
	}
	if err := s.WriteSCMObservation(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.GetPR(ctx, pr.URL)
	if err != nil || !ok {
		t.Fatalf("GetPR after draft write: ok=%v err=%v", ok, err)
	}
	if !got.StateChangedAt.Equal(createdAt) {
		t.Fatalf("draft stateChangedAt = %s, want created time %s", got.StateChangedAt, createdAt)
	}

	pr.Title = "metadata-only update"
	pr.UpdatedAtProvider = laterAt
	pr.UpdatedAt = laterAt
	pr.ObservedAt = laterAt
	if err := s.WriteSCMObservation(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		t.Fatal(err)
	}
	got, ok, err = s.GetPR(ctx, pr.URL)
	if err != nil || !ok {
		t.Fatalf("GetPR after same-state write: ok=%v err=%v", ok, err)
	}
	if !got.StateChangedAt.Equal(createdAt) {
		t.Fatalf("same-state stateChangedAt = %s, want preserved %s", got.StateChangedAt, createdAt)
	}

	pr.Draft = false
	pr.UpdatedAtProvider = readyAt
	pr.UpdatedAt = readyAt
	pr.ObservedAt = readyAt
	if err := s.WriteSCMObservation(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		t.Fatal(err)
	}
	got, ok, err = s.GetPR(ctx, pr.URL)
	if err != nil || !ok {
		t.Fatalf("GetPR after ready write: ok=%v err=%v", ok, err)
	}
	if !got.StateChangedAt.Equal(readyAt) {
		t.Fatalf("ready stateChangedAt = %s, want ready time %s", got.StateChangedAt, readyAt)
	}
}

func TestPRStateChangedAtFillsWhenProviderCreatedAtArrives(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	r, _ := s.CreateSession(ctx, sampleRecord("mer"))
	discoveredAt := time.Date(2026, 6, 4, 9, 30, 0, 0, time.UTC)
	createdAt := time.Date(2026, 6, 4, 8, 45, 0, 0, time.UTC)
	laterAt := time.Date(2026, 6, 4, 10, 0, 0, 0, time.UTC)
	pr := domain.PullRequest{
		URL:        "https://github.com/acme/repo/pull/8",
		SessionID:  r.ID,
		Number:     8,
		UpdatedAt:  discoveredAt,
		ObservedAt: discoveredAt,
	}
	if err := s.WriteSCMObservation(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.GetPR(ctx, pr.URL)
	if err != nil || !ok {
		t.Fatalf("GetPR after discovery write: ok=%v err=%v", ok, err)
	}
	if !got.StateChangedAt.IsZero() {
		t.Fatalf("discovery stateChangedAt = %s, want unset without provider creation time", got.StateChangedAt)
	}

	pr.CreatedAtProvider = createdAt
	pr.UpdatedAt = laterAt
	pr.ObservedAt = laterAt
	if err := s.WriteSCMObservation(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		t.Fatal(err)
	}
	got, ok, err = s.GetPR(ctx, pr.URL)
	if err != nil || !ok {
		t.Fatalf("GetPR after provider-created write: ok=%v err=%v", ok, err)
	}
	if !got.StateChangedAt.Equal(createdAt) {
		t.Fatalf("same-state stateChangedAt = %s, want provider creation time %s", got.StateChangedAt, createdAt)
	}
}

func TestEnsureDiscoveredPRIsInsertOnly(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	owner, _ := s.CreateSession(ctx, sampleRecord("mer"))
	other, _ := s.CreateSession(ctx, sampleRecord("mer"))
	now := time.Date(2026, 8, 15, 1, 0, 0, 0, time.UTC)
	url := "https://github.com/new/repo/pull/42"
	authoritative := domain.PullRequest{
		URL:          url,
		SessionID:    owner.ID,
		Number:       42,
		CI:           domain.CIPassing,
		Review:       domain.ReviewApproved,
		Mergeability: domain.MergeMergeable,
		UpdatedAt:    now,
		Provider:     "github",
		Host:         "github.com",
		Repo:         "new/repo",
		ProviderID:   "PR_stable_42",
		SourceBranch: "feature",
		TargetBranch: "main",
		HeadSHA:      "authoritative-sha",
		Title:        "Authoritative title",
		MetadataHash: "metadata-hash",
		CIHash:       "ci-hash",
		ReviewHash:   "review-hash",
		ObservedAt:   now,
		CIObservedAt: now,
	}
	if err := s.WriteSCMObservation(ctx, authoritative, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		t.Fatal(err)
	}
	seqBeforeRediscovery, err := s.LatestSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// A stale remote alias can list the same canonical URL with only partial
	// fields. Ensuring that discovery must not downgrade any stored fact.
	if err := s.EnsureDiscoveredPR(ctx, domain.DiscoveredPullRequest{
		URL: url, SessionID: owner.ID, Number: 42, UpdatedAt: now.Add(time.Minute),
		Provider: "github", Host: "github.com", Repo: "old/repo", ProviderID: "PR_stable_42",
		SourceBranch: "feature", TargetBranch: "main", HeadSHA: "partial-sha",
	}); err != nil {
		t.Fatal(err)
	}
	seqAfterRediscovery, err := s.LatestSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if seqAfterRediscovery != seqBeforeRediscovery {
		t.Fatalf("rediscovery emitted CDC: sequence advanced from %d to %d", seqBeforeRediscovery, seqAfterRediscovery)
	}
	got, ok, err := s.GetPR(ctx, url)
	if err != nil || !ok {
		t.Fatalf("GetPR: ok=%v err=%v", ok, err)
	}
	if got.CI != domain.CIPassing || got.Review != domain.ReviewApproved || got.Mergeability != domain.MergeMergeable {
		t.Fatalf("discovery downgraded readiness facts: CI=%q review=%q mergeability=%q", got.CI, got.Review, got.Mergeability)
	}
	if got.Repo != "new/repo" || got.HeadSHA != "authoritative-sha" || got.Title != "Authoritative title" {
		t.Fatalf("discovery replaced authoritative metadata: repo=%q sha=%q title=%q", got.Repo, got.HeadSHA, got.Title)
	}
	if got.MetadataHash != "metadata-hash" || got.CIHash != "ci-hash" || got.ReviewHash != "review-hash" {
		t.Fatalf("discovery replaced acknowledgement hashes: metadata=%q ci=%q review=%q", got.MetadataHash, got.CIHash, got.ReviewHash)
	}

	newURL := "https://github.com/new/repo/pull/43"
	if err := s.EnsureDiscoveredPR(ctx, domain.DiscoveredPullRequest{
		URL: newURL, SessionID: owner.ID, Number: 43, Draft: true, UpdatedAt: now,
		Provider: "github", Host: "github.com", Repo: "new/repo", ProviderID: "PR_stable_43",
		SourceBranch: "feature/child", TargetBranch: "feature", HeadSHA: "new-sha",
	}); err != nil {
		t.Fatal(err)
	}
	inserted, ok, err := s.GetPR(ctx, newURL)
	if err != nil || !ok {
		t.Fatalf("GetPR(new discovery): ok=%v err=%v", ok, err)
	}
	if !inserted.Draft || inserted.ProviderID != "PR_stable_43" || inserted.CI != domain.CIUnknown || inserted.Review != domain.ReviewNone || inserted.Mergeability != domain.MergeUnknown {
		t.Fatalf("new discovery baseline = %+v", inserted)
	}

	if err := s.EnsureDiscoveredPR(ctx, domain.DiscoveredPullRequest{
		URL: url, SessionID: other.ID, Number: 42, UpdatedAt: now,
	}); err == nil {
		t.Fatal("discovery must not silently move a PR to another session")
	}
}

func TestRecordPRMergeImmediatelyProjectsTerminalState(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	owner, _ := s.CreateSession(ctx, sampleRecord("mer"))
	observedAt := time.Date(2026, 8, 15, 2, 0, 0, 0, time.UTC)
	mergedAt := observedAt.Add(time.Minute)
	url := "https://github.com/acme/repo/pull/44"
	if err := s.WriteSCMObservation(ctx, domain.PullRequest{
		URL: url, SessionID: owner.ID, Number: 44, UpdatedAt: observedAt,
		CI: domain.CIPassing, Review: domain.ReviewApproved, Mergeability: domain.MergeMergeable,
		Provider: "github", Host: "github.com", Repo: "acme/repo",
		SourceBranch: "feature", TargetBranch: "main", HeadSHA: "head-sha",
		MetadataHash: "metadata", CIHash: "ci", ReviewHash: "review",
	}, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		t.Fatal(err)
	}
	seq, err := s.LatestSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}

	merged, err := s.RecordPRMerge(ctx, url, "merge-sha", mergedAt)
	if err != nil {
		t.Fatal(err)
	}
	if !merged.Merged || merged.Closed || merged.Draft || merged.MergeCommitSHA != "merge-sha" {
		t.Fatalf("terminal projection = %+v", merged)
	}
	if !merged.StateChangedAt.Equal(mergedAt) || !merged.MergedAtProvider.Equal(mergedAt) {
		t.Fatalf("merge timestamps = state %s provider %s, want %s", merged.StateChangedAt, merged.MergedAtProvider, mergedAt)
	}
	if merged.CI != domain.CIPassing || merged.Review != domain.ReviewApproved || merged.Mergeability != domain.MergeMergeable {
		t.Fatalf("terminal projection erased readiness facts: %+v", merged)
	}
	if merged.MetadataHash != "metadata" || merged.CIHash != "ci" || merged.ReviewHash != "review" {
		t.Fatalf("terminal projection erased observer cursors: %+v", merged)
	}
	events, err := s.EventsAfter(ctx, seq, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != "pr_updated" || !strings.Contains(string(events[0].Payload), `"state":"merged"`) {
		t.Fatalf("merge CDC events = %+v", events)
	}
}
