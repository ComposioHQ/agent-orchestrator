package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

var gitRefPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`)

type createWorkspaceRequest struct {
	RepositoryURL           string `json:"repositoryUrl"`
	RepositoryRef           string `json:"repositoryRef,omitempty"`
	ClaudeCredentialsBase64 string `json:"claudeCredentialsBase64"`
}

type workspaceResponse struct {
	Workspace  domain.Workspace `json:"workspace"`
	PreviewURL string           `json:"previewUrl,omitempty"`
}

type workspaceListResponse struct {
	Workspaces []domain.Workspace `json:"workspaces"`
}

func (s *Server) listWorkspaces(w http.ResponseWriter, r *http.Request) {
	if s.workspaceStore == nil {
		writeError(w, r, http.StatusServiceUnavailable, "unavailable", "CLOUD_RUNTIME_UNAVAILABLE", "cloud runtime is not configured")
		return
	}
	principal, ok := principalFromContext(r.Context())
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "AUTH_REQUIRED", "valid AO access token required")
		return
	}
	orgID, ok := validOrgID(w, r)
	if !ok {
		return
	}
	workspaces, err := s.workspaceStore.ListWorkspaces(r.Context(), principal, orgID)
	if err != nil {
		s.internalError(w, r, "list cloud workspaces", err)
		return
	}
	writeJSON(w, http.StatusOK, workspaceListResponse{Workspaces: workspaces})
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
	orgID, ok := validOrgID(w, r)
	if !ok {
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
	claudeCredentials, err := base64.StdEncoding.DecodeString(input.ClaudeCredentialsBase64)
	input.ClaudeCredentialsBase64 = ""
	if err != nil || len(claudeCredentials) == 0 || len(claudeCredentials) > 256<<10 || !validJSONObject(claudeCredentials) {
		writeError(w, r, http.StatusBadRequest, "bad_request", "INVALID_CLAUDE_CREDENTIALS", "valid Claude credentials are required")
		return
	}
	workspace, err := s.workspaceStore.CreateWorkspace(r.Context(), principal, orgID, input.RepositoryURL, input.RepositoryRef)
	if err != nil {
		clear(claudeCredentials)
		if errors.Is(err, postgres.ErrInvalid) || errors.Is(err, postgres.ErrNotFound) {
			writeError(w, r, http.StatusForbidden, "forbidden", "ORG_ACCESS_REQUIRED", "active organization membership required")
			return
		}
		s.internalError(w, r, "create cloud workspace", err)
		return
	}
	runtimeToken, err := s.accessTokens.IssueWorkspace(principal.UserID, workspace.OrgID, workspace.ID, 24*time.Hour)
	if err != nil {
		clear(claudeCredentials)
		s.internalError(w, r, "issue cloud workspace capability", err)
		return
	}
	provisionCredentials := append([]byte(nil), claudeCredentials...)
	clear(claudeCredentials)
	go s.provisionWorkspace(context.WithoutCancel(r.Context()), workspace, domain.WorkspaceBootstrap{
		ClaudeCredentials: provisionCredentials,
		RuntimeToken:      runtimeToken,
		ControlPlaneURL:   s.publicURL,
	})
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
	orgID, ok := validOrgID(w, r)
	if !ok {
		return
	}
	workspace, err := s.workspaceStore.Workspace(r.Context(), principal, orgID, chi.URLParam(r, "workspaceID"))
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
		runtimeToken, tokenErr := s.accessTokens.IssueWorkspace(principal.UserID, workspace.OrgID, workspace.ID, 24*time.Hour)
		if tokenErr != nil {
			s.internalError(w, r, "issue resumed cloud workspace capability", tokenErr)
			return
		}
		if err = s.workspaces.Resume(r.Context(), workspace, domain.WorkspaceBootstrap{
			RuntimeToken: runtimeToken, ControlPlaneURL: s.publicURL,
		}); err != nil {
			s.internalError(w, r, "resume cloud workspace", err)
			return
		}
		response.PreviewURL, err = s.workspaces.PreviewURL(r.Context(), workspace.SandboxID)
		if err != nil {
			s.internalError(w, r, "create cloud workspace preview", err)
			return
		}
	}
	writeJSON(w, http.StatusOK, response)
}

func validOrgID(w http.ResponseWriter, r *http.Request) (string, bool) {
	orgID := strings.TrimSpace(chi.URLParam(r, "orgID"))
	if uuid.Validate(orgID) != nil {
		writeError(w, r, http.StatusBadRequest, "bad_request", "INVALID_ORG_ID", "orgID must be a UUID")
		return "", false
	}
	return orgID, true
}

func (s *Server) provisionWorkspace(parent context.Context, workspace domain.Workspace, bootstrap domain.WorkspaceBootstrap) {
	defer clear(bootstrap.ClaudeCredentials)
	ctx, cancel := context.WithTimeout(parent, 20*time.Minute)
	defer cancel()
	if err := s.workspaceStore.UpdateWorkspaceProvisioning(ctx, workspace, domain.WorkspaceProvisioning, "", ""); err != nil {
		s.logger.Error("mark Cloud workspace provisioning", "workspace_id", workspace.ID, "error", err)
		return
	}
	sandboxID, err := s.workspaces.Provision(ctx, workspace, bootstrap)
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

func validJSONObject(value []byte) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(value, &object) != nil || object == nil {
		return false
	}
	var oauth map[string]json.RawMessage
	return json.Unmarshal(object["claudeAiOauth"], &oauth) == nil && oauth != nil
}

func validGitHubRepository(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Hostname(), "github.com") || parsed.User != nil {
		return false
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	return len(parts) == 2 && parts[0] != "" && strings.TrimSuffix(parts[1], ".git") != ""
}
