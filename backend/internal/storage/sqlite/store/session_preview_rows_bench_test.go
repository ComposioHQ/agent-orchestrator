package store_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

// The preview poller scans sessions four times a second for the daemon's whole
// lifetime, so the projection it reads is a standing cost. Mirror a real
// install: ~135 sessions, multi-KB prompt/update text on each row.
func seedPreviewRowsFixture(tb testing.TB) *sqlite.Store {
	tb.Helper()
	s := sqlitetest.MustOpen(tb)
	ctx := context.Background()
	if err := s.UpsertProject(ctx, domain.ProjectRecord{
		ID: benchProject, Path: "/tmp/" + benchProject, RegisteredAt: time.Now().UTC().Truncate(time.Second),
	}); err != nil {
		tb.Fatalf("seed project: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	prompt := strings.Repeat("perf task detail ", 256) // ~4 KB, like a real seeded prompt
	for i := 0; i < benchSessions; i++ {
		if _, err := s.CreateSession(ctx, domain.SessionRecord{
			ProjectID: benchProject,
			Kind:      domain.KindWorker,
			Harness:   domain.HarnessClaudeCode,
			Activity:  domain.Activity{State: domain.ActivityActive, LastActivityAt: now},
			Metadata: domain.SessionMetadata{
				Branch:                fmt.Sprintf("feat/p-%d", i),
				WorkspacePath:         "/ws",
				Prompt:                prompt,
				LatestUserPrompt:      prompt,
				LatestAssistantUpdate: prompt,
			},
			CreatedAt: now,
			UpdatedAt: now,
		}); err != nil {
			tb.Fatalf("create session %d: %v", i, err)
		}
	}
	return s
}

// BenchmarkPreviewPollListAllSessions is what the poller used to run per tick.
func BenchmarkPreviewPollListAllSessions(b *testing.B) {
	s := seedPreviewRowsFixture(b)
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		recs, err := s.ListAllSessions(ctx)
		if err != nil {
			b.Fatal(err)
		}
		if len(recs) != benchSessions {
			b.Fatalf("sessions = %d, want %d", len(recs), benchSessions)
		}
	}
}

// BenchmarkPreviewPollListSessionPreviewRows is the narrow replacement.
func BenchmarkPreviewPollListSessionPreviewRows(b *testing.B) {
	s := seedPreviewRowsFixture(b)
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		recs, err := s.ListSessionPreviewRows(ctx)
		if err != nil {
			b.Fatal(err)
		}
		if len(recs) != benchSessions {
			b.Fatalf("sessions = %d, want %d", len(recs), benchSessions)
		}
	}
}

// The narrow read must agree with the full read on the fields the poller uses.
func TestListSessionPreviewRowsMatchesListAllSessions(t *testing.T) {
	s := seedPreviewRowsFixture(t)
	ctx := context.Background()
	full, err := s.ListAllSessions(ctx)
	if err != nil {
		t.Fatalf("ListAllSessions: %v", err)
	}
	narrow, err := s.ListSessionPreviewRows(ctx)
	if err != nil {
		t.Fatalf("ListSessionPreviewRows: %v", err)
	}
	byID := make(map[domain.SessionID]domain.SessionRecord, len(narrow))
	for _, rec := range narrow {
		byID[rec.ID] = rec
	}
	live := 0
	for _, rec := range full {
		if rec.IsTerminated {
			if _, ok := byID[rec.ID]; ok {
				t.Fatalf("terminated session %s present in preview rows", rec.ID)
			}
			continue
		}
		live++
		got, ok := byID[rec.ID]
		if !ok {
			t.Fatalf("session %s missing from preview rows", rec.ID)
		}
		if got.Kind != rec.Kind ||
			got.IsTerminated != rec.IsTerminated ||
			got.Metadata.WorkspacePath != rec.Metadata.WorkspacePath ||
			got.Metadata.PreviewURL != rec.Metadata.PreviewURL ||
			got.Metadata.PreviewRevision != rec.Metadata.PreviewRevision {
			t.Fatalf("session %s: preview row %+v disagrees with full record", rec.ID, got)
		}
	}
	if live != len(narrow) {
		t.Fatalf("preview rows = %d, live sessions = %d", len(narrow), live)
	}
}
