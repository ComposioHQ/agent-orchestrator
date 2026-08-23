package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

type fakeLinkService struct {
	mu sync.Mutex

	tenants       []tenant.Identity
	installation  domain.SCMInstallation
	repositories  []domain.SCMRepository
	allowlistSent []string
	startErr      error
	completeErr   error
	listErr       error
	unlinkErr     error
}

func (f *fakeLinkService) StartInstall(_ context.Context, tenant tenant.Identity) (scm.InstallRedirect, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tenants = append(f.tenants, tenant)
	if f.startErr != nil {
		return scm.InstallRedirect{}, "", f.startErr
	}
	return scm.InstallRedirect{
		InstallURL: "https://github.com/apps/ao-cloud/installations/new?state=opaque",
		ExpiresAt:  time.Date(2026, 8, 22, 12, 15, 0, 0, time.UTC),
	}, "opaque-state-token", nil
}

func (f *fakeLinkService) CompleteInstall(_ context.Context, _ scm.CallbackParams) (domain.SCMInstallation, error) {
	if f.completeErr != nil {
		return domain.SCMInstallation{}, f.completeErr
	}
	return f.installation, nil
}

func (f *fakeLinkService) ListInstallations(_ context.Context, tenant tenant.Identity) ([]domain.SCMInstallation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tenants = append(f.tenants, tenant)
	if f.listErr != nil {
		return nil, f.listErr
	}
	return []domain.SCMInstallation{f.installation}, nil
}

func (f *fakeLinkService) ListRepositories(_ context.Context, tenant tenant.Identity, _ string) ([]domain.SCMRepository, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tenants = append(f.tenants, tenant)
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.repositories, nil
}

func (f *fakeLinkService) SyncInstallation(_ context.Context, tenant tenant.Identity, _ string) ([]domain.SCMRepository, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tenants = append(f.tenants, tenant)
	return f.repositories, nil
}

func (f *fakeLinkService) SetAllowlist(
	_ context.Context,
	tenant tenant.Identity,
	_ string,
	repositoryFullNames []string,
) ([]domain.SCMRepository, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tenants = append(f.tenants, tenant)
	f.allowlistSent = repositoryFullNames
	return f.repositories, nil
}

func (f *fakeLinkService) Unlink(_ context.Context, tenant tenant.Identity, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tenants = append(f.tenants, tenant)
	return f.unlinkErr
}

type fakeWebhookProcessor struct {
	result scm.WebhookResult
	err    error
}

func (f *fakeWebhookProcessor) Process(
	_ context.Context,
	_, _, signature string,
	body []byte,
) (scm.WebhookResult, error) {
	if f.err != nil {
		return scm.WebhookResult{}, f.err
	}
	if err := scm.VerifyWebhookSignature([]byte("handler-secret"), body, signature); err != nil {
		return scm.WebhookResult{}, err
	}
	return f.result, nil
}

func newSCMServer(t *testing.T, options SCMOptions) (*Server, string) {
	t.Helper()
	store := &memoryAccountStore{
		principal: domain.Principal{
			UserID:      "user-1",
			Provider:    "google",
			ExternalID:  "google-1",
			Email:       "person@example.com",
			DisplayName: "Person",
		},
		memberships: []domain.Membership{{OrgID: "org-1", OrgSlug: "acme", Role: "owner"}},
		refreshes:   map[string]string{},
	}
	tokens, err := auth.NewAccessTokenManager(
		[]byte("0123456789abcdef0123456789abcdef"),
		"ao-cloud-test",
		"ao-desktop-test",
		15*time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Options{
		Store:           store,
		Google:          &staticIdentityVerifier{},
		AccessTokens:    tokens,
		RefreshTokenTTL: time.Hour,
		AllowedEmails:   []string{"person@example.com"},
		SCM:             options,
	})
	if err != nil {
		t.Fatal(err)
	}
	accessToken, _, err := tokens.Issue("user-1")
	if err != nil {
		t.Fatal(err)
	}
	return server, accessToken
}

