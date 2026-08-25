package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/domain"
	"github.com/aoagents/agent-orchestrator/cloud/internal/worker"
	"github.com/go-chi/chi/v5"
)

type browserWorkspaceStore struct {
	Store
	kind    string
	payload json.RawMessage
}

func (s *browserWorkspaceStore) CreateWorkspaceRequest(
	_ context.Context,
	_ domain.Principal,
	_ string,
	_ string,
	kind string,
	payload json.RawMessage,
	_ time.Duration,
) (domain.WorkerRequest, error) {
	s.kind = kind
	s.payload = append(json.RawMessage(nil), payload...)
	return domain.WorkerRequest{ID: "00000000-0000-0000-0000-000000000005"}, nil
}

func (s *browserWorkspaceStore) GetWorkspaceRequest(
	context.Context,
	domain.Principal,
	string,
	string,
	string,
) (domain.WorkerRequest, error) {
	response, _ := json.Marshal(worker.BrowserFetchResponse{
		URL:         "http://localhost:3000/app/index.html?theme=dark",
		Status:      http.StatusOK,
		ContentType: "text/html; charset=utf-8",
		Body:        []byte(`<!doctype html><html><head></head><body><script src="/assets/app.js"></script><p>from the VM</p></body></html>`),
	})
	return domain.WorkerRequest{Status: "succeeded", Response: response}, nil
}

func TestProxyBrowserUsesTheDurableWorkerRequestAndRewritesVMHTML(t *testing.T) {
	store := &browserWorkspaceStore{}
	server := &Server{
		store:                store,
		workerRequestTimeout: time.Second,
		logger:               slog.Default(),
	}
	origin := base64.RawURLEncoding.EncodeToString([]byte("http://localhost:3000"))
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/cloud/v1/orgs/00000000-0000-0000-0000-000000000001/sessions/00000000-0000-0000-0000-000000000002/browser/"+origin+"/app/index.html?theme=dark",
		nil,
	)
	route := chi.NewRouteContext()
	route.URLParams.Add("orgId", "00000000-0000-0000-0000-000000000001")
	route.URLParams.Add("sessionId", "00000000-0000-0000-0000-000000000002")
	route.URLParams.Add("origin", origin)
	route.URLParams.Add("*", "app/index.html")
	request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
	request = request.WithContext(context.WithValue(request.Context(), principalKey, domain.Principal{UserID: "user-1"}))
	response := httptest.NewRecorder()

	server.proxyBrowser(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if store.kind != "browser.fetch" {
		t.Fatalf("worker request kind = %q, want browser.fetch", store.kind)
	}
	var payload worker.BrowserFetchRequest
	if err := json.Unmarshal(store.payload, &payload); err != nil {
		t.Fatalf("decode worker request: %v", err)
	}
	if payload.URL != "http://localhost:3000/app/index.html?theme=dark" {
		t.Fatalf("worker URL = %q", payload.URL)
	}
	prefix := browserProxyPrefix("00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002", "http://localhost:3000")
	if response.Header().Get("Access-Control-Allow-Origin") != "null" {
		t.Fatalf("browser response did not permit the sandboxed frame: %q", response.Header().Get("Access-Control-Allow-Origin"))
	}
	if got := response.Body.String(); !containsAll(got, "from the VM", `<base href="`+prefix+`app/">`, `src="`+prefix+`assets/app.js"`) {
		t.Fatalf("browser document was not rewritten for the VM proxy: %s", got)
	}
}

func containsAll(value string, needles ...string) bool {
	for _, needle := range needles {
		if !strings.Contains(value, needle) {
			return false
		}
	}
	return true
}
