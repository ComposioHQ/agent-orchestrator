package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// tenantSpyCatalog stands in for one of the cloud-composed storage ports. It
// records the tenant identity the request context carried when a controller
// called it, which is how the hosted plane's stores will read their scope.
type tenantSpyCatalog struct {
	mu     sync.Mutex
	calls  int
	seen   tenant.Identity
	scoped bool
}

func (c *tenantSpyCatalog) List(ctx context.Context) (agentsvc.Inventory, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	c.seen, c.scoped = tenant.FromContext(ctx)
	return agentsvc.Inventory{}, nil
}

func (c *tenantSpyCatalog) Refresh(context.Context) (agentsvc.Inventory, error) {
	return agentsvc.Inventory{}, nil
}

func (c *tenantSpyCatalog) Probe(context.Context, string) (agentsvc.ProbeResult, error) {
	return agentsvc.ProbeResult{}, nil
}

func (c *tenantSpyCatalog) Models(context.Context, string, string, bool) (ports.AgentModelCatalog, error) {
	return ports.AgentModelCatalog{}, nil
}

func (c *tenantSpyCatalog) RevalidateModels(context.Context, string, string) (ports.AgentModelCatalog, error) {
	return ports.AgentModelCatalog{}, nil
}

func (c *tenantSpyCatalog) snapshot() (int, tenant.Identity, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls, c.seen, c.scoped
}

const (
	orgOneID   = "0d0f7f24-4bd4-4a1a-8d3c-3a02f3d3d001"
	orgOneSlug = "acme"
	orgTwoID   = "0d0f7f24-4bd4-4a1a-8d3c-3a02f3d3d002"
)

// newAppServer builds a control plane whose App is the real shared
// application API, composed with a tenant-recording catalog port.
func newAppServer(t *testing.T, memberships []domain.Membership) (*Server, *memoryAccountStore, *tenantSpyCatalog) {
	t.Helper()
	principal := domain.Principal{
		UserID:      "58fc7182-0360-412f-abd9-5057097db664",
		Provider:    "google",
		ExternalID:  "google-subject",
		Email:       "person@example.com",
		DisplayName: "Person Example",
	}
	store := &memoryAccountStore{
		principal:   principal,
		memberships: memberships,
		refreshes:   make(map[string]string),
	}
	catalog := &tenantSpyCatalog{}
	app := httpd.NewCloudAPIHandler(
		config.Config{DataDir: t.TempDir()},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		httpd.APIDeps{Agents: catalog},
	)
	server := newTestServerWithApp(t, store, &staticIdentityVerifier{principal: principal}, app)
	return server, store, catalog
}

func oneMembership() []domain.Membership {
	return []domain.Membership{{OrgID: orgOneID, OrgSlug: orgOneSlug, DisplayName: "Acme", Role: "owner"}}
}

// An unauthenticated request must never reach a controller: the stores behind
// the shared API are multi-tenant, and a request with no principal has no
// tenant scope to run under.
func TestAppMountRejectsUnauthenticatedRequests(t *testing.T) {
	server, _, catalog := newAppServer(t, oneMembership())

	for name, req := range map[string]*http.Request{
		"no header":    httptest.NewRequest(http.MethodGet, "/api/v1/agents", nil),
		"malformed":    requestWithAuth(http.MethodGet, "/api/v1/agents", "not-a-bearer-token"),
		"bogus bearer": requestWithAuth(http.MethodGet, "/api/v1/agents", "Bearer not-a-real-token"),
		"empty bearer": requestWithAuth(http.MethodGet, "/api/v1/agents", "Bearer "),
		"wrong scheme": requestWithAuth(http.MethodGet, "/api/v1/agents", "Basic abcdef"),
	} {
		t.Run(name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			server.Handler().ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 (body %s)", rec.Code, rec.Body.String())
			}
		})
	}

	if calls, _, _ := catalog.snapshot(); calls != 0 {
		t.Fatalf("unauthenticated requests reached the application API %d times", calls)
	}
}

// The happy path: an authenticated request reaches the real controller with a
// tenant identity on its context, which is where the cloud stores read scope.
func TestAppMountPropagatesTenantContext(t *testing.T) {
	server, _, catalog := newAppServer(t, oneMembership())
	token := accessTokenFor(t, server)

	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, requestWithAuth(http.MethodGet, "/api/v1/agents", "Bearer "+token))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	calls, seen, scoped := catalog.snapshot()
	if calls != 1 {
		t.Fatalf("catalog calls = %d, want 1", calls)
	}
	if !scoped {
		t.Fatal("controller ran with no tenant identity on its context")
	}
	if seen.OrgID != orgOneID {
		t.Errorf("OrgID = %q, want %q", seen.OrgID, orgOneID)
	}
	if seen.UserID != "58fc7182-0360-412f-abd9-5057097db664" {
		t.Errorf("UserID = %q, want the authenticated principal", seen.UserID)
	}
	if seen.Role != "owner" {
		t.Errorf("Role = %q, want owner", seen.Role)
	}
}

