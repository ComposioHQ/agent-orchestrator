package controllers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

// CodexProfileService is the controller-facing profile discovery and browser
// authentication boundary.
type CodexProfileService interface {
	CachedCodexProfiles(context.Context) (agentsvc.CodexProfiles, error)
	EnsureCodexProfiles(context.Context, []string, domain.AgentReadinessPurpose) (agentsvc.CodexProfiles, error)
	EnsureCodexProfileCapacity(context.Context, []string) (agentsvc.CodexProfiles, error)
	SubscribeCodexProfileCapacity(context.Context) (<-chan agentsvc.CodexProfileCapacityEvent, error)
	CreateCodexProfile(context.Context, string) (domain.CodexProfileSnapshot, error)
	StartCodexProfileLogin(context.Context, string) (agentsvc.CodexProfileLoginStart, error)
	SubscribeCodexProfileLogin(context.Context, string, string) (<-chan domain.CodexProfileLoginEvent, error)
	CancelCodexProfileLogin(context.Context, string, string) (domain.CodexProfileLoginEvent, error)
}

// CodexProfilesController exposes cached discovery, readiness, and browser login.
type CodexProfilesController struct{ Svc CodexProfileService }

// Register installs request-timeout-bound Codex profile routes.
func (c *CodexProfilesController) Register(r chi.Router) {
	r.Get("/agents/codex/profiles", c.list)
	r.Post("/agents/codex/profiles/ensure", c.ensure)
	r.Post("/agents/codex/profiles/capacity/ensure", c.ensureCapacity)
	r.Post("/agents/codex/profiles", c.create)
	r.Post("/agents/codex/profiles/{profileId}/login", c.startLogin)
	r.Post("/agents/codex/profiles/{profileId}/login/{operationId}/cancel", c.cancelLogin)
}

// RegisterStreams installs the SSE route outside the ordinary request timeout.
func (c *CodexProfilesController) RegisterStreams(r chi.Router) {
	r.Get("/agents/codex/profiles/{profileId}/login/{operationId}/events", c.loginEvents)
	r.Get("/agents/codex/profiles/capacity/events", c.capacityEvents)
}

func (c *CodexProfilesController) list(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/agents/codex/profiles")
		return
	}
	result, err := c.Svc.CachedCodexProfiles(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, result)
}

func (c *CodexProfilesController) ensure(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/codex/profiles/ensure")
		return
	}
	var request EnsureCodexProfilesRequest
	if err := decodeJSONStrict(r, &request); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	result, err := c.Svc.EnsureCodexProfiles(r.Context(), request.ProfileIDs, request.Purpose)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, result)
}

func (c *CodexProfilesController) create(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/codex/profiles")
		return
	}
	var request CreateCodexProfileRequest
	if err := decodeJSONStrict(r, &request); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	result, err := c.Svc.CreateCodexProfile(r.Context(), request.Label)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, result)
}

func (c *CodexProfilesController) ensureCapacity(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/codex/profiles/capacity/ensure")
		return
	}
	var request EnsureCodexProfileCapacityRequest
	if err := decodeJSONStrict(r, &request); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	result, err := c.Svc.EnsureCodexProfileCapacity(r.Context(), request.ProfileIDs)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, result)
}

func (c *CodexProfilesController) startLogin(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/codex/profiles/{profileId}/login")
		return
	}
	result, err := c.Svc.StartCodexProfileLogin(r.Context(), strings.TrimSpace(chi.URLParam(r, "profileId")))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusAccepted, result)
}

func (c *CodexProfilesController) cancelLogin(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/codex/profiles/{profileId}/login/{operationId}/cancel")
		return
	}
	result, err := c.Svc.CancelCodexProfileLogin(r.Context(), strings.TrimSpace(chi.URLParam(r, "profileId")), strings.TrimSpace(chi.URLParam(r, "operationId")))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, result)
}

func (c *CodexProfilesController) loginEvents(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/agents/codex/profiles/{profileId}/login/{operationId}/events")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "SSE_UNSUPPORTED", "Streaming is not supported by this server", nil)
		return
	}
	events, err := c.Svc.SubscribeCodexProfileLogin(r.Context(), strings.TrimSpace(chi.URLParam(r, "profileId")), strings.TrimSpace(chi.URLParam(r, "operationId")))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			data, marshalErr := json.Marshal(event)
			if marshalErr != nil {
				return
			}
			if _, writeErr := fmt.Fprintf(w, "event: codex_profile_login\ndata: %s\n\n", data); writeErr != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (c *CodexProfilesController) capacityEvents(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/agents/codex/profiles/capacity/events")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "SSE_UNSUPPORTED", "Streaming is not supported by this server", nil)
		return
	}
	events, err := c.Svc.SubscribeCodexProfileCapacity(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			if _, writeErr := fmt.Fprint(w, ": heartbeat\n\n"); writeErr != nil {
				return
			}
			flusher.Flush()
		case event, ok := <-events:
			if !ok {
				return
			}
			data, marshalErr := json.Marshal(event)
			if marshalErr != nil {
				return
			}
			if _, writeErr := fmt.Fprintf(w, "event: codex_profile_capacity\ndata: %s\n\n", data); writeErr != nil {
				return
			}
			flusher.Flush()
		}
	}
}
