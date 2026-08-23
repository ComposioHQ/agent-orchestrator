package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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
	identity      tenant.Identity
	start         scm.InstallRedirect
	installations []domain.SCMInstallation
	repositories  []domain.SCMRepository
	allowlist     []string
	disconnected  string
}

func (s *stubLinkService) ListInstallations(_ context.Context, identity tenant.Identity) ([]domain.SCMInstallation, error) {
	s.identity = identity
	return s.installations, nil
}

func (s *stubLinkService) ListRepositories(_ context.Context, identity tenant.Identity, _ string) ([]domain.SCMRepository, error) {
	s.identity = identity
	return s.repositories, nil
}

func (s *stubLinkService) SyncInstallation(_ context.Context, identity tenant.Identity, _ string) ([]domain.SCMRepository, error) {
	s.identity = identity
	return s.repositories, nil
}

func (s *stubLinkService) SetAllowlist(_ context.Context, identity tenant.Identity, _ string, repositories []string) ([]domain.SCMRepository, error) {
	s.identity = identity
	s.allowlist = append([]string(nil), repositories...)
	return s.repositories, nil
}

func (s *stubLinkService) Unlink(_ context.Context, identity tenant.Identity, installationID string) error {
	s.identity = identity
	s.disconnected = installationID
	return nil
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
			request.Header.Set(scm.EventHeader, "pull_request")
			request.Header.Set(scm.DeliveryHeader, "delivery-1")
			request.Header.Set(scm.SignatureHeader, "sha256=signature")
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

func TestSCMWebhookRouteRejectsInvalidHeaderEnvelope(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(http.Header)
	}{
		{name: "duplicate required value", mutate: func(header http.Header) { header.Add(scm.EventHeader, "push") }},
		{name: "noncanonical name", mutate: func(header http.Header) { header["x-extra-header"] = []string{"value"} }},
		{name: "control value", mutate: func(header http.Header) { header.Set("X-Extra-Header", "bad\tvalue") }},
		{name: "oversize value", mutate: func(header http.Header) {
			header.Set("X-Extra-Header", strings.Repeat("x", maxWebhookHeaderValueBytes+1))
		}},
		{name: "too many fields", mutate: func(header http.Header) {
			for index := 0; index <= maxWebhookHeaderFields; index++ {
				header.Set(fmt.Sprintf("X-Test-%03d", index), "value")
			}
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			processor := &stubWebhookProcessor{result: scm.WebhookResult{Durable: true}}
			server, _ := newSCMRouteServer(t, nil, processor)
			request := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/github/webhook", bytes.NewReader([]byte(`{}`)))
			request.Header.Set(scm.EventHeader, "pull_request")
			request.Header.Set(scm.DeliveryHeader, "delivery-1")
			request.Header.Set(scm.SignatureHeader, "sha256=signature")
			testCase.mutate(request.Header)
			response := httptest.NewRecorder()
			server.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest || processor.calls != 0 {
				t.Fatalf("status = %d, calls = %d, body = %s", response.Code, processor.calls, response.Body.String())
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

func TestCanonicalSCMAdminRoutes(t *testing.T) {
	link := &stubLinkService{
		installations: []domain.SCMInstallation{{ID: "installation-42", Provider: "github", ExternalInstallationID: 987, AccountLogin: "acme"}},
		repositories:  []domain.SCMRepository{{ID: "repository-77", FullName: "acme/widgets", Private: true, Allowed: true}},
	}
	server, token := newSCMRouteServer(t, link, nil)
	base := "/api/cloud/v1/orgs/org-1/github/installations"
	requests := []struct {
		method string
		path   string
		body   string
		status int
	}{
		{method: http.MethodGet, path: base, status: http.StatusOK},
		{method: http.MethodGet, path: base + "/installation-42/repositories", status: http.StatusOK},
		{method: http.MethodPost, path: base + "/installation-42/sync", status: http.StatusOK},
		{method: http.MethodPut, path: base + "/installation-42/allowlist", body: `{"repositories":["acme/widgets"]}`, status: http.StatusOK},
		{method: http.MethodDelete, path: base + "/installation-42/disconnect", status: http.StatusNoContent},
	}
	for _, request := range requests {
		httpRequest := httptest.NewRequest(request.method, request.path, strings.NewReader(request.body))
		httpRequest.Header.Set("Authorization", "Bearer "+token)
		if request.body != "" {
			httpRequest.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, httpRequest)
		if response.Code != request.status {
			t.Fatalf("%s %s status=%d body=%s", request.method, request.path, response.Code, response.Body.String())
		}
	}
	if len(link.allowlist) != 1 || link.allowlist[0] != "acme/widgets" || link.disconnected != "installation-42" {
		t.Fatalf("allowlist=%#v disconnected=%q", link.allowlist, link.disconnected)
	}
	listRequest := httptest.NewRequest(http.MethodGet, base, nil)
	listRequest.Header.Set("Authorization", "Bearer "+token)
	listResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(listResponse, listRequest)
	if strings.Contains(listResponse.Body.String(), "987") {
		t.Fatalf("external installation id leaked: %s", listResponse.Body.String())
	}
	for _, legacy := range []struct{ method, path string }{
		{http.MethodDelete, base + "/installation-42"},
		{http.MethodPost, base + "/installation-42/repositories/sync"},
	} {
		request := httptest.NewRequest(legacy.method, legacy.path, nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("legacy %s %s status=%d", legacy.method, legacy.path, response.Code)
		}
	}
}
