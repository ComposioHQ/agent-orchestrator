package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/placement"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

const idempotencyHeader = "Idempotency-Key"

// WorkspacePlacementService is the transport boundary for durable placement
// acceptance. Implementations enqueue provider work only after persisting it.
type WorkspacePlacementService interface {
	Create(context.Context, domain.CreateWorkspacePlacement) (domain.WorkspacePlacement, error)
	Get(context.Context, string) (domain.WorkspacePlacement, error)
	List(context.Context, string, int) (domain.WorkspacePlacementPage, error)
	Delete(context.Context, string, string) (domain.WorkspacePlacement, error)
	Resume(context.Context, string, string) (domain.WorkspacePlacement, error)
}

type createWorkspacePlacementRequest struct {
	DisplayName   string          `json:"displayName"`
	RepositoryURL string          `json:"repositoryUrl"`
	DefaultBranch string          `json:"defaultBranch"`
	Config        json.RawMessage `json:"config"`
}

type workspacePlacementResponse struct {
	ID          string    `json:"id"`
	OrgID       string    `json:"orgId"`
	OwnerUserID string    `json:"ownerUserId"`
	State       string    `json:"state"`
	ProjectID   string    `json:"projectId,omitempty"`
	Message     string    `json:"message,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type workspacePlacementPageResponse struct {
	Workspaces []workspacePlacementResponse `json:"workspaces"`
	PageInfo   placementPageInfo            `json:"pageInfo"`
}

type placementPageInfo struct {
	HasMore    bool   `json:"hasMore"`
	NextCursor string `json:"nextCursor,omitempty"`
}

func (s *Server) registerWorkspacePlacementRoutes(router chi.Router) {
	if s.placement == nil {
		return
	}
	authenticated := router.With(s.requirePrincipal)
	authenticated.Get("/api/cloud/v1/orgs/{orgId}/workspaces", s.listWorkspacePlacements)
	authenticated.Post("/api/cloud/v1/orgs/{orgId}/workspaces", s.createWorkspacePlacement)
	authenticated.Get("/api/cloud/v1/orgs/{orgId}/workspaces/{workspaceId}", s.getWorkspacePlacement)
	authenticated.Delete("/api/cloud/v1/orgs/{orgId}/workspaces/{workspaceId}", s.deleteWorkspacePlacement)
	authenticated.Post("/api/cloud/v1/orgs/{orgId}/workspaces/{workspaceId}/resume", s.resumeWorkspacePlacement)
}

func (s *Server) createWorkspacePlacement(w http.ResponseWriter, r *http.Request) {
	ctx, ok := s.workspacePlacementContext(w, r)
	if !ok {
		return
	}
	key, ok := placementIdempotencyKey(w, r)
	if !ok {
		return
	}
	var request createWorkspacePlacementRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	record, err := s.placement.Create(ctx, domain.CreateWorkspacePlacement{
		DisplayName: request.DisplayName, RepositoryURL: request.RepositoryURL,
		DefaultBranch: request.DefaultBranch, Config: request.Config, IdempotencyKey: key,
	})
	if err != nil {
		s.writePlacementError(w, r, "create workspace placement", err)
		return
	}
	writeJSON(w, http.StatusAccepted, toWorkspacePlacementResponse(record))
}

func (s *Server) listWorkspacePlacements(w http.ResponseWriter, r *http.Request) {
	ctx, ok := s.workspacePlacementContext(w, r)
	if !ok {
		return
	}
	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			writeError(w, r, http.StatusBadRequest, "bad_request", "INVALID_PAGINATION", "limit must be between 1 and 100")
			return
		}
		limit = parsed
	}
	cursor := strings.TrimSpace(r.URL.Query().Get("cursor"))
	if len(cursor) > 2048 {
		writeError(w, r, http.StatusBadRequest, "bad_request", "INVALID_PAGINATION", "cursor is invalid")
		return
	}
	page, err := s.placement.List(ctx, cursor, limit)
	if err != nil {
		s.writePlacementError(w, r, "list workspace placements", err)
		return
	}
	response := workspacePlacementPageResponse{
		Workspaces: make([]workspacePlacementResponse, 0, len(page.Workspaces)),
		PageInfo:   placementPageInfo{HasMore: page.HasMore, NextCursor: page.NextCursor},
	}
	for _, record := range page.Workspaces {
		response.Workspaces = append(response.Workspaces, toWorkspacePlacementResponse(record))
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) getWorkspacePlacement(w http.ResponseWriter, r *http.Request) {
	ctx, id, ok := s.workspacePlacementItemContext(w, r)
	if !ok {
		return
	}
	record, err := s.placement.Get(ctx, id)
	if err != nil {
		s.writePlacementError(w, r, "get workspace placement", err)
		return
	}
	writeJSON(w, http.StatusOK, toWorkspacePlacementResponse(record))
}

func (s *Server) deleteWorkspacePlacement(w http.ResponseWriter, r *http.Request) {
	ctx, id, ok := s.workspacePlacementItemContext(w, r)
	if !ok {
		return
	}
	key, ok := placementIdempotencyKey(w, r)
	if !ok {
		return
	}
	record, err := s.placement.Delete(ctx, id, key)
	if err != nil {
		s.writePlacementError(w, r, "delete workspace placement", err)
		return
	}
	writeJSON(w, http.StatusAccepted, toWorkspacePlacementResponse(record))
}

func (s *Server) resumeWorkspacePlacement(w http.ResponseWriter, r *http.Request) {
	ctx, id, ok := s.workspacePlacementItemContext(w, r)
	if !ok {
		return
	}
	key, ok := placementIdempotencyKey(w, r)
	if !ok {
		return
	}
	record, err := s.placement.Resume(ctx, id, key)
	if err != nil {
		s.writePlacementError(w, r, "resume workspace placement", err)
		return
	}
	writeJSON(w, http.StatusAccepted, toWorkspacePlacementResponse(record))
}

func (s *Server) workspacePlacementItemContext(w http.ResponseWriter, r *http.Request) (context.Context, string, bool) {
	ctx, ok := s.workspacePlacementContext(w, r)
	if !ok {
		return nil, "", false
	}
	id := strings.TrimSpace(chi.URLParam(r, "workspaceId"))
	if uuid.Validate(id) != nil {
		writeError(w, r, http.StatusBadRequest, "bad_request", "INVALID_WORKSPACE_ID", "workspaceId must be a UUID")
		return nil, "", false
	}
	return ctx, id, true
}

func (s *Server) workspacePlacementContext(w http.ResponseWriter, r *http.Request) (context.Context, bool) {
	principal, ok := principalFromContext(r.Context())
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "AUTH_REQUIRED", "valid AO access token required")
		return nil, false
	}
	orgID := strings.TrimSpace(chi.URLParam(r, "orgId"))
	if uuid.Validate(orgID) != nil {
		writeError(w, r, http.StatusBadRequest, "bad_request", "INVALID_ORG_ID", "orgId must be a UUID")
		return nil, false
	}
	memberships, err := s.store.ListMemberships(r.Context(), principal)
	if err != nil {
		s.internalError(w, r, "list memberships for workspace placement", err)
		return nil, false
	}
	for _, membership := range memberships {
		if membership.OrgID != orgID {
			continue
		}
		identity := tenant.Identity{OrgID: orgID, OrgSlug: membership.OrgSlug, UserID: principal.UserID, Role: membership.Role}
		if identity.Valid() {
			return tenant.WithIdentity(r.Context(), identity), true
		}
	}
	writeError(w, r, http.StatusForbidden, "forbidden", "ORG_FORBIDDEN", "this account is not a member of the requested organization")
	return nil, false
}

func placementIdempotencyKey(w http.ResponseWriter, r *http.Request) (string, bool) {
	key := strings.TrimSpace(r.Header.Get(idempotencyHeader))
	if key == "" || len(key) > 200 {
		writeError(w, r, http.StatusBadRequest, "bad_request", "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must contain between 1 and 200 characters")
		return "", false
	}
	return key, true
}

func (s *Server) writePlacementError(w http.ResponseWriter, r *http.Request, operation string, err error) {
	switch {
	case errors.Is(err, postgres.ErrNotFound):
		writeError(w, r, http.StatusNotFound, "not_found", "WORKSPACE_NOT_FOUND", "workspace placement not found")
	case errors.Is(err, postgres.ErrConflict):
		writeError(w, r, http.StatusConflict, "conflict", "PLACEMENT_CONFLICT", "workspace placement conflicts with an existing operation")
	case errors.Is(err, postgres.ErrInvalid), errors.Is(err, placement.ErrInvalid):
		writeError(w, r, http.StatusBadRequest, "bad_request", "INVALID_PLACEMENT", "workspace placement request is invalid")
	case errors.Is(err, placement.ErrUnavailable):
		writeError(w, r, http.StatusServiceUnavailable, "unavailable", "PLACEMENT_UNAVAILABLE", "workspace placement is temporarily unavailable")
	default:
		s.internalError(w, r, operation, err)
	}
}

func toWorkspacePlacementResponse(record domain.WorkspacePlacement) workspacePlacementResponse {
	return workspacePlacementResponse{
		ID: record.ID, OrgID: record.OrgID, OwnerUserID: record.OwnerUserID,
		State: string(record.State), ProjectID: record.ProjectID, Message: record.Message,
		CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt,
	}
}
