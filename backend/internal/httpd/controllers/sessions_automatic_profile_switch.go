package controllers

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

const (
	automaticProfileSwitchPolicyPath = "/api/v1/sessions/{sessionId}/automatic-profile-switch-policy"
	automaticProfileSwitchCancelPath = "/api/v1/sessions/{sessionId}/automatic-profile-switch-attempts/{attemptId}/cancel"
)

type sessionCodexAutomaticProfileSwitchService interface {
	CachedCodexAutomaticProfileSwitchPolicy(context.Context, domain.SessionID) (domain.CodexAutomaticProfileSwitchPolicy, error)
	PutCodexAutomaticProfileSwitchPolicy(context.Context, domain.SessionID, sessionmanager.PutCodexAutomaticProfileSwitchPolicyConfig) (domain.CodexAutomaticProfileSwitchPolicy, error)
	CancelCodexAutomaticProfileSwitchAttempt(context.Context, domain.SessionID, string) (domain.CodexAutomaticProfileSwitchAttempt, error)
}

func (c *SessionsController) codexAutomaticProfileSwitchService() (sessionCodexAutomaticProfileSwitchService, bool) {
	service, ok := c.Svc.(sessionCodexAutomaticProfileSwitchService)
	return service, ok
}

func (c *SessionsController) codexAutomaticProfileSwitchPolicy(w http.ResponseWriter, r *http.Request) {
	service, ok := c.codexAutomaticProfileSwitchService()
	if !ok {
		apispec.NotImplemented(w, r, http.MethodGet, automaticProfileSwitchPolicyPath)
		return
	}
	policy, err := service.CachedCodexAutomaticProfileSwitchPolicy(r.Context(), sessionID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, policy)
}

func (c *SessionsController) putCodexAutomaticProfileSwitchPolicy(w http.ResponseWriter, r *http.Request) {
	service, ok := c.codexAutomaticProfileSwitchService()
	if !ok {
		apispec.NotImplemented(w, r, http.MethodPut, automaticProfileSwitchPolicyPath)
		return
	}
	var in PutCodexAutomaticProfileSwitchPolicyRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	policy, err := service.PutCodexAutomaticProfileSwitchPolicy(r.Context(), sessionID(r), sessionmanager.PutCodexAutomaticProfileSwitchPolicyConfig{
		Enabled: in.Enabled, ProfileIDs: in.ProfileIDs, ExpectedRevision: in.ExpectedRevision,
	})
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, policy)
}

func (c *SessionsController) cancelCodexAutomaticProfileSwitchAttempt(w http.ResponseWriter, r *http.Request) {
	service, ok := c.codexAutomaticProfileSwitchService()
	if !ok {
		apispec.NotImplemented(w, r, http.MethodPost, automaticProfileSwitchCancelPath)
		return
	}
	attemptID := strings.TrimSpace(chi.URLParam(r, "attemptId"))
	attempt, err := service.CancelCodexAutomaticProfileSwitchAttempt(r.Context(), sessionID(r), attemptID)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, attempt)
}

var _ sessionCodexAutomaticProfileSwitchService = (*sessionsvc.Service)(nil)