// Naming an organization the principal does not belong to is the cross-tenant
// case. It must be refused before any controller runs, whether the caller
// names the org by id or by slug.
func TestAppMountRejectsCrossTenantRequests(t *testing.T) {
	server, _, catalog := newAppServer(t, oneMembership())
	token := accessTokenFor(t, server)

	for name, org := range map[string]string{
		"other org id":   orgTwoID,
		"other org slug": "someone-elses-org",
	} {
		t.Run(name, func(t *testing.T) {
			req := requestWithAuth(http.MethodGet, "/api/v1/agents", "Bearer "+token)
			req.Header.Set(orgHeader, org)
			rec := httptest.NewRecorder()
			server.Handler().ServeHTTP(rec, req)

			if rec.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403 (body %s)", rec.Code, rec.Body.String())
			}
			if code := errorCode(t, rec); code != "ORG_FORBIDDEN" {
				t.Fatalf("code = %q, want ORG_FORBIDDEN", code)
			}
		})
	}

	if calls, _, _ := catalog.snapshot(); calls != 0 {
		t.Fatalf("cross-tenant requests reached the application API %d times", calls)
	}
}

// A member of several organizations must say which one; guessing would write
// into the wrong tenant. Naming one they do belong to resolves to that org.
func TestAppMountRequiresAnOrgWhenAmbiguous(t *testing.T) {
	memberships := []domain.Membership{
		{OrgID: orgOneID, OrgSlug: orgOneSlug, Role: "owner"},
		{OrgID: orgTwoID, OrgSlug: "globex", Role: "member"},
	}
	server, _, catalog := newAppServer(t, memberships)
	token := accessTokenFor(t, server)

	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, requestWithAuth(http.MethodGet, "/api/v1/agents", "Bearer "+token))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
	}
	if code := errorCode(t, rec); code != "ORG_REQUIRED" {
		t.Fatalf("code = %q, want ORG_REQUIRED", code)
	}
	if calls, _, _ := catalog.snapshot(); calls != 0 {
		t.Fatalf("ambiguous request reached the application API %d times", calls)
	}

	req := requestWithAuth(http.MethodGet, "/api/v1/agents", "Bearer "+token)
	req.Header.Set(orgHeader, "globex")
	rec = httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if _, seen, _ := catalog.snapshot(); seen.OrgID != orgTwoID {
		t.Fatalf("OrgID = %q, want the named org %q", seen.OrgID, orgTwoID)
	}
}

// An account with no organization has nothing to act on.
func TestAppMountRejectsPrincipalWithNoMembership(t *testing.T) {
	server, _, catalog := newAppServer(t, nil)
	token := accessTokenFor(t, server)

	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, requestWithAuth(http.MethodGet, "/api/v1/agents", "Bearer "+token))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", rec.Code, rec.Body.String())
	}
	if code := errorCode(t, rec); code != "NO_ORG_MEMBERSHIP" {
		t.Fatalf("code = %q, want NO_ORG_MEMBERSHIP", code)
	}
	if calls, _, _ := catalog.snapshot(); calls != 0 {
		t.Fatalf("membership-less request reached the application API %d times", calls)
	}
}

// The route classification holds on the real mount, not just in httpd's own
// tests: an authenticated, correctly scoped request to a local-only route is
// still refused.
func TestAppMountRefusesLocalOnlyRoutes(t *testing.T) {
	server, _, _ := newAppServer(t, oneMembership())
	token := accessTokenFor(t, server)

	for _, path := range []string{
		"/api/v1/shell-terminals",
		"/api/v1/browser/status",
		"/api/v1/usage/sessions",
		"/api/v1/sessions/probe-id/workspace/files",
	} {
		rec := httptest.NewRecorder()
		server.Handler().ServeHTTP(rec, requestWithAuth(http.MethodGet, path, "Bearer "+token))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404 (body %s)", path, rec.Code, rec.Body.String())
		}
	}
}

// The auth foundation keeps its own routes when an app is mounted alongside.
func TestAppMountLeavesControlPlaneRoutesIntact(t *testing.T) {
	server, _, _ := newAppServer(t, oneMembership())

	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/healthz = %d, want 200", rec.Code)
	}

	rec = httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, requestWithAuth(http.MethodGet, "/api/cloud/v1/me", "Bearer "+accessTokenFor(t, server)))
	if rec.Code != http.StatusOK {
		t.Fatalf("/api/cloud/v1/me = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

func requestWithAuth(method, path, authorization string) *http.Request {
	req := httptest.NewRequest(method, path, nil)
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	return req
}

func accessTokenFor(t *testing.T, server *Server) string {
	t.Helper()
	token, _, err := server.accessTokens.Issue(server.store.(*memoryAccountStore).principal.UserID)
	if err != nil {
		t.Fatalf("issue access token: %v", err)
	}
	return token
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var envelope struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode error envelope %q: %v", rec.Body.String(), err)
	}
	return envelope.Code
}
