package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const sessionWorktreeColumns = `session_id, repo_name, branch, base_sha, base_ref,
	worktree_path, preserved_ref, state`

// UpsertSessionWorktree records or replaces one repo worktree for a session.
func (s *Store) UpsertSessionWorktree(ctx context.Context, row domain.SessionWorktreeRecord) error {
	// State is unused multi-repo scaffolding: no live path sets it, so it
	// arrives empty and the CHECK constraint would reject it. Default to the
	// column's own default rather than widening the constraint to accept "".
	state := row.State
	if state == "" {
		state = "active"
	}
	if err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(
			ctx,
			`INSERT INTO ao_session_worktrees (
				org_id, owner_user_id, session_id, repo_name, branch, base_sha, base_ref,
				worktree_path, preserved_ref, state
			) VALUES (
				ao_current_org_id(), ao_current_user_id(), $1, $2, $3, $4, $5, $6, $7, $8
			)
			ON CONFLICT (org_id, owner_user_id, session_id, repo_name) DO UPDATE SET
				branch = EXCLUDED.branch,
				base_sha = EXCLUDED.base_sha,
				base_ref = EXCLUDED.base_ref,
				worktree_path = EXCLUDED.worktree_path,
				preserved_ref = EXCLUDED.preserved_ref,
				state = EXCLUDED.state,
				updated_at = now()`,
			row.SessionID, row.RepoName, row.Branch, row.BaseSHA, row.BaseRef,
			row.WorktreePath, row.PreservedRef, state,
		)
		return err
	}); err != nil {
		return fmt.Errorf("upsert session worktree %s/%s: %w", row.SessionID, row.RepoName, normalizeError(err))
	}
	return nil
}

// GetSessionWorktree returns one worktree row, or ok=false when the session has
// none registered for that repo.
func (s *Store) GetSessionWorktree(
	ctx context.Context,
	sessionID domain.SessionID,
	repoName string,
) (domain.SessionWorktreeRecord, bool, error) {
	var rec domain.SessionWorktreeRecord
	found := false
	err := s.inTenantRead(ctx, func(tx pgx.Tx) error {
		row, err := scanSessionWorktree(tx.QueryRow(
			ctx,
			`SELECT `+sessionWorktreeColumns+`
			 FROM ao_session_worktrees
			 WHERE session_id = $1 AND repo_name = $2`,
			sessionID, repoName,
		))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		rec, found = row, true
		return nil
	})
	if err != nil {
		return domain.SessionWorktreeRecord{}, false,
			fmt.Errorf("get session worktree %s/%s: %w", sessionID, repoName, normalizeError(err))
	}
	return rec, found, nil
}

// ListSessionWorktrees returns every repo worktree for a session, root first.
// The root row is the session's own repository; child rows follow by name so
// the workspace renders in a stable order.
func (s *Store) ListSessionWorktrees(
	ctx context.Context,
	sessionID domain.SessionID,
) ([]domain.SessionWorktreeRecord, error) {
	out := make([]domain.SessionWorktreeRecord, 0)
	err := s.inTenantRead(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			`SELECT `+sessionWorktreeColumns+`
			 FROM ao_session_worktrees
			 WHERE session_id = $1
			 ORDER BY (repo_name <> $2), repo_name`,
			sessionID, domain.RootWorkspaceRepoName,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		out = out[:0]
		for rows.Next() {
			rec, err := scanSessionWorktree(rows)
			if err != nil {
				return err
			}
			out = append(out, rec)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("list session worktrees for %s: %w", sessionID, normalizeError(err))
	}
	return out, nil
}

// DeleteSessionWorktrees removes every worktree row for a session. Deleting
// rows that are not there is not an error: teardown runs more than once.
func (s *Store) DeleteSessionWorktrees(ctx context.Context, sessionID domain.SessionID) error {
	if err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM ao_session_worktrees WHERE session_id = $1`, sessionID)
		return err
	}); err != nil {
		return fmt.Errorf("delete session worktrees for %s: %w", sessionID, normalizeError(err))
	}
	return nil
}

func scanSessionWorktree(row scannable) (domain.SessionWorktreeRecord, error) {
	var rec domain.SessionWorktreeRecord
	if err := row.Scan(
		&rec.SessionID, &rec.RepoName, &rec.Branch, &rec.BaseSHA, &rec.BaseRef,
		&rec.WorktreePath, &rec.PreservedRef, &rec.State,
	); err != nil {
		return domain.SessionWorktreeRecord{}, err
	}
	return rec, nil
}
