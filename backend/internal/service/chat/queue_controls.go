package chat

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// CancelQueuedTurn settles one accepted prompt before it reaches the provider.
// The session's persisted mode and live controller remain the authority, just as
// they are for send and promotion; callers cannot mutate a queue by turn id alone.
func (s *Service) CancelQueuedTurn(
	ctx context.Context,
	id domain.SessionID,
	turnID string,
) error {
	if _, err := s.requireChatSession(ctx, id); err != nil {
		return err
	}
	controller, err := s.Controller(id)
	if err != nil {
		return err
	}
	return controller.CancelQueuedTurn(ctx, turnID)
}

// CancelQueuedTurn serializes with dispatch and promotion, then uses a durable
// compare-and-set. This makes "cancel one" precise even when a completion is
// trying to drain the queue at the same moment.
func (c *Controller) CancelQueuedTurn(ctx context.Context, turnID string) error {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	if c.handoffActive() {
		return ErrControllerHandoff
	}
	if c.interruptPendingLocked() {
		return fmt.Errorf("%w: %s", ErrTurnNotQueued, turnID)
	}

	turn, err := c.store.TurnByID(ctx, turnID)
	if err != nil {
		return err
	}
	if turn.ConversationID != c.conversation.ID {
		return fmt.Errorf("%w: %s", domain.ErrNoConversationTurn, turnID)
	}
	if turn.State != domain.TurnStateQueued {
		return fmt.Errorf("%w: %s", ErrTurnNotQueued, turnID)
	}
	cancelled, err := c.store.CancelQueuedTurn(ctx, c.conversation.ID, turnID, c.now())
	if err != nil {
		return fmt.Errorf("cancel queued turn %s: %w", turnID, err)
	}
	if !cancelled {
		return fmt.Errorf("%w: %s", ErrTurnNotQueued, turnID)
	}
	return nil
}