func TestSCMRoutesAreAbsentWithoutAGitHubApp(t *testing.T) {
	server, accessToken := newSCMServer(t, SCMOptions{})
	response := doSCMRequest(t, server, http.MethodGet, "/api/cloud/v1/orgs/org-1/github/installations", accessToken, nil)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestSCMRoutesRequireAuthentication(t *testing.T) {
	link := &fakeLinkService{}
	server, _ := newSCMServer(t, SCMOptions{Link: link})
	for _, target := range []string{
		"/api/cloud/v1/orgs/org-1/github/installations",
		"/api/cloud/v1/orgs/org-1/github/installations/installation-1/repositories",
	} {
		response := doSCMRequest(t, server, http.MethodGet, target, "", nil)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d", target, response.Code)
		}
	}
}

func TestStartInstallRejectsOrganizationOutsidePrincipalMembership(t *testing.T) {
	link := &fakeLinkService{}
	server, accessToken := newSCMServer(t, SCMOptions{Link: link})
	response := doSCMRequest(t, server, http.MethodPost, "/api/cloud/v1/orgs/org-2/github/installations/start", accessToken, nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	var envelope errorEnvelope
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Code != "ORG_FORBIDDEN" {
		t.Fatalf("code = %q", envelope.Code)
	}
}

func TestSCMAdminPathCannotBeOverriddenByTenantHeader(t *testing.T) {
	link := &fakeLinkService{}
	server, accessToken := newSCMServer(t, SCMOptions{Link: link})
	request := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/orgs/org-2/github/installations/start", nil)
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set(orgHeader, "org-1")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || errorCode(t, response) != "ORG_FORBIDDEN" {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	if len(link.tenants) != 0 {
		t.Fatal("header-selected tenant reached the SCM service")
	}
}

func TestSCMManagementRequiresOrgAdministrator(t *testing.T) {
	link := &fakeLinkService{}
	server, accessToken := newSCMServer(t, SCMOptions{Link: link})
	server.store.(*memoryAccountStore).memberships[0].Role = "member"
	for _, request := range []struct{ method, path string }{
		{http.MethodPost, "/api/cloud/v1/orgs/org-1/github/installations/start"},
		{http.MethodGet, "/api/cloud/v1/orgs/org-1/github/installations"},
	} {
		response := doSCMRequest(t, server, request.method, request.path, accessToken, nil)
		if response.Code != http.StatusForbidden || errorCode(t, response) != "ORG_ADMIN_REQUIRED" {
			t.Fatalf("%s %s status = %d body = %s", request.method, request.path, response.Code, response.Body.String())
		}
	}
	if len(link.tenants) != 0 {
		t.Fatal("non-admin principal reached the SCM management service")
	}
}

func TestStartInstallReturnsRedirectWithoutLeakingTheState(t *testing.T) {
	link := &fakeLinkService{}
	server, accessToken := newSCMServer(t, SCMOptions{Link: link})
	response := doSCMRequest(
		t, server, http.MethodPost, "/api/cloud/v1/orgs/org-1/github/installations/start", accessToken, nil,
	)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	// The raw state travels only inside the install URL GitHub echoes back.
	// It must never appear as a separate, copyable response field.
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if _, present := payload["state"]; present {
		t.Fatalf("response exposed the install state: %s", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "opaque-state-token") {
		t.Fatalf("response leaked the state token: %s", response.Body.String())
	}
	if link.tenants[0] != (tenant.Identity{OrgID: "org-1", OrgSlug: "acme", UserID: "user-1", Role: "owner"}) {
		t.Fatalf("tenant = %#v", link.tenants[0])
	}
}

func TestListInstallationsOmitsTheExternalInstallationID(t *testing.T) {
	link := &fakeLinkService{installation: domain.SCMInstallation{
		ID:                     "installation-1",
		OrgID:                  "org-1",
		Provider:               "github",
		ExternalInstallationID: 987654,
		AccountLogin:           "acme",
		AccountType:            "Organization",
		Status:                 domain.InstallationStatusActive,
	}}
	server, accessToken := newSCMServer(t, SCMOptions{Link: link})
	response := doSCMRequest(t, server, http.MethodGet, "/api/cloud/v1/orgs/org-1/github/installations", accessToken, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if strings.Contains(response.Body.String(), "987654") {
		t.Fatalf("response exposed the external installation id: %s", response.Body.String())
	}
}

func TestSetAllowlistPassesRepositoriesThrough(t *testing.T) {
	link := &fakeLinkService{repositories: []domain.SCMRepository{
		{ID: "repository-1", FullName: "acme/widgets", Allowed: true, Private: true},
		{ID: "repository-2", FullName: "acme/docs"},
	}}
	server, accessToken := newSCMServer(t, SCMOptions{Link: link})
	response := doSCMRequest(
		t, server, http.MethodPut,
		"/api/cloud/v1/orgs/org-1/github/installations/installation-1/allowlist",
		accessToken,
		[]byte(`{"repositories":["acme/widgets"]}`),
	)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	if len(link.allowlistSent) != 1 || link.allowlistSent[0] != "acme/widgets" {
		t.Fatalf("allowlist = %#v", link.allowlistSent)
	}
	var payload scmRepositoryListResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Repositories) != 2 || !payload.Repositories[0].Allowed || payload.Repositories[1].Allowed {
		t.Fatalf("repositories = %#v", payload.Repositories)
	}
}

func TestCanonicalSyncAndDisconnectRoutes(t *testing.T) {
	link := &fakeLinkService{}
	server, accessToken := newSCMServer(t, SCMOptions{Link: link})
	base := "/api/cloud/v1/orgs/org-1/github/installations/installation-1"
	if response := doSCMRequest(t, server, http.MethodPost, base+"/sync", accessToken, nil); response.Code != http.StatusOK {
		t.Fatalf("sync status = %d body = %s", response.Code, response.Body.String())
	}
	if response := doSCMRequest(t, server, http.MethodDelete, base+"/disconnect", accessToken, nil); response.Code != http.StatusNoContent {
		t.Fatalf("disconnect status = %d body = %s", response.Code, response.Body.String())
	}
	for _, legacy := range []struct{ method, path string }{
		{http.MethodPost, base + "/repositories/sync"},
		{http.MethodDelete, base},
	} {
		if response := doSCMRequest(t, server, legacy.method, legacy.path, accessToken, nil); response.Code != http.StatusNotFound {
			t.Fatalf("legacy %s %s status = %d", legacy.method, legacy.path, response.Code)
		}
	}
}

func TestSCMErrorEnvelopesAreStableAndNonRevealing(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{name: "expired state", err: scm.ErrInvalidState, wantStatus: http.StatusBadRequest, wantCode: "SCM_INSTALL_STATE_INVALID"},
		{name: "not the user's installation", err: scm.ErrInstallationNotOwned, wantStatus: http.StatusForbidden, wantCode: "SCM_INSTALLATION_NOT_ACCESSIBLE"},
		{name: "already linked", err: scm.ErrInstallationClaimed, wantStatus: http.StatusConflict, wantCode: "SCM_INSTALLATION_ALREADY_LINKED"},
		{name: "unknown installation", err: scm.ErrInstallationNotFound, wantStatus: http.StatusNotFound, wantCode: "SCM_INSTALLATION_NOT_FOUND"},
		{name: "provider rejected", err: scm.ErrProviderRejected, wantStatus: http.StatusBadGateway, wantCode: "SCM_PROVIDER_REJECTED"},
		{name: "unexpected", err: errors.New("pq: duplicate key value violates unique constraint \"ao_scm_installations_provider_external_installation_id_key\""), wantStatus: http.StatusInternalServerError, wantCode: "INTERNAL_ERROR"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			link := &fakeLinkService{completeErr: testCase.err}
			server, _ := newSCMServer(t, SCMOptions{Link: link})
			response := doSCMRequest(
				t, server, http.MethodGet,
				"/api/cloud/v1/github/installations/callback?state=abc&installation_id=55", "", nil,
			)
			if response.Code != testCase.wantStatus {
				t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
			}
			var envelope errorEnvelope
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			if envelope.Code != testCase.wantCode || envelope.RequestID == "" {
				t.Fatalf("envelope = %#v", envelope)
			}
			// Constraint names and provider text are diagnostics, not client
			// data: the envelope must never carry them.
			if strings.Contains(response.Body.String(), "ao_scm_installations") {
				t.Fatalf("envelope leaked internals: %s", response.Body.String())
			}
		})
	}
}

func TestInstallCallbackRedirectsToTheCompletionURL(t *testing.T) {
	link := &fakeLinkService{installation: domain.SCMInstallation{ID: "installation-1", OrgID: "org-1"}}
	server, _ := newSCMServer(t, SCMOptions{
		Link:                 link,
		InstallCompletionURL: "https://app.example.test/settings/scm?tab=github",
	})
	response := doSCMRequest(t, server, http.MethodGet, "/api/cloud/v1/github/installations/callback?state=abc&installation_id=55", "", nil)
	if response.Code != http.StatusFound {
		t.Fatalf("status = %d", response.Code)
	}
	location := response.Header().Get("Location")
	if !strings.Contains(location, "tab=github") || !strings.Contains(location, "installation=installation-1") {
		t.Fatalf("location = %s", location)
	}

	link.completeErr = scm.ErrInvalidState
	failed := doSCMRequest(t, server, http.MethodGet, "/api/cloud/v1/github/installations/callback?state=abc&installation_id=55", "", nil)
	if failed.Code != http.StatusFound {
		t.Fatalf("status = %d", failed.Code)
	}
	if !strings.Contains(failed.Header().Get("Location"), "error=SCM_INSTALL_STATE_INVALID") {
		t.Fatalf("location = %s", failed.Header().Get("Location"))
	}
}

func TestWebhookEndpointRequiresAValidSignature(t *testing.T) {
	processor := &fakeWebhookProcessor{result: scm.WebhookResult{Event: "pull_request"}}
	server, _ := newSCMServer(t, SCMOptions{Link: &fakeLinkService{}, Webhook: processor})
	body := []byte(`{"action":"opened"}`)

	request := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/github/webhook", bytes.NewReader(body))
	request.Header.Set(scm.EventHeader, "pull_request")
	request.Header.Set(scm.DeliveryHeader, "delivery-1")
	request.Header.Set(scm.SignatureHeader, "sha256=00")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	var envelope errorEnvelope
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Code != "WEBHOOK_SIGNATURE_INVALID" {
		t.Fatalf("code = %q", envelope.Code)
	}
	// The rejected body must not be echoed back to the sender.
	if strings.Contains(response.Body.String(), "opened") {
		t.Fatalf("envelope echoed the rejected payload: %s", response.Body.String())
	}
}

func TestWebhookEndpointAcceptsAndDeduplicates(t *testing.T) {
	processor := &fakeWebhookProcessor{result: scm.WebhookResult{Event: "pull_request"}}
	server, _ := newSCMServer(t, SCMOptions{Link: &fakeLinkService{}, Webhook: processor})
	body := []byte(`{"action":"opened"}`)
	mac := hmac.New(sha256.New, []byte("handler-secret"))
	mac.Write(body)
	signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	send := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/github/webhook", bytes.NewReader(body))
		request.Header.Set(scm.EventHeader, "pull_request")
		request.Header.Set(scm.DeliveryHeader, "delivery-1")
		request.Header.Set(scm.SignatureHeader, signature)
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		return response
	}

	if response := send(); response.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	processor.result.Duplicate = true
	response := send()
	// A redelivery must be a success so GitHub stops retrying.
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), "duplicate") {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
}

func TestWebhookEndpointReturnsAcceptedForInternalFailure(t *testing.T) {
	processor := &fakeWebhookProcessor{err: errors.New("database unavailable")}
	server, _ := newSCMServer(t, SCMOptions{Link: &fakeLinkService{}, Webhook: processor})
	body := []byte(`{"action":"opened"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/github/webhook", bytes.NewReader(body))
	request.Header.Set(scm.EventHeader, "pull_request")
	request.Header.Set(scm.DeliveryHeader, "delivery-1")
	request.Header.Set(scm.SignatureHeader, "sha256=validity-is-checked-by-the-processor")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), "accepted") {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
}

func TestWebhookEndpointIsAbsentWithoutASecret(t *testing.T) {
	server, _ := newSCMServer(t, SCMOptions{Link: &fakeLinkService{}})
	request := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/github/webhook", strings.NewReader("{}"))
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d", response.Code)
	}
}

func doSCMRequest(t *testing.T, server *Server, method, target, accessToken string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	} else {
		reader = bytes.NewReader(nil)
	}
	request := httptest.NewRequest(method, target, reader)
	if accessToken != "" {
		request.Header.Set("Authorization", "Bearer "+accessToken)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	return response
}
