package ports

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// SessionWorktreeStore is the per-session, per-repo worktree registry. A
// single-repo session has one row; a workspace session has one root row plus
// one row per registered child repo.
//
// The rows are durable facts about a materialised workspace — branch, base SHA,
// filesystem path, preserved ref. Whether the worktree still exists on disk is
// not among them: that is probed, not remembered, because a remembered answer
// goes stale the moment a user deletes a directory behind AO's back.
type SessionWorktreeStore interface {
	// UpsertSessionWorktree records or replaces one repo worktree for a
	// session, keyed by (session, repo name).
	UpsertSessionWorktree(ctx context.Context, row domain.SessionWorktreeRecord) error
	// GetSessionWorktree returns one row, or ok=false when the session has no
	// worktree registered for that repo.
	GetSessionWorktree(ctx context.Context, sessionID domain.SessionID, repoName string) (domain.SessionWorktreeRecord, bool, error)
	// ListSessionWorktrees returns every repo worktree for a session, the root
	// repo first and children after it by name, so a workspace renders in a
	// stable order.
	ListSessionWorktrees(ctx context.Context, sessionID domain.SessionID) ([]domain.SessionWorktreeRecord, error)
	// DeleteSessionWorktrees removes every worktree row for a session. It is
	// idempotent: teardown runs more than once, and a session with no rows is
	// not an error.
	DeleteSessionWorktrees(ctx context.Context, sessionID domain.SessionID) error
}
