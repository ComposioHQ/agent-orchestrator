package scm

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

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

type fakeLinkAPI struct {
	mu sync.Mutex

	scopes        []postgres.SCMTenant
	installation  domain.SCMInstallation
	repositories  []domain.SCMRepository
	allowlistSent []string
	completeErr   error
	listErr       error
	unlinkErr     error
}

func (f *fakeLinkAPI) StartInstall(_ context.Context, scope postgres.SCMTenant) (InstallRedirect, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scopes = append(f.scopes, scope)
	return InstallRedirect{
		InstallURL: "https://github.com/apps/ao-cloud/installations/new?state=opaque",
		ExpiresAt:  time.Date(2026, 8, 22, 12, 15, 0, 0, time.UTC),
	}, "opaque-state-token", nil
}

func (f *fakeLinkAPI) CompleteInstall(_ context.Context, _ CallbackParams) (domain.SCMInstallation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.completeErr != nil {
		return domain.SCMInstallation{}, f.completeErr
	}
	return f.installation, nil
}

func (f *fakeLinkAPI) ListInstallations(_ context.Context, scope postgres.SCMTenant) ([]domain.SCMInstallation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scopes = append(f.scopes, scope)
	if f.listErr != nil {
		return nil, f.listErr
	}
	return []domain.SCMInstallation{f.installation}, nil
}

func (f *fakeLinkAPI) ListRepositories(_ context.Context, scope postgres.SCMTenant, _ string) ([]domain.SCMRepository, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scopes = append(f.scopes, scope)
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.repositories, nil
}

func (f *fakeLinkAPI) SyncInstallation(_ context.Context, scope postgres.SCMTenant, _ string) ([]domain.SCMRepository, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scopes = append(f.scopes, scope)
	return f.repositories, nil
}

func (f *fakeLinkAPI) SetAllowlist(
	_ context.Context,
	scope postgres.SCMTenant,
	_ string,
	repositoryFullNames []string,
) ([]domain.SCMRepository, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scopes = append(f.scopes, scope)
	f.allowlistSent = repositoryFullNames
	return f.repositories, nil
}

func (f *fakeLinkAPI) Unlink(_ context.Context, scope postgres.SCMTenant, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scopes = append(f.scopes, scope)
	return f.unlinkErr
}

type fakeWebhookAPI struct {
	result WebhookResult
	secret []byte
}

func (f *fakeWebhookAPI) Process(_ context.Context, _, _, signature string, body []byte) (WebhookResult, error) {
	if err := VerifyWebhookSignature(f.secret, body, signature); err != nil {
		return WebhookResult{}, err
	}
	return f.result, nil
}

var handlerIdentity = tenant.Identity{OrgID: "org-1", OrgSlug: "acme", UserID: "user-1", Role: "owner"}

// mountTestRouter mounts the SCM routes the way the control plane composition
// does: behind a middleware that resolves the tenant. The stub stands in for
// the real authenticated chain, which this slice deliberately does not own.
func mountTestRouter(t *testing.T, options RoutesOptions, identity *tenant.Identity) chi.Router {
	t.Helper()
	routes, err := NewRoutes(options)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	requireTenant := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if identity == nil {
				writeError(w, r, http.StatusUnauthorized, "unauthorized", "AUTH_REQUIRED", "valid AO access token required")
				return
			}
			next.ServeHTTP(w, r.WithContext(tenant.WithIdentity(r.Context(), *identity)))
		})
	}
	if err := routes.MountRoutes(router, MountDeps{RequireTenant: requireTenant}); err != nil {
		t.Fatal(err)
	}
	return router
}

