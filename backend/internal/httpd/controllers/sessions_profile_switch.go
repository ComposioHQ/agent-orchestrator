package controllers

import (
	"bytes"
	"context"
	"encoding/json"
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
	profileSwitchOptionsPath       = "/api/v1/sessions/{sessionId}/profile-switch-options"
	profileSwitchOptionsEnsurePath = "/api/v1/sessions/{sessionId}/profile-switch-options/ensure"
	profileSwitchesPath            = "/api/v1/sessions/{sessionId}/profile-switches"
	profileSwitchPath              = "/api/v1/sessions/{sessionId}/profile-switches/{switchId}"
)

type sessionCodexProfileSwitchService interface {
	CachedCodexProfileSwitchOptions(context.Context, domain.SessionID) (domain.CodexProfileSwitchOptions, error)
	EnsureCodexProfileSwitchOptions(context.Context, domain.SessionID) (domain.CodexProfileSwitchOptions, error)
	StartCodexProfileSwitch(context.Context, domain.SessionID, sessionmanager.StartCodexProfileSwitchConfig) (domain.CodexProfileSwitch, error)
	ListCodexProfileSwitches(context.Context, domain.SessionID) ([]domain.CodexProfileSwitch, error)
	GetCodexProfileSwitch(context.Context, domain.SessionID, domain.CodexProfileSwitchID) (domain.CodexProfileSwitch, error)
	CancelCodexProfileSwitch(context.Context, domain.SessionID, domain.CodexProfileSwitchID) (domain.CodexProfileSwitch, error)
	RecoverCodexProfileSwitch(context.Context, domain.SessionID, domain.CodexProfileSwitchID) (domain.CodexProfileSwitch, error)
	RestoreCodexProfileSwitchSource(context.Context, domain.SessionID, domain.CodexProfileSwitchID) (domain.CodexProfileSwitch, error)
	SubmitCodexProfileSwitchHandoff(context.Context, domain.SessionID, domain.CodexProfileSwitchID, domain.AgentGenerationID, json.RawMessage) (domain.CodexProfileSwitch, error)
}

func (c *SessionsController) codexProfileSwitchService() (sessionCodexProfileSwitchService, bool) {
	service, ok := c.Svc.(sessionCodexProfileSwitchService)
	return service, ok
}

func (c *SessionsController) codexProfileSwitchOptions(w http.ResponseWriter, r *http.Request) {
	service, ok := c.codexProfileSwitchService()
	if !ok {
		apispec.NotImplemented(w, r, http.MethodGet, profileSwitchOptionsPath)
		return
	}
	options, err := service.CachedCodexProfileSwitchOptions(r.Context(), sessionID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, options)
}

func (c *SessionsController) ensureCodexProfileSwitchOptions(w http.ResponseWriter, r *http.Request) {
	service, ok := c.codexProfileSwitchService()
	if !ok {
		apispec.NotImplemented(w, r, http.MethodPost, profileSwitchOptionsEnsurePath)
		return
	}
	options, err := service.EnsureCodexProfileSwitchOptions(r.Context(), sessionID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, options)
}

func (c *SessionsController) startCodexProfileSwitch(w http.ResponseWriter, r *http.Request) {
	service, ok := c.codexProfileSwitchService()
	if !ok {
		apispec.NotImplemented(w, r, http.MethodPost, profileSwitchesPath)
		return
	}
	var in StartCodexProfileSwitchRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	in.TargetProfileID, in.IdempotencyKey = strings.TrimSpace(in.TargetProfileID), strings.TrimSpace(in.IdempotencyKey)
	if in.TargetProfileID == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "CODEX_PROFILE_NOT_FOUND", "A target profile is required", nil)
		return
	}
	if in.IdempotencyKey == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "IDEMPOTENCY_KEY_REQUIRED", "An idempotency key is required", nil)
		return
	}
	if len(in.IdempotencyKey) > maxIdempotencyKey {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_IDEMPOTENCY_KEY", "The idempotency key is too long", nil)
		return
	}
	sw, err := service.StartCodexProfileSwitch(r.Context(), sessionID(r), sessionmanager.StartCodexProfileSwitchConfig{
		TargetProfileID: in.TargetProfileID, IdempotencyKey: in.IdempotencyKey,
		AcknowledgeUnknownCapacity: in.AcknowledgeUnknownCapacity,
	})
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusAccepted, CodexProfileSwitchResponse{Switch: sw})
}

