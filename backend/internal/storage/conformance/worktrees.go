package conformance

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func runSessionWorktrees(t *testing.T, newHarness Factory) {
	t.Helper()

	t.Run("upsert then read back round-trips every field", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		session := seedSessionForWorktrees(t, h)

		want := domain.SessionWorktreeRecord{
			SessionID:    session,
			RepoName:     domain.RootWorkspaceRepoName,
			Branch:       "ao/acme-1",
			BaseSHA:      "abc123",
			BaseRef:      "origin/main",
			WorktreePath: "/work/acme-1",
			PreservedRef: "refs/ao/preserved/acme-1",
		}
		if err := h.Worktrees.UpsertSessionWorktree(ctx, want); err != nil {
			t.Fatalf("UpsertSessionWorktree: %v", err)
		}
		got, ok, err := h.Worktrees.GetSessionWorktree(ctx, session, domain.RootWorkspaceRepoName)
		if err != nil || !ok {
			t.Fatalf("GetSessionWorktree = %v, %v", ok, err)
		}
		if got.SessionID != want.SessionID || got.RepoName != want.RepoName ||
			got.Branch != want.Branch || got.BaseSHA != want.BaseSHA || got.BaseRef != want.BaseRef ||
			got.WorktreePath != want.WorktreePath || got.PreservedRef != want.PreservedRef {
			t.Fatalf("worktree = %#v, want %#v", got, want)
		}
		if got.State == "" {
			t.Fatalf("state defaulted to empty: %#v", got)
		}
	})

	t.Run("upsert replaces the row for the same repo", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		session := seedSessionForWorktrees(t, h)
		row := newWorktree(session, domain.RootWorkspaceRepoName, "/work/acme-1")
		if err := h.Worktrees.UpsertSessionWorktree(ctx, row); err != nil {
			t.Fatalf("first upsert: %v", err)
		}
		row.PreservedRef = "refs/ao/preserved/acme-1"
		row.BaseSHA = "def456"
		if err := h.Worktrees.UpsertSessionWorktree(ctx, row); err != nil {
			t.Fatalf("second upsert: %v", err)
		}
		rows, err := h.Worktrees.ListSessionWorktrees(ctx, session)
		if err != nil || len(rows) != 1 {
			t.Fatalf("ListSessionWorktrees = %#v, %v", rows, err)
		}
		if rows[0].PreservedRef != "refs/ao/preserved/acme-1" || rows[0].BaseSHA != "def456" {
			t.Fatalf("upsert did not replace: %#v", rows[0])
		}
	})

	t.Run("list returns the root worktree first", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		session := seedSessionForWorktrees(t, h)
		for _, repo := range []string{"web", domain.RootWorkspaceRepoName, "api"} {
			if err := h.Worktrees.UpsertSessionWorktree(ctx, newWorktree(session, repo, "/work/acme-1/"+repo)); err != nil {
				t.Fatalf("upsert %s: %v", repo, err)
			}
		}
		rows, err := h.Worktrees.ListSessionWorktrees(ctx, session)
		if err != nil {
			t.Fatalf("ListSessionWorktrees: %v", err)
		}
		if len(rows) != 3 {
			t.Fatalf("got %d rows, want 3: %#v", len(rows), rows)
		}
		if rows[0].RepoName != domain.RootWorkspaceRepoName {
			t.Fatalf("root worktree is not first: %v", worktreeRepoNames(rows))
		}
		if rows[1].RepoName != "api" || rows[2].RepoName != "web" {
			t.Fatalf("children are not name-ordered: %v", worktreeRepoNames(rows))
		}
	})

	t.Run("absent rows and empty lists are not errors", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		session := seedSessionForWorktrees(t, h)
		if got, ok, err := h.Worktrees.GetSessionWorktree(ctx, session, "missing"); ok || err != nil {
			t.Fatalf("GetSessionWorktree(missing repo) = %#v, %v, %v", got, ok, err)
		}
		if got, ok, err := h.Worktrees.GetSessionWorktree(ctx, "ghost-1", domain.RootWorkspaceRepoName); ok || err != nil {
			t.Fatalf("GetSessionWorktree(missing session) = %#v, %v, %v", got, ok, err)
		}
		if rows, err := h.Worktrees.ListSessionWorktrees(ctx, "ghost-1"); err != nil || len(rows) != 0 {
			t.Fatalf("ListSessionWorktrees(missing session) = %#v, %v", rows, err)
		}
	})

	t.Run("delete removes every repo for the session and is idempotent", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		session := seedSessionForWorktrees(t, h)
		other := mustCreateSession(t, h, newSession("acme")).ID
		for _, repo := range []string{domain.RootWorkspaceRepoName, "api"} {
			if err := h.Worktrees.UpsertSessionWorktree(ctx, newWorktree(session, repo, "/work/1/"+repo)); err != nil {
				t.Fatalf("upsert: %v", err)
			}
		}
		if err := h.Worktrees.UpsertSessionWorktree(ctx, newWorktree(other, domain.RootWorkspaceRepoName, "/work/2")); err != nil {
			t.Fatalf("upsert other: %v", err)
		}

		if err := h.Worktrees.DeleteSessionWorktrees(ctx, session); err != nil {
			t.Fatalf("DeleteSessionWorktrees: %v", err)
		}
		if rows, err := h.Worktrees.ListSessionWorktrees(ctx, session); err != nil || len(rows) != 0 {
			t.Fatalf("rows survived delete: %#v, %v", rows, err)
		}
		if rows, err := h.Worktrees.ListSessionWorktrees(ctx, other); err != nil || len(rows) != 1 {
			t.Fatalf("another session's worktrees were deleted: %#v, %v", rows, err)
		}
		if err := h.Worktrees.DeleteSessionWorktrees(ctx, session); err != nil {
			t.Fatalf("second DeleteSessionWorktrees: %v", err)
		}
		if err := h.Worktrees.DeleteSessionWorktrees(ctx, "ghost-1"); err != nil {
			t.Fatalf("DeleteSessionWorktrees(missing session): %v", err)
		}
	})
}

func seedSessionForWorktrees(t *testing.T, h Harness) domain.SessionID {
	t.Helper()
	mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
	return mustCreateSession(t, h, newSession("acme")).ID
}

func newWorktree(session domain.SessionID, repo, path string) domain.SessionWorktreeRecord {
	return domain.SessionWorktreeRecord{
		SessionID:    session,
		RepoName:     repo,
		Branch:       "ao/" + string(session),
		BaseSHA:      "abc123",
		BaseRef:      "origin/main",
		WorktreePath: path,
	}
}

func worktreeRepoNames(rows []domain.SessionWorktreeRecord) []string {
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.RepoName)
	}
	return out
}
