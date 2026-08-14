package chat

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// agyChatHookConversation is intentionally private to the Chat service. Agy's
// hook bridge is an adapter detail, not part of the provider-neutral Chat port.
type agyChatHookConversation interface {
	HandleAgyChatHook(
		ctx context.Context,
		event string,
		token string,
		payload []byte,
		onProviderID func(string) error,
	) (map[string]any, error)
}

// lateProviderConversationStore is optional so the broad Chat Store interface
// and its focused test doubles do not gain an Agy-specific persistence method.
type lateProviderConversationStore interface {
	RecordLateChatProviderConversationID(
		ctx context.Context,
		sessionID domain.SessionID,
		conversationID string,
		branchID string,
		generation string,
		providerConversationID string,
		now time.Time,
	) error
}

// HandleAgyChatHook serves the blocking Antigravity workspace hooks used by the
// Agy Chat driver. The driver authenticates the per-controller token before it
// invokes onProviderID; persistence therefore cannot be mutated by an unrelated
// local request that merely knows a session id.
func (s *Service) HandleAgyChatHook(
	ctx context.Context,
	id domain.SessionID,
	event string,
	token string,
	payload []byte,
) (map[string]any, error) {
	if _, err := s.requireChatSession(ctx, id); err != nil {
		return nil, err
	}
	controller, err := s.Controller(id)
	if err != nil {
		return nil, err
	}
	target, ok := controller.conv.(agyChatHookConversation)
	if !ok {
		return nil, fmt.Errorf("Agy Chat hooks: controller does not support the hook bridge")
	}
	writer, ok := s.store.(lateProviderConversationStore)
	if !ok {
		return nil, fmt.Errorf("Agy Chat hooks: store cannot persist a late provider conversation id")
	}

	return target.HandleAgyChatHook(ctx, event, token, payload, func(providerID string) error {
		providerID = strings.TrimSpace(providerID)
		if providerID == "" {
			return fmt.Errorf("Agy Chat hooks: provider conversation id is empty")
		}
		return writer.RecordLateChatProviderConversationID(
			ctx,
			id,
			controller.conversation.ID,
			controller.conversation.ActiveBranchID,
			controller.generation,
			providerID,
			s.now(),
		)
	})
}
