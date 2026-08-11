package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// CreateConversationTurn inserts a turn. Caller assigns ID.
func (s *Store) CreateConversationTurn(ctx context.Context, turn domain.ConversationTurn) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	now := time.Now().UTC()
	if turn.CreatedAt.IsZero() {
		turn.CreatedAt = now
	}
	if turn.UpdatedAt.IsZero() {
		turn.UpdatedAt = now
	}
	return s.qw.InsertConversationTurn(ctx, gen.InsertConversationTurnParams{
		ID:                  string(turn.ID),
		SessionID:           string(turn.SessionID),
		ConversationID:      string(turn.ConversationID),
		Role:                string(turn.Role),
		State:               string(turn.State),
		Text:                turn.Text,
		ClientID:            turn.ClientID,
		DeliveryContentJson: turn.DeliveryContentJSON,
		CreatedAt:           turn.CreatedAt,
		UpdatedAt:           turn.UpdatedAt,
	})
}

// GetConversationTurn fetches a turn by ID.
func (s *Store) GetConversationTurn(ctx context.Context, id domain.TurnID) (domain.ConversationTurn, bool, error) {
	row, err := s.qr.GetConversationTurn(ctx, string(id))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ConversationTurn{}, false, nil
		}
		return domain.ConversationTurn{}, false, fmt.Errorf("get conversation turn %s: %w", id, err)
	}
	return genTurnToDomain(row), true, nil
}

// UpdateConversationTurnState transitions a turn from expected state to newState.
// Returns true if exactly one row was updated (state matched).
func (s *Store) UpdateConversationTurnState(ctx context.Context, id domain.TurnID, expected domain.TurnState, next domain.TurnState) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.UpdateConversationTurnState(ctx, gen.UpdateConversationTurnStateParams{
		State:  string(next),
		ID:     string(id),
		State_2: string(expected),
	})
	if err != nil {
		return false, fmt.Errorf("update turn %s state: %w", id, err)
	}
	return rows > 0, nil
}

// ForceSetConversationTurnState sets state without checking expected (for tests/cleanup).
func (s *Store) ForceSetConversationTurnState(ctx context.Context, id domain.TurnID, state domain.TurnState) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	// Reuse update with any expected by doing direct SQL via writer DB.
	// We use the generated query with expected = current state probe.
	turn, ok, err := s.GetConversationTurn(ctx, id)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, nil
	}
	rows, err := s.qw.UpdateConversationTurnState(ctx, gen.UpdateConversationTurnStateParams{
		State:   string(state),
		ID:      string(id),
		State_2: string(turn.State),
	})
	if err != nil {
		return false, err
	}
	return rows > 0, nil
}

func genTurnToDomain(r gen.ConversationTurn) domain.ConversationTurn {
	return domain.ConversationTurn{
		ID:                  domain.TurnID(r.ID),
		SessionID:           domain.SessionID(r.SessionID),
		ConversationID:      domain.ConversationID(r.ConversationID),
		Role:                domain.TurnRole(r.Role),
		State:               domain.TurnState(r.State),
		Text:                r.Text,
		ClientID:            r.ClientID,
		DeliveryContentJSON: r.DeliveryContentJson,
		CreatedAt:           r.CreatedAt,
		UpdatedAt:           r.UpdatedAt,
	}
}
