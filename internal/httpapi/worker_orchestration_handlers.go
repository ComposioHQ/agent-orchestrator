package httpapi

import (
	"net/http"
	"strings"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/worker"
	"github.com/go-chi/chi/v5"
)

type createWorkerChildRequest struct {
	Harness                     string   `json:"harness"`
	DisplayName                 string   `json:"displayName"`
	Prompt                      string   `json:"prompt"`
	Mode                        string   `json:"mode,omitempty"`
	DeniedCommands              []string `json:"deniedCommands,omitempty"`
	SandboxProviderConnectionID string   `json:"sandboxProviderConnectionId,omitempty"`
}

func (s *Server) listWorkerChildren(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireOrchestratorScope(w, r)
	if !ok {
		return
	}
	limit, err := parseLimit(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	cursor, err := parseCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_cursor", "The pagination cursor is invalid.")
		return
	}
	children, hasMore, err := s.store.ListOrchestratorChildren(
		r.Context(), claims.OrgID, claims.SessionID, cursor, limit,
	)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	items := make([]sessionResponse, 0, len(children))
	for _, child := range children {
		items = append(items, toSessionResponse(child))
	}
	page := pageInfo{HasMore: hasMore}
	if hasMore && len(children) > 0 {
		last := children[len(children)-1]
		page.NextCursor = encodeCursor(last.UpdatedAt, last.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "page": page})
}

func (s *Server) createWorkerChild(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireOrchestratorScope(w, r)
	if !ok {
		return
	}
	key, err := idempotencyKey(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	var request createWorkerChildRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "The request body is invalid.")
		return
	}
	request.Harness = strings.TrimSpace(request.Harness)
	request.DisplayName = strings.TrimSpace(request.DisplayName)
	request.Mode = strings.TrimSpace(request.Mode)
	request.SandboxProviderConnectionID = strings.TrimSpace(request.SandboxProviderConnectionID)
	if request.Mode == "" {
		request.Mode = "standard"
	}
	validation := createSessionRequest{
		ProjectID: claims.SessionID, Kind: "worker",
		Harness: request.Harness, DisplayName: request.DisplayName,
		Prompt: request.Prompt, Mode: request.Mode,
		DeniedCommands:              request.DeniedCommands,
		SandboxProviderConnectionID: request.SandboxProviderConnectionID,
	}
	if !validSessionInput(validation) {
		writeError(w, r, http.StatusUnprocessableEntity, "validation_error", "Child session input is invalid.")
		return
	}
	plan, err := s.provisioning.SessionPlan()
	if err != nil {
		s.logger.Error("resolve child sandbox provisioning plan", "error", err, "request_id", requestID(r))
		writeError(w, r, http.StatusInternalServerError, "internal_error", "Sandbox provisioning is misconfigured.")
		return
	}
	child, err := s.store.CreateOrchestratorChild(
		r.Context(), claims.OrgID, claims.SessionID, key, s.maxSandboxes,
		domain.CreateSession{
			Kind: "worker", Harness: request.Harness, DisplayName: request.DisplayName,
			Prompt: request.Prompt, Mode: request.Mode, DeniedCommands: request.DeniedCommands,
			Provider: plan.Provider, SandboxConnectionID: request.SandboxProviderConnectionID,
			ResourceProfile: plan.ResourceProfile, BootstrapContext: plan.BootstrapContext,
			Release: s.release,
		},
	)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"session": toSessionResponse(child)})
}

func (s *Server) sendWorkerChildMessage(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireOrchestratorScope(w, r)
	if !ok {
		return
	}
	childID := chi.URLParam(r, "sessionId")
	if requireUUID(childID, "sessionId") != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "sessionId must be a UUID.")
		return
	}
	key, err := idempotencyKey(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	var request sendMessageRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "The request body is invalid.")
		return
	}
	if strings.TrimSpace(request.Text) == "" || len(request.Text) > 65536 {
		writeError(w, r, http.StatusUnprocessableEntity, "validation_error", "Message text must be between 1 and 65536 bytes.")
		return
	}
	event, err := s.store.SendOrchestratorChildMessage(
		r.Context(), claims.OrgID, claims.SessionID, childID, key, request.Text,
	)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"event": toClientEventResponse(event)})
}

func requireOrchestratorScope(w http.ResponseWriter, r *http.Request) (worker.Claims, bool) {
	claims := workerFrom(r)
	if !worker.HasScope(claims, "worker:orchestrate") {
		writeError(w, r, http.StatusForbidden, "SCOPE_REQUIRED", "The worker:orchestrate scope is required.")
		return worker.Claims{}, false
	}
	return claims, true
}
