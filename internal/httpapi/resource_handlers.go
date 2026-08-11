package httpapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/go-chi/chi/v5"
)

type createProjectRequest struct {
	DisplayName   string         `json:"displayName"`
	RepositoryURL string         `json:"repositoryUrl"`
	DefaultBranch string         `json:"defaultBranch"`
	Config        map[string]any `json:"config,omitempty"`
}

type projectResponse struct {
	ID            string         `json:"id"`
	OrgID         string         `json:"orgId"`
	DisplayName   string         `json:"displayName"`
	RepositoryURL string         `json:"repositoryUrl"`
	DefaultBranch string         `json:"defaultBranch"`
	Config        map[string]any `json:"config"`
	CreatedAt     time.Time      `json:"createdAt"`
	UpdatedAt     time.Time      `json:"updatedAt"`
}

type createSessionRequest struct {
	ProjectID            string `json:"projectId"`
	Kind                 string `json:"kind"`
	Harness              string `json:"harness"`
	DisplayName          string `json:"displayName"`
	Prompt               string `json:"prompt"`
	ProviderConnectionID string `json:"providerConnectionId,omitempty"`
}

type sessionResponse struct {
	ID               string    `json:"id"`
	OrgID            string    `json:"orgId"`
	ProjectID        string    `json:"projectId"`
	Kind             string    `json:"kind"`
	Harness          string    `json:"harness"`
	DisplayName      string    `json:"displayName"`
	Branch           string    `json:"branch"`
	ActivityState    string    `json:"activityState"`
	Status           string    `json:"status"`
	RuntimeConnected bool      `json:"runtimeConnected"`
	RuntimeState     string    `json:"runtimeState,omitempty"`
	RuntimeError     string    `json:"runtimeError,omitempty"`
	IsTerminated     bool      `json:"isTerminated"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

type pageInfo struct {
	HasMore    bool   `json:"hasMore"`
	NextCursor string `json:"nextCursor,omitempty"`
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	if requireUUID(orgID, "orgId") != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "orgId must be a UUID.")
		return
	}
	key, err := idempotencyKey(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	var request createProjectRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "The request body is invalid.")
		return
	}
	request.DisplayName = strings.TrimSpace(request.DisplayName)
	request.RepositoryURL = strings.TrimSpace(request.RepositoryURL)
	request.DefaultBranch = strings.TrimSpace(request.DefaultBranch)
	if !validProjectInput(request) {
		writeError(w, r, http.StatusUnprocessableEntity, "validation_error", "Project name, repository URL, or default branch is invalid.")
		return
	}
	if request.Config == nil {
		request.Config = map[string]any{}
	}
	config, err := json.Marshal(request.Config)
	if err != nil {
		writeError(w, r, http.StatusUnprocessableEntity, "validation_error", "Project configuration is invalid.")
		return
	}
	project, err := s.store.CreateProject(
		r.Context(),
		principalFrom(r),
		orgID,
		key,
		domain.CreateProject{
			DisplayName:   request.DisplayName,
			RepositoryURL: request.RepositoryURL,
			DefaultBranch: request.DefaultBranch,
			Config:        config,
		},
	)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"project": toProjectResponse(project)})
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	if requireUUID(orgID, "orgId") != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "orgId must be a UUID.")
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
	projects, hasMore, err := s.store.ListProjects(
		r.Context(),
		principalFrom(r),
		orgID,
		cursor,
		limit,
	)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	items := make([]projectResponse, 0, len(projects))
	for _, project := range projects {
		items = append(items, toProjectResponse(project))
	}
	page := pageInfo{HasMore: hasMore}
	if hasMore && len(projects) > 0 {
		last := projects[len(projects)-1]
		page.NextCursor = encodeCursor(last.CreatedAt, last.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "page": page})
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	if requireUUID(orgID, "orgId") != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "orgId must be a UUID.")
		return
	}
	key, err := idempotencyKey(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	var request createSessionRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "The request body is invalid.")
		return
	}
	request.ProjectID = strings.TrimSpace(request.ProjectID)
	request.Harness = strings.TrimSpace(request.Harness)
	request.DisplayName = strings.TrimSpace(request.DisplayName)
	request.ProviderConnectionID = strings.TrimSpace(request.ProviderConnectionID)
	if !validSessionInput(request) {
		writeError(w, r, http.StatusUnprocessableEntity, "validation_error", "Session project, kind, harness, name, or prompt is invalid.")
		return
	}
	session, err := s.store.CreateSession(
		r.Context(),
		principalFrom(r),
		orgID,
		key,
		domain.CreateSession{
			ProjectID:            request.ProjectID,
			Kind:                 request.Kind,
			Harness:              request.Harness,
			DisplayName:          request.DisplayName,
			Prompt:               request.Prompt,
			ProviderConnectionID: request.ProviderConnectionID,
		},
	)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"session": toSessionResponse(session)})
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	if requireUUID(orgID, "orgId") != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "orgId must be a UUID.")
		return
	}
	projectID := strings.TrimSpace(r.URL.Query().Get("projectId"))
	if projectID != "" && requireUUID(projectID, "projectId") != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "projectId must be a UUID.")
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
	sessions, hasMore, err := s.store.ListSessions(
		r.Context(),
		principalFrom(r),
		orgID,
		projectID,
		cursor,
		limit,
	)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	items := make([]sessionResponse, 0, len(sessions))
	for _, session := range sessions {
		items = append(items, toSessionResponse(session))
	}
	page := pageInfo{HasMore: hasMore}
	if hasMore && len(sessions) > 0 {
		last := sessions[len(sessions)-1]
		page.NextCursor = encodeCursor(last.UpdatedAt, last.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "page": page})
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	sessionID := chi.URLParam(r, "sessionId")
	if requireUUID(orgID, "orgId") != nil || requireUUID(sessionID, "sessionId") != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "orgId and sessionId must be UUIDs.")
		return
	}
	session, err := s.store.GetSession(
		r.Context(),
		principalFrom(r),
		orgID,
		sessionID,
	)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": toSessionResponse(session)})
}

func validProjectInput(request createProjectRequest) bool {
	if len(request.DisplayName) < 1 || len(request.DisplayName) > 120 ||
		len(request.DefaultBranch) < 1 || len(request.DefaultBranch) > 255 {
		return false
	}
	parsed, err := url.ParseRequestURI(request.RepositoryURL)
	return err == nil && parsed.Scheme == "https" && parsed.Host != ""
}

func validSessionInput(request createSessionRequest) bool {
	if requireUUID(request.ProjectID, "projectId") != nil ||
		(request.Kind != "worker" && request.Kind != "orchestrator") ||
		len(request.Harness) < 1 || len(request.Harness) > 120 ||
		len(request.DisplayName) < 1 || len(request.DisplayName) > 80 ||
		len(request.Prompt) > 65536 {
		return false
	}
	return request.ProviderConnectionID == "" ||
		requireUUID(request.ProviderConnectionID, "providerConnectionId") == nil
}

func toProjectResponse(project domain.Project) projectResponse {
	config := map[string]any{}
	_ = json.Unmarshal(project.Config, &config)
	return projectResponse{
		ID:            project.ID,
		OrgID:         project.OrgID,
		DisplayName:   project.DisplayName,
		RepositoryURL: project.RepositoryURL,
		DefaultBranch: project.DefaultBranch,
		Config:        config,
		CreatedAt:     project.CreatedAt,
		UpdatedAt:     project.UpdatedAt,
	}
}

func toSessionResponse(session domain.Session) sessionResponse {
	return sessionResponse{
		ID:               session.ID,
		OrgID:            session.OrgID,
		ProjectID:        session.ProjectID,
		Kind:             session.Kind,
		Harness:          session.Harness,
		DisplayName:      session.DisplayName,
		Branch:           session.Branch,
		ActivityState:    string(session.ActivityState),
		Status:           string(session.Status(time.Now().UTC())),
		RuntimeConnected: session.RuntimeConnected,
		RuntimeState:     session.RuntimeState,
		RuntimeError:     session.RuntimeError,
		IsTerminated:     session.IsTerminated,
		CreatedAt:        session.CreatedAt,
		UpdatedAt:        session.UpdatedAt,
	}
}