func doRequest(t *testing.T, router chi.Router, method, target string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	} else {
		reader = bytes.NewReader(nil)
	}
	request := httptest.NewRequest(method, target, reader)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func TestMountRoutesRequiresATenantMiddleware(t *testing.T) {
	routes, err := NewRoutes(RoutesOptions{Link: &fakeLinkAPI{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := routes.MountRoutes(chi.NewRouter(), MountDeps{}); err == nil {
		t.Fatal("routes mounted without a tenant-resolving middleware")
	}
}

func TestNewRoutesRequiresALinkService(t *testing.T) {
	if _, err := NewRoutes(RoutesOptions{}); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("error = %v", err)
	}
}

func TestTenantScopeComesFromTheContextNotTheRequest(t *testing.T) {
	link := &fakeLinkAPI{}
	router := mountTestRouter(t, RoutesOptions{Link: link}, &handlerIdentity)

	// A client naming a different organization in the body must not be able to
	// steer the scope: the field does not exist, so the request is rejected
	// outright by the strict decoder rather than silently ignored.
	response := doRequest(t, router, http.MethodPut,
		installationsPath+"/installation-1/allowlist",
		[]byte(`{"orgId":"org-2","repositories":["acme/widgets"]}`))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}

	response = doRequest(t, router, http.MethodPut,
		installationsPath+"/installation-1/allowlist",
		[]byte(`{"repositories":["acme/widgets"]}`))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	if len(link.scopes) != 1 || link.scopes[0] != (postgres.SCMTenant{OrgID: "org-1", UserID: "user-1"}) {
		t.Fatalf("scope = %#v", link.scopes)
	}
	if len(link.allowlistSent) != 1 || link.allowlistSent[0] != "acme/widgets" {
		t.Fatalf("allowlist = %#v", link.allowlistSent)
	}
}

func TestAuthenticatedRoutesRefuseAnUnresolvedTenant(t *testing.T) {
	router := mountTestRouter(t, RoutesOptions{Link: &fakeLinkAPI{}}, nil)
	for _, target := range []string{
		installationsPath,
		installationsPath + "/installation-1/repositories",
	} {
		response := doRequest(t, router, http.MethodGet, target, nil)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d", target, response.Code)
		}
	}
}

