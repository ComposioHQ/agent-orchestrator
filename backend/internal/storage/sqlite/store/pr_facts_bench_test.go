package store_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

// Mirrors the shape observed on a real install (135 sessions, ~100 PRs): the
// session-list read path fetches PR facts for every session on every refetch.
const (
	benchSessions          = 135
	benchSessionsWithPR    = 90
	benchCommentsPerPR     = 3
	benchProject           = "bench"
	benchPRFactsBatchEvery = 1
)

func seedPRFactsFixture(tb testing.TB) (*sqlite.Store, []domain.SessionID) {
	tb.Helper()
	s := sqlitetest.MustOpen(tb)
	ctx := context.Background()
	if err := s.UpsertProject(ctx, domain.ProjectRecord{
		ID: benchProject, Path: "/tmp/" + benchProject, RegisteredAt: time.Now().UTC().Truncate(time.Second),
	}); err != nil {
		tb.Fatalf("seed project: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	ids := make([]domain.SessionID, 0, benchSessions)
	for i := 0; i < benchSessions; i++ {
		rec, err := s.CreateSession(ctx, domain.SessionRecord{
			ProjectID: benchProject,
			Kind:      domain.KindWorker,
			Harness:   domain.HarnessClaudeCode,
			Activity:  domain.Activity{State: domain.ActivityActive, LastActivityAt: now},
			Metadata:  domain.SessionMetadata{Branch: fmt.Sprintf("feat/b-%d", i), WorkspacePath: "/ws"},
			CreatedAt: now,
			UpdatedAt: now,
		})
		if err != nil {
			tb.Fatalf("create session %d: %v", i, err)
		}
		ids = append(ids, rec.ID)
		if i >= benchSessionsWithPR {
			continue
		}
		url := fmt.Sprintf("https://github.com/x/y/pull/%d", i+1)
		pr := domain.PullRequest{
			URL: url, SessionID: rec.ID, Number: i + 1,
			CI: domain.CIPassing, SourceBranch: fmt.Sprintf("feat/b-%d", i), TargetBranch: "main",
			UpdatedAt: now, ObservedAt: now,
		}
		var comments []domain.PullRequestComment
		for c := 0; c < benchCommentsPerPR; c++ {
			comments = append(comments, domain.PullRequestComment{
				ID:     fmt.Sprintf("c-%d-%d", i, c),
				Author: "rev", Body: "comment body", CreatedAt: now,
			})
		}
		if err := s.WriteSCMObservation(ctx, pr, nil, nil, nil, comments, ports.ReviewWritePreserve); err != nil {
			tb.Fatalf("write pr %d: %v", i, err)
		}
	}
	return s, ids
}

// BenchmarkListPRFactsPerSession is the pre-batch session-list pattern: one
// ListPRFactsForSession query per session (1+N round-trips per list build).
func BenchmarkListPRFactsPerSession(b *testing.B) {
	s, ids := seedPRFactsFixture(b)
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		total := 0
		for _, id := range ids {
			facts, err := s.ListPRFactsForSession(ctx, id)
			if err != nil {
				b.Fatal(err)
			}
			total += len(facts)
		}
		if total != benchSessionsWithPR {
			b.Fatalf("facts = %d, want %d", total, benchSessionsWithPR)
		}
	}
}

// BenchmarkListAllPRFacts is the batched replacement: one query for the whole
// session list.
func BenchmarkListAllPRFacts(b *testing.B) {
	s, _ := seedPRFactsFixture(b)
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		bySession, err := s.ListAllPRFacts(ctx)
		if err != nil {
			b.Fatal(err)
		}
		if len(bySession) != benchSessionsWithPR {
			b.Fatalf("sessions with facts = %d, want %d", len(bySession), benchSessionsWithPR)
		}
	}
}

// The batch read must agree with the per-session read it replaces, per session
// and in order.
func TestListAllPRFactsMatchesPerSessionReads(t *testing.T) {
	s, ids := seedPRFactsFixture(t)
	ctx := context.Background()
	bySession, err := s.ListAllPRFacts(ctx)
	if err != nil {
		t.Fatalf("ListAllPRFacts: %v", err)
	}
	for _, id := range ids {
		perSession, err := s.ListPRFactsForSession(ctx, id)
		if err != nil {
			t.Fatalf("ListPRFactsForSession(%s): %v", id, err)
		}
		batch := bySession[id]
		if len(batch) != len(perSession) {
			t.Fatalf("session %s: batch %d facts, per-session %d", id, len(batch), len(perSession))
		}
		for i := range perSession {
			if batch[i] != perSession[i] {
				t.Fatalf("session %s fact %d: batch %+v != per-session %+v", id, i, batch[i], perSession[i])
			}
		}
	}
}
