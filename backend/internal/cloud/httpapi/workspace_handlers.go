package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

var gitRefPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`)

type createWorkspaceRequest struct {
	RepositoryURL string `json:"repositoryUrl"`
	RepositoryRef string `json:"repositoryRef,omitempty"`
}

type workspaceResponse struct {
	Workspace  domain.Workspace `json:"workspace"`
	PreviewURL string           `json:"previewUrl,omitempty"`
}

func (s *Server) createWorkspace(w http.ResponseWriter, r *http.Request) {
	if s.workspaces == nil {
		writeError(w, r, http.StatusServiceUnavailable, "unavailable", "CLOUD_RUNTIME_UNAVAILABLE", "cloud runtime is not configured")
		return
	}
	principal, ok := principalFromContext(r.Context())
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "AUTH_REQUIRED", "valid AO access token required")
		return
	}
	var input createWorkspaceRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	input.RepositoryURL = strings.TrimSpace(input.RepositoryURL)
	input.RepositoryRef = strings.TrimSpace(input.RepositoryRef)
	if !validGitHubRepository(input.RepositoryURL) {
		writeError(w, r, http.StatusBadRequest, "bad_request", "INVALID_REPOSITORY_URL", "repositoryUrl must be an HTTPS GitHub repository URL")
		return
	}
	if input.RepositoryRef != "" && !gitRefPattern.MatchString(input.RepositoryRef) {
		writeError(w, r, http.StatusBadRequest, "bad_request", "INVALID_REPOSITORY_REF", "repositoryRef is invalid")
		return
	}
	workspace, err := s.workspaceStore.CreateWorkspace(r.Context(), principal, chi.URLParam(r, "orgID"), input.RepositoryURL, input.RepositoryRef)
	if err != nil {
		if errors.Is(err, postgres.ErrInvalid) || errors.Is(err, postgres.ErrNotFound) {
			writeError(w, r, http.StatusForbidden, "forbidden", "ORG_ACCESS_REQUIRED", "active organization membership required")
			return
		}
		s.internalError(w, r, "create cloud workspace", err)
		return
	}
	go s.provisionWorkspace(context.WithoutCancel(r.Context()), workspace)
	writeJSON(w, http.StatusAccepted, workspaceResponse{Workspace: workspace})
}

func (s *Server) getWorkspace(w http.ResponseWriter, r *http.Request) {
	if s.workspaces == nil || s.workspaceStore == nil {
		writeError(w, r, http.StatusServiceUnavailable, "unavailable", "CLOUD_RUNTIME_UNAVAILABLE", "cloud runtime is not configured")
		return
	}
	principal, ok := principalFromContext(r.Context())
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "AUTH_REQUIRED", "valid AO access token required")
		return
	}
	workspace, err := s.workspaceStore.Workspace(r.Context(), principal, chi.URLParam(r, "orgID"), chi.URLParam(r, "workspaceID"))
	if err != nil {
		if errors.Is(err, postgres.ErrNotFound) {
			writeError(w, r, http.StatusNotFound, "not_found", "WORKSPACE_NOT_FOUND", "cloud workspace not found")
			return
		}
		s.internalError(w, r, "get cloud workspace", err)
		return
	}
	response := workspaceResponse{Workspace: workspace}
	if workspace.State == domain.WorkspaceReady && s.workspaces != nil {
		response.PreviewURL, err = s.workspaces.PreviewURL(r.Context(), workspace.SandboxID)
		if err != nil {
			s.internalError(w, r, "create cloud workspace preview", err)
			return
		}
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) provisionWorkspace(parent context.Context, workspace domain.Workspace) {
	ctx, cancel := context.WithTimeout(parent, 20*time.Minute)
	defer cancel()
	if err := s.workspaceStore.UpdateWorkspaceProvisioning(ctx, workspace, domain.WorkspaceProvisioning, "", ""); err != nil {
		s.logger.Error("mark Cloud workspace provisioning", "workspace_id", workspace.ID, "error", err)
		return
	}
	sandboxID, err := s.workspaces.Provision(ctx, workspace)
	if err != nil {
		failure := "sandbox provisioning failed"
		if updateErr := s.workspaceStore.UpdateWorkspaceProvisioning(ctx, workspace, domain.WorkspaceFailed, sandboxID, failure); updateErr != nil {
			s.logger.Error("mark Cloud workspace failed", "workspace_id", workspace.ID, "error", updateErr)
		}
		s.logger.Error("provision Cloud workspace", "workspace_id", workspace.ID, "sandbox_id", sandboxID, "error", err)
		return
	}
	if err := s.workspaceStore.UpdateWorkspaceProvisioning(ctx, workspace, domain.WorkspaceReady, sandboxID, ""); err != nil {
		s.logger.Error("mark Cloud workspace ready", "workspace_id", workspace.ID, "sandbox_id", sandboxID, "error", err)
	}
}

func validGitHubRepository(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Hostname(), "github.com") || parsed.User != nil {
		return false
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	return len(parts) == 2 && parts[0] != "" && strings.TrimSuffix(parts[1], ".git") != ""
}
