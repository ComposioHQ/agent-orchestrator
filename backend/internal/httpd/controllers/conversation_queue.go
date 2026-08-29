package controllers

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

const cancelQueuedTurnPath = "/api/v1/sessions/{sessionId}/conversation/turns/{turnId}/cancel"
const editQueuedTurnPath = "/api/v1/sessions/{sessionId}/conversation/turns/{turnId}/queue/edit"

// EditQueuedConversationMessageRequest rewrites one undispatched queue item.
type EditQueuedConversationMessageRequest struct {
	Text string `json:"text"`
}

func (c *ConversationsController) cancelQueuedTurn(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", cancelQueuedTurnPath)
		return
	}
	err := c.Svc.CancelQueuedTurn(
		r.Context(),
		domain.SessionID(chi.URLParam(r, "sessionId")),
		chi.URLParam(r, "turnId"),
	)
	if err != nil {
		writeQueuedTurnMutationError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (c *ConversationsController) editQueuedTurn(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", editQueuedTurnPath)
		return
	}
	var req EditQueuedConversationMessageRequest
	if !decodeConversationBody(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "validation",
			"CHAT_QUEUED_TEXT_REQUIRED", "queued message text is required", nil)
		return
	}
	err := c.Svc.EditQueuedTurn(
		r.Context(),
		domain.SessionID(chi.URLParam(r, "sessionId")),
		chi.URLParam(r, "turnId"),
		req.Text,
	)
	if err != nil {
		writeQueuedTurnMutationError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeQueuedTurnMutationError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, chatsvc.ErrQueuedTurnTextRequired):
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "validation",
			"CHAT_QUEUED_TEXT_REQUIRED", "queued message text is required", nil)
	case errors.Is(err, store.ErrQueuedTurnNotAvailable):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict",
			"CHAT_TURN_NOT_QUEUED", "that message is no longer queued", nil)
	default:
		writeConversationError(w, r, err)
	}
}
