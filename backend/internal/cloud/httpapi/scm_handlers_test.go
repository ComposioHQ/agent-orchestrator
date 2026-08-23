package httpapi

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

type stubWebhookProcessor struct {
	result scm.WebhookResult
	err    error
	calls  int
}

func (p *stubWebhookProcessor) Process(context.Context, string, string, string, []byte) (scm.WebhookResult, error) {
	p.calls++
	return p.result, p.err
}

type stubLinkService struct {
	identity tenant.Identity
	start    scm.InstallRedirect
}

func (s *stubLinkService) StartInstall(_ context.Context, identity tenant.Identity) (scm.InstallRedirect, error) {
	s.identity = identity
	return s.start, nil
}

func (s *stubLinkService) CompleteInstall(_ context.Context, params scm.CallbackParams) (domain.SCMInstallation, error) {
	if params.State == "single-use-state" && params.ExternalInstallationID == 42 {
		return domain.SCMInstallation{ID: "installation-42"}, nil
	}
	return domain.SCMInstallation{}, scm.ErrInvalidState
}

func newSCMRouteServer(t *testing.T, link SCMLinkService, webhook SCMWebhookProcessor) (*Server, string) {
	t.Helper()
	principal := domain.Principal{UserID: "user-1", ExternalID: "google-1", Email: "person@example.com"}
	store := &memoryAccountStore{principal: principal, memberships: []domain.Membership{{
		OrgID: "org-1", OrgSlug: "org-one", Role: "owner",
	}}, refreshes: make(map[string]string)}
	tokens, err := auth.NewAccessTokenManager([]byte("0123456789abcdef0123456789abcdef"), "ao-cloud-test", "ao-desktop-test", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := tokens.Issue(principal.UserID)
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Options{
		Store: store, Google: &staticIdentityVerifier{principal: principal},
		AllowedEmails: []string{principal.Email}, AccessTokens: tokens, RefreshTokenTTL: time.Hour,
		SCM: SCMOptions{Link: link, Webhook: webhook},
	})
	if err != nil {
		t.Fatal(err)
	}
	return server, token
}

func TestSCMWebhookRouteAcknowledgementBoundary(t *testing.T) {
	cases := []struct {
		name       string
		processor  *stubWebhookProcessor
		body       []byte
		wantStatus int
	}{
		{name: "invalid hmac is not stored", processor: &stubWebhookProcessor{err: scm.ErrInvalidSignature}, body: []byte(`{}`), wantStatus: http.StatusUnauthorized},
		{name: "pre durable failure retries", processor: &stubWebhookProcessor{err: scm.ErrWebhookReceiptUnavailable}, body: []byte(`{}`), wantStatus: http.StatusServiceUnavailable},
		{name: "malformed is durably terminal", processor: &stubWebhookProcessor{result: scm.WebhookResult{Durable: true, Terminal: true}}, body: []byte(`{"broken"`), wantStatus: http.StatusAccepted},
		{name: "post durable failure is accepted", processor: &stubWebhookProcessor{result: scm.WebhookResult{Durable: true}, err: errors.New("finish unavailable")}, body: []byte(`{}`), wantStatus: http.StatusAccepted},
		{name: "oversize is rejected before processor", processor: &stubWebhookProcessor{}, body: bytes.Repeat([]byte("x"), scm.MaxWebhookBodyBytes+1), wantStatus: http.StatusRequestEntityTooLarge},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server, _ := newSCMRouteServer(t, nil, testCase.processor)
			request := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/github/webhook", bytes.NewReader(testCase.body))
			response := httptest.NewRecorder()
			server.Handler().ServeHTTP(response, request)
			if response.Code != testCase.wantStatus {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			if testCase.wantStatus == http.StatusRequestEntityTooLarge && testCase.processor.calls != 0 {
				t.Fatal("oversize payload reached processor")
			}
		})
	}
}

func TestCanonicalSCMInstallRoutes(t *testing.T) {
	link := &stubLinkService{start: scm.InstallRedirect{InstallURL: "https://github.test/apps/ao/installations/new", ExpiresAt: time.Now().Add(time.Minute)}}
	server, token := newSCMRouteServer(t, link, nil)

	start := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/orgs/org-1/github/installations/start", nil)
	start.Header.Set("Authorization", "Bearer "+token)
	startResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(startResponse, start)
	if startResponse.Code != http.StatusCreated || link.identity.OrgID != "org-1" || link.identity.UserID != "user-1" {
		t.Fatalf("start status = %d, identity = %#v, body = %s", startResponse.Code, link.identity, startResponse.Body.String())
	}

	callback := httptest.NewRequest(http.MethodGet, "/api/cloud/v1/github/installations/callback?state=single-use-state&installation_id=42", nil)
	callbackResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(callbackResponse, callback)
	if callbackResponse.Code != http.StatusOK {
		t.Fatalf("callback status = %d, body = %s", callbackResponse.Code, callbackResponse.Body.String())
	}
}
