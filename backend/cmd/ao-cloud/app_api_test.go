package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	cloudconfig "github.com/aoagents/agent-orchestrator/backend/internal/cloud/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

type fakeHostedAppStore struct {
	hostedAppStore
	projects []domain.ProjectRecord
	sessions []domain.SessionRecord
	scopes   []tenant.Identity
}

func (s *fakeHostedAppStore) recordScope(ctx context.Context) {
	id, _ := tenant.FromContext(ctx)
	s.scopes = append(s.scopes, id)
}

func (s *fakeHostedAppStore) ListProjects(ctx context.Context) ([]domain.ProjectRecord, error) {
	s.recordScope(ctx)
	return s.projects, nil
}

func (s *fakeHostedAppStore) GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error) {
	s.recordScope(ctx)
	for _, project := range s.projects {
		if project.ID == id {
			return project, true, nil
		}
	}
	return domain.ProjectRecord{}, false, nil
}

func (s *fakeHostedAppStore) ListWorkspaceRepos(context.Context, string) ([]domain.WorkspaceRepoRecord, error) {
	return []domain.WorkspaceRepoRecord{}, nil
}

func (s *fakeHostedAppStore) ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error) {
	s.recordScope(ctx)
	return s.sessions, nil
}

func (s *fakeHostedAppStore) ListSessions(ctx context.Context, projectID domain.ProjectID) ([]domain.SessionRecord, error) {
	s.recordScope(ctx)
	out := make([]domain.SessionRecord, 0)
	for _, session := range s.sessions {
		if session.ProjectID == projectID {
			out = append(out, session)
		}
	}
	return out, nil
}

func (s *fakeHostedAppStore) GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	s.recordScope(ctx)
	for _, session := range s.sessions {
		if session.ID == id {
			return session, true, nil
		}
	}
	return domain.SessionRecord{}, false, nil
}

func TestHostedAppAPIComposesTenantScopedProjectAndSessionReads(t *testing.T) {
	now := time.Now().UTC()
	store := &fakeHostedAppStore{
		projects: []domain.ProjectRecord{{
			ID: "cloud-app", Path: "/opaque/sandbox/cloud-app", DisplayName: "Cloud App",
			RepoOriginURL: "https://github.com/acme/cloud-app.git", Kind: domain.ProjectKindSingleRepo,
			Config: domain.ProjectConfig{DefaultBranch: "main"}, RegisteredAt: now,
		}},
		sessions: []domain.SessionRecord{{
			ID: "cloud-app-1", ProjectID: "cloud-app", Kind: domain.KindWorker,
			Harness: domain.HarnessCodex, CreatedAt: now, UpdatedAt: now,
		}},
	}
	handler := buildAppAPI(cloudconfig.Config{AppAPIEnabled: true}, slog.New(slog.NewTextHandler(io.Discard, nil)), store)

	for _, test := range []struct {
		path       string
		wantStatus int
		want       string
	}{
		{path: "/api/v1/projects", wantStatus: http.StatusOK, want: `"id":"cloud-app"`},
		{path: "/api/v1/projects/cloud-app", wantStatus: http.StatusOK, want: `"defaultBranch":"main"`},
		{path: "/api/v1/sessions", wantStatus: http.StatusOK, want: `"id":"cloud-app-1"`},
		{path: "/api/v1/sessions/cloud-app-1", wantStatus: http.StatusOK, want: `"projectId":"cloud-app"`},
	} {
		t.Run(test.path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, test.path, nil)
			req = req.WithContext(tenant.WithIdentity(req.Context(), tenant.Identity{OrgID: "org-1", UserID: "user-1"}))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), test.want) {
				t.Fatalf("body %s does not contain %s", response.Body.String(), test.want)
			}
		})
	}
	for _, scope := range store.scopes {
		if scope.OrgID != "org-1" || scope.UserID != "user-1" {
			t.Fatalf("store scope = %+v", scope)
		}
	}
}

func TestHostedAppAPISessionSpawnFailsClosedWithoutCompute(t *testing.T) {
	store := &fakeHostedAppStore{projects: []domain.ProjectRecord{{ID: "cloud-app", Config: domain.ProjectConfig{DefaultBranch: "main"}}}}
	handler := buildAppAPI(cloudconfig.Config{AppAPIEnabled: true}, slog.New(slog.NewTextHandler(io.Discard, nil)), store)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions", strings.NewReader(`{"projectId":"cloud-app","kind":"worker","harness":"codex","prompt":"test"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(tenant.WithIdentity(req.Context(), tenant.Identity{OrgID: "org-1", UserID: "user-1"}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "HOSTED_SESSION_EXECUTION_UNAVAILABLE" {
		t.Fatalf("code = %q", body.Code)
	}
}

func TestHostedProjectDetailDoesNotProbeOpaqueWorkspace(t *testing.T) {
	store := &fakeHostedAppStore{projects: []domain.ProjectRecord{{
		ID: "cloud-app", Path: "/opaque/path/that/is/not/on/the/control-plane",
		Kind: domain.ProjectKindSingleRepo,
	}}}
	result, err := newHostedProjectManager(store).Get(context.Background(), "cloud-app")
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "degraded" || result.Degraded == nil || !strings.Contains(result.Degraded.ResolveError, "hosted project metadata") {
		t.Fatalf("result = %#v", result)
	}
}
