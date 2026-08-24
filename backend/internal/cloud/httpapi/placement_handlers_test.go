package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

type placementServiceSpy struct {
	seen   tenant.Identity
	create domain.CreateWorkspacePlacement
	record domain.WorkspacePlacement
}

func (s *placementServiceSpy) capture(ctx context.Context) {
	s.seen, _ = tenant.FromContext(ctx)
}
func (s *placementServiceSpy) Create(ctx context.Context, input domain.CreateWorkspacePlacement) (domain.WorkspacePlacement, error) {
	s.capture(ctx)
	s.create = input
	return s.record, nil
}
func (s *placementServiceSpy) Get(ctx context.Context, _ string) (domain.WorkspacePlacement, error) {
	s.capture(ctx)
	return s.record, nil
}
func (s *placementServiceSpy) List(ctx context.Context, _ string, _ int) (domain.WorkspacePlacementPage, error) {
	s.capture(ctx)
	return domain.WorkspacePlacementPage{Workspaces: []domain.WorkspacePlacement{s.record}}, nil
}
func (s *placementServiceSpy) Delete(ctx context.Context, _, _ string) (domain.WorkspacePlacement, error) {
	s.capture(ctx)
	return s.record, nil
}
func (s *placementServiceSpy) Resume(ctx context.Context, _, _ string) (domain.WorkspacePlacement, error) {
	s.capture(ctx)
	return s.record, nil
}

func TestWorkspacePlacementRoutesAuthenticateScopeAndAcceptCreate(t *testing.T) {
	const orgID = "0d0f7f24-4bd4-4a1a-8d3c-3a02f3d3d001"
	const userID = "58fc7182-0360-412f-abd9-5057097db664"
	principal := domain.Principal{UserID: userID, Email: "person@example.com"}
	accounts := &memoryAccountStore{principal: principal, memberships: []domain.Membership{{OrgID: orgID, OrgSlug: "acme", Role: "member"}}, refreshes: map[string]string{}}
	spy := &placementServiceSpy{record: domain.WorkspacePlacement{
		ID: "6a1f8201-dfc4-45f0-8e0d-81cc14c53a12", OrgID: orgID, OwnerUserID: userID,
		State: domain.WorkspacePlacementPending, CreatedAt: time.Unix(1, 0), UpdatedAt: time.Unix(1, 0),
	}}
	tokens, err := auth.NewAccessTokenManager([]byte("0123456789abcdef0123456789abcdef"), "issuer", "audience", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Options{
		Store: accounts, Google: &staticIdentityVerifier{principal: principal}, AllowedEmails: []string{"person@example.com"},
		AccessTokens: tokens, RefreshTokenTTL: time.Hour, Placement: spy,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := tokens.Issue(userID)
	if err != nil {
		t.Fatal(err)
	}
	body := bytes.NewBufferString(`{"displayName":"App","repositoryUrl":"https://github.com/acme/app.git","defaultBranch":"main","config":{"region":"us"}}`)
	request := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/orgs/"+orgID+"/workspaces", body)
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set(idempotencyHeader, "create-1")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if spy.seen.OrgID != orgID || spy.seen.UserID != userID || spy.seen.Role != "member" {
		t.Fatalf("tenant identity=%#v", spy.seen)
	}
	if spy.create.IdempotencyKey != "create-1" || spy.create.RepositoryURL != "https://github.com/acme/app.git" {
		t.Fatalf("create=%#v", spy.create)
	}
	var result workspacePlacementResponse
	if json.Unmarshal(response.Body.Bytes(), &result) != nil || result.State != "pending" {
		t.Fatalf("response=%s", response.Body.String())
	}
}

func TestWorkspacePlacementCreateRejectsMissingIdempotencyKeyAndCrossTenant(t *testing.T) {
	const orgID = "0d0f7f24-4bd4-4a1a-8d3c-3a02f3d3d001"
	const otherOrgID = "0d0f7f24-4bd4-4a1a-8d3c-3a02f3d3d002"
	const userID = "58fc7182-0360-412f-abd9-5057097db664"
	principal := domain.Principal{UserID: userID, Email: "person@example.com"}
	accounts := &memoryAccountStore{principal: principal, memberships: []domain.Membership{{OrgID: orgID, OrgSlug: "acme", Role: "owner"}}, refreshes: map[string]string{}}
	spy := &placementServiceSpy{}
	tokens, _ := auth.NewAccessTokenManager([]byte("0123456789abcdef0123456789abcdef"), "issuer", "audience", time.Hour)
	server, err := New(Options{Store: accounts, Google: &staticIdentityVerifier{principal: principal}, AllowedEmails: []string{"person@example.com"}, AccessTokens: tokens, RefreshTokenTTL: time.Hour, Placement: spy})
	if err != nil {
		t.Fatal(err)
	}
	token, _, _ := tokens.Issue(userID)
	for name, target := range map[string]struct {
		org    string
		header bool
		status int
	}{
		"missing idempotency key": {orgID, false, http.StatusBadRequest},
		"cross tenant":            {otherOrgID, true, http.StatusForbidden},
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/orgs/"+target.org+"/workspaces", bytes.NewBufferString(`{"repositoryUrl":"https://github.com/acme/app.git"}`))
			request.Header.Set("Authorization", "Bearer "+token)
			if target.header {
				request.Header.Set(idempotencyHeader, "create-1")
			}
			response := httptest.NewRecorder()
			server.Handler().ServeHTTP(response, request)
			if response.Code != target.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, target.status, response.Body.String())
			}
		})
	}
}