func (c *SessionsController) listCodexProfileSwitches(w http.ResponseWriter, r *http.Request) {
	service, ok := c.codexProfileSwitchService()
	if !ok {
		apispec.NotImplemented(w, r, http.MethodGet, profileSwitchesPath)
		return
	}
	switches, err := service.ListCodexProfileSwitches(r.Context(), sessionID(r))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ListCodexProfileSwitchesResponse{Switches: switches})
}

func (c *SessionsController) getCodexProfileSwitch(w http.ResponseWriter, r *http.Request) {
	c.writeCodexProfileSwitchResult(w, r, "get")
}

func (c *SessionsController) cancelCodexProfileSwitch(w http.ResponseWriter, r *http.Request) {
	c.writeCodexProfileSwitchResult(w, r, "cancel")
}

func (c *SessionsController) recoverCodexProfileSwitch(w http.ResponseWriter, r *http.Request) {
	c.writeCodexProfileSwitchResult(w, r, "recover")
}

func (c *SessionsController) restoreCodexProfileSwitchSource(w http.ResponseWriter, r *http.Request) {
	c.writeCodexProfileSwitchResult(w, r, "restore-source")
}

func (c *SessionsController) submitCodexProfileSwitchHandoff(w http.ResponseWriter, r *http.Request) {
	service, ok := c.codexProfileSwitchService()
	if !ok {
		apispec.NotImplemented(w, r, http.MethodPost, profileSwitchPath+"/handoff")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxAgentHandoffBodyBytes)
	var in SubmitAgentHandoffRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	generation := domain.AgentGenerationID(strings.TrimSpace(string(in.SourceGenerationID)))
	if generation == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "SOURCE_GENERATION_REQUIRED", "sourceGenerationId is required", nil)
		return
	}
	if len(bytes.TrimSpace(in.Handoff)) == 0 || len(in.Handoff) > maxAgentHandoffBytes {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_CODEX_PROFILE_SWITCH_HANDOFF", "handoff must be a JSON object no larger than 64 KiB", nil)
		return
	}
	switchID := domain.CodexProfileSwitchID(strings.TrimSpace(chi.URLParam(r, "switchId")))
	sw, err := service.SubmitCodexProfileSwitchHandoff(r.Context(), sessionID(r), switchID, generation, in.Handoff)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, CodexProfileSwitchResponse{Switch: sw})
}

func (c *SessionsController) writeCodexProfileSwitchResult(w http.ResponseWriter, r *http.Request, action string) {
	service, ok := c.codexProfileSwitchService()
	if !ok {
		apispec.NotImplemented(w, r, r.Method, profileSwitchPath)
		return
	}
	id := sessionID(r)
	switchID := domain.CodexProfileSwitchID(strings.TrimSpace(chi.URLParam(r, "switchId")))
	var (
		sw  domain.CodexProfileSwitch
		err error
	)
	switch action {
	case "get":
		sw, err = service.GetCodexProfileSwitch(r.Context(), id, switchID)
	case "cancel":
		sw, err = service.CancelCodexProfileSwitch(r.Context(), id, switchID)
	case "recover":
		sw, err = service.RecoverCodexProfileSwitch(r.Context(), id, switchID)
	case "restore-source":
		sw, err = service.RestoreCodexProfileSwitchSource(r.Context(), id, switchID)
	}
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, CodexProfileSwitchResponse{Switch: sw})
}

var _ sessionCodexProfileSwitchService = (*sessionsvc.Service)(nil)
