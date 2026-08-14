package controllers_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

// TestListReviewerHarnesses confirms GET /api/v1/reviewer-harnesses reuses the
// agent inventory contract (Supported/Installed/Authorized Info entries),
// filtered down to harnesses domain.ReviewerHarness also knows about.
// "prime-agent" is a real supported worker harness that is not a reviewer
// harness (see domain/reviewerharness.go's package doc on the two vocabularies
// being maintained independently), so it is the fixture proving the filter
// actually excludes non-reviewer entries rather than passing everything through.
func TestListReviewerHarnesses(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	catalog := &fakeAgentCatalog{inventory: agentsvc.Inventory{
		Supported: []agentsvc.Info{
			{ID: "claude-code", Label: "Claude Code"},
			{ID: "codex", Label: "Codex"},
			{ID: "prime-agent", Label: "Prime Agent"},
		},
		Installed: []agentsvc.Info{
			{ID: "codex", Label: "Codex"},
			{ID: "prime-agent", Label: "Prime Agent"},
		},
		Authorized: []agentsvc.Info{
			{ID: "codex", Label: "Codex"},
		},
	}}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Agents: catalog,
	}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)

	body, status, headers := doRequest(t, srv, http.MethodGet, "/api/v1/reviewer-harnesses", "")
	if status != http.StatusOK {
		t.Fatalf("GET /reviewer-harnesses = %d, want 200; body=%s", status, body)
	}
	assertJSON(t, headers)

	var resp controllers.ListReviewerHarnessesResponse
	mustJSON(t, body, &resp)

	if len(resp.Supported) != 2 {
		t.Fatalf("supported = %v, want exactly claude-code and codex (prime-agent excluded)", resp.Supported)
	}
	for _, want := range []string{"claude-code", "codex"} {
		if !containsInfo(resp.Supported, want) {
			t.Errorf("supported missing %q: %v", want, resp.Supported)
		}
	}
	if containsInfo(resp.Supported, "prime-agent") {
		t.Fatalf("supported includes non-reviewer harness prime-agent: %v", resp.Supported)
	}

	if len(resp.Installed) != 1 || !containsInfo(resp.Installed, "codex") {
		t.Fatalf("installed = %v, want exactly codex (prime-agent excluded)", resp.Installed)
	}
	if len(resp.Authorized) != 1 || !containsInfo(resp.Authorized, "codex") {
		t.Fatalf("authorized = %v, want exactly codex", resp.Authorized)
	}

	if catalog.listCalls != 1 || catalog.refreshCalls != 0 {
		t.Fatalf("calls: list=%d refresh=%d, want list=1 refresh=0", catalog.listCalls, catalog.refreshCalls)
	}
}

func containsInfo(infos []agentsvc.Info, id string) bool {
	for _, info := range infos {
		if info.ID == id {
			return true
		}
	}
	return false
}

func TestListReviewerHarnessesWithoutCatalogReturnsNotImplemented(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/reviewer-harnesses", "")
	if status != http.StatusNotImplemented {
		t.Fatalf("GET without catalog = %d, want 501; body=%s", status, body)
	}
	if !strings.Contains(string(body), `"error"`) {
		t.Fatalf("body = %s, want API error envelope", body)
	}
}