func TestStartInstallDoesNotLeakTheState(t *testing.T) {
	router := mountTestRouter(t, RoutesOptions{Link: &fakeLinkAPI{}}, &handlerIdentity)
	response := doRequest(t, router, http.MethodPost, installationsPath, nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	// The raw state travels only inside the install URL GitHub echoes back. It
	// must never appear as a separate, copyable response field.
	if _, present := payload["state"]; present {
		t.Fatalf("response exposed the install state: %s", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "opaque-state-token") {
		t.Fatalf("response leaked the state token: %s", response.Body.String())
	}
}

func TestListInstallationsOmitsTheExternalInstallationID(t *testing.T) {
	link := &fakeLinkAPI{installation: domain.SCMInstallation{
		ID:                     "installation-1",
		OrgID:                  "org-1",
		Provider:               "github",
		ExternalInstallationID: 987654,
		AccountLogin:           "acme",
		Status:                 domain.InstallationStatusActive,
	}}
	router := mountTestRouter(t, RoutesOptions{Link: link}, &handlerIdentity)
	response := doRequest(t, router, http.MethodGet, installationsPath, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if strings.Contains(response.Body.String(), "987654") {
		t.Fatalf("response exposed the external installation id: %s", response.Body.String())
	}
}

func TestUnlinkAnswersNoContent(t *testing.T) {
	router := mountTestRouter(t, RoutesOptions{Link: &fakeLinkAPI{}}, &handlerIdentity)
	response := doRequest(t, router, http.MethodDelete, installationsPath+"/installation-1", nil)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
}

func TestSCMErrorEnvelopesAreStableAndNonRevealing(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{name: "expired state", err: ErrInvalidState, wantStatus: http.StatusBadRequest, wantCode: "SCM_INSTALL_STATE_INVALID"},
		{name: "not the user's installation", err: ErrInstallationNotOwned, wantStatus: http.StatusForbidden, wantCode: "SCM_INSTALLATION_NOT_ACCESSIBLE"},
		{name: "already linked", err: ErrInstallationClaimed, wantStatus: http.StatusConflict, wantCode: "SCM_INSTALLATION_ALREADY_LINKED"},
		{name: "unknown installation", err: ErrInstallationNotFound, wantStatus: http.StatusNotFound, wantCode: "SCM_INSTALLATION_NOT_FOUND"},
		{name: "provider rejected", err: ErrProviderRejected, wantStatus: http.StatusBadGateway, wantCode: "SCM_PROVIDER_REJECTED"},
		{name: "no tenant", err: tenant.ErrNoTenant, wantStatus: http.StatusBadRequest, wantCode: "SCM_REQUEST_INVALID"},
		{
			name:       "unexpected",
			err:        errors.New(`pq: duplicate key value violates unique constraint "ao_scm_installations_provider_external_installation_id_key"`),
			wantStatus: http.StatusInternalServerError,
			wantCode:   "INTERNAL_ERROR",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			link := &fakeLinkAPI{completeErr: testCase.err}
			router := mountTestRouter(t, RoutesOptions{Link: link}, &handlerIdentity)
			response := doRequest(t, router, http.MethodGet, SetupPath+"?state=abc&installation_id=55", nil)
			if response.Code != testCase.wantStatus {
				t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
			}
			var envelope errorEnvelope
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			if envelope.Code != testCase.wantCode || envelope.RequestID == "" || envelope.Error == "" {
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

func TestSetupCallbackIsReachableWithoutATenant(t *testing.T) {
	link := &fakeLinkAPI{installation: domain.SCMInstallation{ID: "installation-1", OrgID: "org-1"}}
	// identity nil: GitHub's redirect carries no AO bearer token at all.
	router := mountTestRouter(t, RoutesOptions{Link: link}, nil)
	response := doRequest(t, router, http.MethodGet, SetupPath+"?state=abc&installation_id=55", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
}

func TestInstallCallbackRedirectsToTheCompletionURL(t *testing.T) {
	link := &fakeLinkAPI{installation: domain.SCMInstallation{ID: "installation-1", OrgID: "org-1"}}
	router := mountTestRouter(t, RoutesOptions{
		Link:                 link,
		InstallCompletionURL: "https://app.example.test/settings/scm?tab=github",
	}, &handlerIdentity)

	response := doRequest(t, router, http.MethodGet, SetupPath+"?state=abc&installation_id=55", nil)
	if response.Code != http.StatusFound {
		t.Fatalf("status = %d", response.Code)
	}
	location := response.Header().Get("Location")
	if !strings.Contains(location, "tab=github") || !strings.Contains(location, "installation=installation-1") {
		t.Fatalf("location = %s", location)
	}

	link.completeErr = ErrInvalidState
	failed := doRequest(t, router, http.MethodGet, SetupPath+"?state=abc&installation_id=55", nil)
	if failed.Code != http.StatusFound {
		t.Fatalf("status = %d", failed.Code)
	}
	if !strings.Contains(failed.Header().Get("Location"), "error=SCM_INSTALL_STATE_INVALID") {
		t.Fatalf("location = %s", failed.Header().Get("Location"))
	}
}

func TestWebhookEndpointRequiresAValidSignature(t *testing.T) {
	webhook := &fakeWebhookAPI{secret: []byte("handler-secret")}
	router := mountTestRouter(t, RoutesOptions{Link: &fakeLinkAPI{}, Webhook: webhook}, &handlerIdentity)
	body := []byte(`{"action":"opened"}`)

	request := httptest.NewRequest(http.MethodPost, WebhookPath, bytes.NewReader(body))
	request.Header.Set(EventHeader, "pull_request")
	request.Header.Set(DeliveryHeader, "delivery-1")
	request.Header.Set(SignatureHeader, "sha256=00")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

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
	webhook := &fakeWebhookAPI{secret: []byte("handler-secret"), result: WebhookResult{Event: "pull_request"}}
	router := mountTestRouter(t, RoutesOptions{Link: &fakeLinkAPI{}, Webhook: webhook}, &handlerIdentity)
	body := []byte(`{"action":"opened"}`)
	mac := hmac.New(sha256.New, []byte("handler-secret"))
	mac.Write(body)
	signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	send := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, WebhookPath, bytes.NewReader(body))
		request.Header.Set(EventHeader, "pull_request")
		request.Header.Set(DeliveryHeader, "delivery-1")
		request.Header.Set(SignatureHeader, signature)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}

	if response := send(); response.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	webhook.result.Duplicate = true
	response := send()
	// A redelivery must be a success so GitHub stops retrying.
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "duplicate") {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
}

func TestWebhookEndpointIsNotMountedWithoutASecret(t *testing.T) {
	router := mountTestRouter(t, RoutesOptions{Link: &fakeLinkAPI{}}, &handlerIdentity)
	request := httptest.NewRequest(http.MethodPost, WebhookPath, strings.NewReader("{}"))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d", response.Code)
	}
}
