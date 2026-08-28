package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// BindCodexSessionProfile inserts an immutable binding or returns the existing
// row. The caller compares identities so a different request becomes a typed
// domain conflict rather than an UPDATE.
func (s *Store) BindCodexSessionProfile(ctx context.Context, binding domain.CodexSessionBinding) (domain.CodexSessionBinding, bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	var out domain.CodexSessionBinding
	created := false
	err := s.inTx(ctx, fmt.Sprintf("bind Codex profile for session %s", binding.SessionID), func(q *gen.Queries) error {
		row, err := q.GetCodexSessionBinding(ctx, binding.SessionID)
		if err == nil {
			out = codexBindingFromRow(row)
			if out.ProfileID != binding.ProfileID || out.Source != binding.Source || out.Home != binding.Home {
				return domain.ErrCodexProfileBindingConflict
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err := q.InsertCodexSessionBinding(ctx, bindingToInsert(binding)); err != nil {
			return err
		}
		out = binding
		created = true
		return nil
	})
	if err != nil {
		return domain.CodexSessionBinding{}, false, err
	}
	return out, created, nil
}

func bindingToInsert(binding domain.CodexSessionBinding) gen.InsertCodexSessionBindingParams {
	return gen.InsertCodexSessionBindingParams{
		SessionID: binding.SessionID, ProfileID: binding.ProfileID,
		ProfileSource: binding.Source, CodexHome: binding.Home, CreatedAt: binding.CreatedAt,
	}
}

func codexBindingFromRow(row gen.CodexSessionBinding) domain.CodexSessionBinding {
	return domain.CodexSessionBinding{
		SessionID: row.SessionID, ProfileID: row.ProfileID, Source: row.ProfileSource,
		Home: row.CodexHome, CreatedAt: row.CreatedAt,
	}
}
