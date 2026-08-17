package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// RecordLateChatProviderConversationID persists a native thread id discovered
// after a Chat controller has already been committed. Agy allocates the id only
// once its first headless turn starts, so Start cannot return it synchronously.
//
// The controller generation fences a stale hook from an older controller. Both
// the live session row and its active branch are updated in one transaction so a
// daemon restart and a future branch read cannot disagree about native identity.
func (s *Store) RecordLateChatProviderConversationID(
	ctx context.Context,
	sessionID domain.SessionID,
	conversationID string,
	branchID string,
	generation string,
	providerConversationID string,
	now time.Time,
) error {
	providerConversationID = strings.TrimSpace(providerConversationID)
	if providerConversationID == "" {
		return fmt.Errorf("record late chat provider id: provider conversation id is required")
	}
	if strings.TrimSpace(generation) == "" {
		return fmt.Errorf("record late chat provider id: controller generation is required")
	}
	if strings.TrimSpace(conversationID) == "" || strings.TrimSpace(branchID) == "" {
		return fmt.Errorf("record late chat provider id: conversation and branch are required")
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("record late chat provider id: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var current string
	err = tx.QueryRowContext(ctx, `
SELECT provider_conversation_id
FROM sessions
WHERE id = ?
  AND session_mode = 'chat'
  AND is_terminated = 0
  AND controller_generation = ?
LIMIT 1`, string(sessionID), generation).Scan(&current)
	if err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("record late chat provider id: live controller generation no longer owns session %s", sessionID)
		}
		return fmt.Errorf("record late chat provider id: read session: %w", err)
	}
	if current != "" && current != providerConversationID {
		return fmt.Errorf("record late chat provider id: session %s already belongs to native conversation %s", sessionID, current)
	}
	if current == "" {
		result, execErr := tx.ExecContext(ctx, `
UPDATE sessions
SET provider_conversation_id = ?, updated_at = ?
WHERE id = ?
  AND session_mode = 'chat'
  AND is_terminated = 0
  AND controller_generation = ?
  AND provider_conversation_id = ''`,
			providerConversationID, now, string(sessionID), generation)
		if execErr != nil {
			return fmt.Errorf("record late chat provider id: update session: %w", execErr)
		}
		rows, rowsErr := result.RowsAffected()
		if rowsErr != nil || rows != 1 {
			return fmt.Errorf("record late chat provider id: session ownership changed during update")
		}
	}

	var branchCurrent string
	err = tx.QueryRowContext(ctx, `
SELECT provider_conversation_id
FROM conversation_branches
WHERE id = ? AND conversation_id = ?
LIMIT 1`, branchID, conversationID).Scan(&branchCurrent)
	if err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("record late chat provider id: active conversation branch no longer exists")
		}
		return fmt.Errorf("record late chat provider id: read branch: %w", err)
	}
	if branchCurrent != "" && branchCurrent != providerConversationID {
		return fmt.Errorf("record late chat provider id: branch %s already belongs to native conversation %s", branchID, branchCurrent)
	}
	if branchCurrent == "" {
		result, execErr := tx.ExecContext(ctx, `
UPDATE conversation_branches
SET provider_conversation_id = ?
WHERE id = ? AND conversation_id = ? AND provider_conversation_id = ''`,
			providerConversationID, branchID, conversationID)
		if execErr != nil {
			return fmt.Errorf("record late chat provider id: update branch: %w", execErr)
		}
		rows, rowsErr := result.RowsAffected()
		if rowsErr != nil || rows != 1 {
			return fmt.Errorf("record late chat provider id: branch ownership changed during update")
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("record late chat provider id: commit: %w", err)
	}
	return nil
}
