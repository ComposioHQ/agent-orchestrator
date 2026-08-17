package httpd

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

const (
	agyChatHookTokenHeader = "X-AO-Agy-Hook-Token"
	maxAgyChatHookBody     = 4 << 20
)

type agyChatHookService interface {
	HandleAgyChatHook(
		ctx context.Context,
		sessionID domain.SessionID,
		event string,
		token string,
		payload []byte,
	) (map[string]any, error)
}

type agyChatHookRequest struct {
	Payload json.RawMessage `json:"payload"`
}

// mountAgyChatHooks installs the long-lived loopback callback used by
// Antigravity's blocking PreToolUse hook. It stays outside the bounded REST
// timeout group because a legitimate approval may wait on a person for minutes.
func mountAgyChatHooks(r chi.Router, conversations *controllers.ConversationsController) {
	if conversations == nil || conversations.Svc == nil {
		return
	}
	svc, ok := conversations.Svc.(agyChatHookService)
	if !ok {
		return
	}

	r.Post("/internal/agy-chat/{sessionId}/{event}", func(w http.ResponseWriter, req *http.Request) {
		if !localControlRequest(req) {
			envelope.WriteAPIError(w, req, http.StatusForbidden, "forbidden", "LOCAL_CONTROL_REQUIRED", "Agy Chat hooks are loopback-only", nil)
			return
		}
		event := strings.TrimSpace(chi.URLParam(req, "event"))
		if event != "pre-invocation" && event != "pre-tool-use" {
			envelope.WriteAPIError(w, req, http.StatusNotFound, "not_found", "AGY_CHAT_HOOK_UNKNOWN", "unknown Agy Chat hook event", nil)
			return
		}
		if strings.TrimSpace(req.Header.Get(agyChatHookTokenHeader)) == "" {
			envelope.WriteAPIError(w, req, http.StatusForbidden, "forbidden", "AGY_CHAT_HOOK_TOKEN_REQUIRED", "Agy Chat hook token is required", nil)
			return
		}

		req.Body = http.MaxBytesReader(w, req.Body, maxAgyChatHookBody)
		var body agyChatHookRequest
		dec := json.NewDecoder(req.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil || len(body.Payload) == 0 {
			envelope.WriteAPIError(w, req, http.StatusBadRequest, "bad_request", "INVALID_JSON", "request body must contain an Agy hook payload", nil)
			return
		}

		response, err := svc.HandleAgyChatHook(
			req.Context(),
			domain.SessionID(chi.URLParam(req, "sessionId")),
			event,
			req.Header.Get(agyChatHookTokenHeader),
			body.Payload,
		)
		if err != nil {
			envelope.WriteAPIError(w, req, http.StatusConflict, "conflict", "AGY_CHAT_HOOK_REJECTED", "Agy Chat hook was rejected", nil)
			return
		}
		envelope.WriteJSON(w, http.StatusOK, response)
	})
}
